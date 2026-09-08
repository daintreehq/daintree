import { createHash } from "node:crypto";
import type {
  ForgeTokenHealthState,
  ForgeTokenHealthStatus,
} from "../../../../shared/types/forge.js";

/** Timeout for auth-path requests (`/user`, token introspection). */
export const GITLAB_AUTH_TIMEOUT_MS = 10_000;

/** Timeout for regular API requests. */
export const GITLAB_API_TIMEOUT_MS = 15_000;

const DEFAULT_INSTANCE_URL = "https://gitlab.com";

/** Minimum spacing between unforced token-health probes. */
const HEALTH_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;

type InstanceUrlReader = () => Promise<string | undefined>;

interface ValidatedUserInfo {
  username: string;
  avatarUrl?: string;
  scopes?: string[];
}

/**
 * In-memory auth state for the GitLab provider. The durable credential lives
 * in the host's `forgeCredentials` store — the host replays it into
 * `setCredentials` when the impl binds and on every save — so this module
 * never persists the token itself. The instance URL is a plugin setting
 * (`instanceUrl`), read through an accessor injected at `activate()` so this
 * module stays import-safe in tests.
 */
let memoryToken: string | null = null;
let tokenVersion = 0;
let validatedUser: ValidatedUserInfo | null = null;
let validatedUserVersion = -1;
let instanceUrlReader: InstanceUrlReader | null = null;
let cachedInstanceUrl: string | null = null;
/**
 * Normalized base URL the in-memory token is bound to — the configured
 * instance at the moment the host handed the credential over. A token issued
 * by instance A is never a valid credential for instance B, so changing
 * `instanceUrl` without re-saving must withhold it rather than replay it at
 * the new origin. The whole base, not just the hostname: the same host on a
 * different port or deployment path is a different installation.
 */
let tokenInstanceUrl: string | null = null;

let healthState: ForgeTokenHealthState = { status: "unknown", tokenVersion: 0, checkedAt: 0 };
const healthListeners = new Set<(state: ForgeTokenHealthState) => void>();
let lastHealthProbeAt = 0;

export function setInstanceUrlReader(reader: InstanceUrlReader | null): void {
  instanceUrlReader = reader;
}

/**
 * Durable record of which instance the stored credential was saved for.
 *
 * The host's credential store holds a bare token with no instance, so on a
 * replay (every activation, and every plugin re-enable) the provider has no
 * way to tell "the token the user saved for this instance" from "a token they
 * saved for a different one before repointing `instanceUrl`". Deriving
 * provenance from the current setting is exactly how instance A's token ends
 * up at instance B.
 *
 * The token itself is NEVER written here — plugin storage is plaintext JSON.
 * Only a digest, which is enough to tell a replay of the same credential from
 * a genuinely new one.
 */
export interface CredentialProvenance {
  instanceUrl: string;
  tokenDigest: string;
}

type ProvenanceReader = () => CredentialProvenance | null;
type ProvenanceWriter = (record: CredentialProvenance | null) => void;

let provenanceReader: ProvenanceReader | null = null;
let provenanceWriter: ProvenanceWriter | null = null;

/**
 * Instances that candidate tokens were proven against, keyed by token digest.
 * The host's save path is `validateToken(token)` then `setCredentials(token)`,
 * so this carries the validation's own resolved destination across to the save
 * instead of letting it re-derive one from settings that may have changed in
 * between.
 *
 * A map rather than one slot: a background probe of the OLD token, or a second
 * candidate validation, would otherwise evict the record for the token being
 * saved — and the save would then find no provenance and bind to null, leaving
 * the user with a credential the UI calls saved and every request omits.
 *
 * Entries expire by AGE, never by count. A capacity limit has the same defect
 * as the single slot it replaced, just further away: enough other validations
 * while one is still in introspection and the live entry is the one dropped.
 * A save follows its validation within milliseconds, so the window only has to
 * outlive that; the host rate-limits the write path, which bounds the map.
 */
const provenValidations = new Map<string, { instanceUrl: string; at: number }>();
const PROVEN_VALIDATION_TTL_MS = 5 * 60 * 1000;

function recordProvenValidation(tokenDigest: string, instanceUrl: string): void {
  const now = Date.now();
  for (const [digest, entry] of provenValidations) {
    if (now - entry.at > PROVEN_VALIDATION_TTL_MS) provenValidations.delete(digest);
  }
  provenValidations.set(tokenDigest, { instanceUrl, at: now });
}

function provenInstanceFor(tokenDigest: string): string | undefined {
  const entry = provenValidations.get(tokenDigest);
  if (!entry) return undefined;
  if (Date.now() - entry.at > PROVEN_VALIDATION_TTL_MS) {
    provenValidations.delete(tokenDigest);
    return undefined;
  }
  return entry.instanceUrl;
}

/**
 * Wire the durable provenance accessors. `activate()` loads the record before
 * the provider is registered, so the synchronous reader is populated by the
 * time the host replays the credential into `setCredentials`.
 */
export function setProvenanceAccessors(
  reader: ProvenanceReader | null,
  writer: ProvenanceWriter | null
): void {
  provenanceReader = reader;
  provenanceWriter = writer;
}

/** Non-reversible digest of a token — never the token itself. */
export function digestToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function normalizeInstanceUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * Read the configured instance base URL. Returns `undefined` when the setting
 * is unset or blank (a fresh install — the gitlab.com default applies) and
 * THROWS when the settings read itself failed, so security-sensitive callers
 * ({@link getInstanceHostStrict}) can fail closed instead of silently
 * treating a broken read as "gitlab.com".
 */
async function readConfiguredInstanceUrl(): Promise<string | undefined> {
  const raw = await instanceUrlReader?.();
  if (typeof raw === "string" && raw.trim().length > 0) {
    const normalized = normalizeInstanceUrl(raw);
    cachedInstanceUrl = normalized;
    return normalized;
  }
  cachedInstanceUrl = DEFAULT_INSTANCE_URL;
  return undefined;
}

/**
 * Last successfully-read instance base URL, for the synchronous URL builders
 * (`buildIssueUrl` and friends are sync in the contract, so they cannot await
 * the setting). Null until the first successful read — callers fall back to
 * plain `https://<host>`, which is correct for gitlab.com and for any
 * hostname-matched public instance.
 */
export function getCachedInstanceUrl(): string | null {
  return cachedInstanceUrl;
}

/**
 * Resolve the configured instance base URL for display and URL building.
 * Falls back to gitlab.com when the setting is unset or unreadable — callers
 * that gate credential attachment must use {@link getInstanceHostStrict}
 * instead, which does not substitute a different origin on failure.
 */
export async function getInstanceUrl(): Promise<string> {
  try {
    return (await readConfiguredInstanceUrl()) ?? DEFAULT_INSTANCE_URL;
  } catch {
    return DEFAULT_INSTANCE_URL;
  }
}

/** Hostname of the configured instance, lowercased. Never throws. */
export async function getInstanceHost(): Promise<string> {
  const url = await getInstanceUrl();
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "gitlab.com";
  }
}

/**
 * Hostname of the configured instance for credential-attachment decisions.
 * Unlike {@link getInstanceHost} this THROWS when the settings read failed or
 * the stored value is unparsable — the caller must then withhold the token
 * rather than fall back to a default origin the token was never scoped to.
 */
export async function getInstanceHostStrict(): Promise<string> {
  return new URL(await getInstanceUrlStrict()).hostname.toLowerCase();
}

/**
 * Configured instance base URL for credential-bearing requests. Unlike
 * {@link getInstanceUrl} this THROWS when the settings read failed, so a
 * broken read can never redirect a self-hosted token to gitlab.com.
 */
export async function getInstanceUrlStrict(): Promise<string> {
  const configured = await readConfiguredInstanceUrl();
  return configured ?? DEFAULT_INSTANCE_URL;
}

/**
 * Where a token belongs — the instance it was PROVEN against, never the one
 * that happens to be configured when it arrives.
 *
 * Two sources, in order:
 *
 * 1. A just-completed validation of this exact token. The host validates
 *    through this provider immediately before persisting (`validateToken` then
 *    `setCredentials`), so a matching record is proof the user explicitly
 *    supplied this token for that instance — including a deliberate re-save of
 *    the same token against a new one. It resolved the instance itself, so a
 *    settings change racing the validation can't retarget it.
 * 2. The durable record from a previous save, which is what a replay is.
 *
 * Neither means the provenance is unknown, and the binding is null. That is
 * deliberately fail-closed: an absent record is NOT evidence of a new save —
 * it is equally a replay whose record was lost — and adopting the current
 * setting there is exactly how a repointed instance claims a token it was
 * never issued.
 */
function resolveBinding(token: string): string | null {
  const digest = digestToken(token);
  const proven = provenInstanceFor(digest);
  if (proven !== undefined) {
    provenanceWriter?.({ instanceUrl: proven, tokenDigest: digest });
    return proven;
  }
  const recorded = provenanceReader?.() ?? null;
  if (recorded && recorded.tokenDigest === digest) return recorded.instanceUrl;
  return null;
}

export function getToken(): string | null {
  return memoryToken;
}

/**
 * Normalized base URL the in-memory token was bound to, or null when the
 * binding could not be established (the settings read failed, in which case
 * every credential-attachment path already fails closed).
 */
export function getTokenInstanceUrl(): string | null {
  return tokenInstanceUrl;
}

/**
 * Whether the in-memory token may be used against `instanceUrl` — the base the
 * caller resolved and is about to send to, not a second read of the setting.
 *
 * Fails closed on an unknown binding. That only happens when the settings read
 * failed outright, and in that state every attachment path already withholds
 * the token; adopting "whatever is configured now" would let a repointed
 * setting silently claim a credential it was never issued.
 */
export function tokenMatchesInstance(instanceUrl: string): boolean {
  if (tokenInstanceUrl === null) return false;
  return tokenInstanceUrl === instanceUrl;
}

export function getTokenVersion(): number {
  return tokenVersion;
}

/**
 * Replace the in-memory token. Bumps the version so late-resolving
 * validations against the old token can't stamp user info onto the new one,
 * resets health to `unknown` (the new token has no probe history), and drops
 * the probe cooldown so the next health refresh isn't blocked by the previous
 * token's schedule.
 */
export function setMemoryToken(token: string | null, instanceUrl?: string | null): void {
  const next = token && token.trim().length > 0 ? token.trim() : null;
  // Unconditional: a clear that arrives while the in-memory token is already
  // null (the plugin was disabled when the user cleared it) must still drop
  // the durable record, or a later replay would resurrect its provenance.
  if (next === null) {
    provenanceWriter?.(null);
    provenValidations.clear();
  }
  const nextUrl = next === null ? null : (instanceUrl ?? resolveBinding(next));
  if (next === memoryToken && nextUrl === tokenInstanceUrl) return;
  memoryToken = next;
  tokenInstanceUrl = nextUrl;
  tokenVersion += 1;
  validatedUser = null;
  validatedUserVersion = -1;
  lastHealthProbeAt = 0;
  setHealth("unknown");
}

export function setValidatedUserInfo(
  info: ValidatedUserInfo,
  versionAtStart: number,
  identityGenerationAtStart?: number
): void {
  if (versionAtStart !== tokenVersion) return;
  if (identityGenerationAtStart !== undefined && identityGenerationAtStart !== identityGeneration) {
    return;
  }
  validatedUser = info;
  validatedUserVersion = versionAtStart;
}

/** Drop the cached identity — it describes an account on a different instance. */
export function clearValidatedUserInfo(): void {
  identityGeneration += 1;
  validatedUser = null;
  validatedUserVersion = -1;
}

/**
 * Bumped whenever the cached identity is dropped. `tokenVersion` doesn't move
 * when only the INSTANCE changed, so without this a `/user` lookup already in
 * flight against the old instance would resolve afterwards and repopulate the
 * identity of an account on a server we're no longer talking to.
 */
let identityGeneration = 0;

/** Snapshot before an identity lookup; hand back to {@link setValidatedUserInfo}. */
export function currentIdentityGeneration(): number {
  return identityGeneration;
}

export function getValidatedUserInfo(): ValidatedUserInfo | null {
  return validatedUserVersion === tokenVersion ? validatedUser : null;
}

/** Always re-stamps `checkedAt`; listeners fire only on a status/version change. */
function setHealth(status: ForgeTokenHealthStatus): void {
  const changed = healthState.status !== status || healthState.tokenVersion !== tokenVersion;
  healthState = { status, tokenVersion, checkedAt: Date.now() };
  if (!changed) return;
  for (const listener of [...healthListeners]) {
    try {
      listener(healthState);
    } catch {
      // A throwing listener must not break the others.
    }
  }
}

export function getTokenHealth(): ForgeTokenHealthState {
  return healthState;
}

export function onTokenHealthChanged(listener: (state: ForgeTokenHealthState) => void): () => void {
  healthListeners.add(listener);
  return () => {
    healthListeners.delete(listener);
  };
}

/**
 * Record an authoritative auth success against the current token. Pass the
 * token version captured when the request was SENT so a late response for a
 * rotated-away token can't stamp the new one.
 */
export function markTokenHealthy(versionAtRequest?: number): void {
  if (!memoryToken) return;
  if (versionAtRequest !== undefined && versionAtRequest !== tokenVersion) return;
  setHealth("healthy");
}

/**
 * Record an authoritative credential rejection (401 on an authenticated
 * request). Transient network failures must never call this. Same version
 * guard as {@link markTokenHealthy}.
 */
export function markTokenUnhealthy(versionAtRequest?: number): void {
  if (!memoryToken) return;
  if (versionAtRequest !== undefined && versionAtRequest !== tokenVersion) return;
  setHealth("unhealthy");
}

/**
 * Re-probe credential health via `/user`. Applies a cooldown unless forced so
 * focus-regain bursts can't hammer the API. No-op without a token. Only a
 * definitive 401 flips to `unhealthy` — a 403 (scope/policy) or network
 * failure keeps the previous state.
 */
export async function refreshTokenHealth(options?: { force?: boolean }): Promise<void> {
  const token = memoryToken;
  if (!token) return;
  const now = Date.now();
  if (!options?.force && now - lastHealthProbeAt < HEALTH_REFRESH_COOLDOWN_MS) return;
  lastHealthProbeAt = now;
  const versionAtStart = tokenVersion;
  try {
    const result = await validateStoredGitLabToken(token);
    if (versionAtStart !== tokenVersion) return;
    if (result.valid) {
      markTokenHealthy(versionAtStart);
    } else if (result.credentialRejected) {
      markTokenUnhealthy(versionAtStart);
    }
  } catch {
    // Network failure — keep the previous state.
  }
}

/** Test-isolation helper: reset every module-level auth state. */
export function resetAuthStateForTests(): void {
  identityGeneration += 1;
  memoryToken = null;
  tokenInstanceUrl = null;
  cachedInstanceUrl = null;
  provenValidations.clear();
  tokenVersion += 1;
  validatedUser = null;
  validatedUserVersion = -1;
  lastHealthProbeAt = 0;
  healthListeners.clear();
  healthState = { status: "unknown", tokenVersion, checkedAt: 0 };
}

export interface GitLabTokenValidationResult {
  valid: boolean;
  /** `true` when GitLab itself answered (2xx or 401/403), not the network. */
  authoritative: boolean;
  /** `true` only for a definitive 401 — the signal that flips token health. */
  credentialRejected: boolean;
  username?: string;
  avatarUrl?: string;
  scopes?: string[];
  /** Epoch ms; `null` = confirmed non-expiring; absent = expiry unknown. */
  expiresAt?: number | null;
  error?: string;
}

/**
 * Validate a token against the configured instance's `/user` endpoint, then
 * best-effort enrich with scopes/expiry from `/personal_access_tokens/self`
 * (PAT-only introspection — OAuth tokens 404 there, which is fine; expiry
 * stays unknown rather than "never expires" when introspection is
 * unavailable).
 */
/**
 * Validate the STORED token — the health probe, `validateCredentials`, and the
 * cached-identity refresh. Unlike {@link validateGitLabToken}, which validates
 * a token the user just typed for the instance on screen, this must not send a
 * credential to an instance it wasn't issued for: after an `instanceUrl`
 * change the stored token still belongs to the old one.
 */
export async function validateStoredGitLabToken(
  token: string
): Promise<GitLabTokenValidationResult> {
  const unavailable = (error: string): GitLabTokenValidationResult => ({
    valid: false,
    authoritative: false,
    credentialRejected: false,
    error,
  });
  let instanceUrl: string;
  try {
    instanceUrl = await getInstanceUrlStrict();
  } catch {
    return unavailable("Couldn't read the GitLab instance setting — reopen this tab and try again");
  }
  // The binding describes the CURRENT stored token, so a caller holding one
  // captured before a rotation must not borrow its verdict.
  if (token !== memoryToken || !tokenMatchesInstance(instanceUrl)) {
    return unavailable(
      "The stored token belongs to a different GitLab instance — enter one for this instance"
    );
  }
  // Hand the resolved destination through, so the check above and the request
  // below cannot disagree about where the token is going.
  return validateGitLabToken(token, instanceUrl, false);
}

export async function validateGitLabToken(
  token: string,
  resolvedInstanceUrl?: string,
  // Stored-token probes pass false: they re-check a credential whose
  // provenance is already established.
  recordProvenance = true
): Promise<GitLabTokenValidationResult> {
  let instanceUrl: string;
  if (resolvedInstanceUrl !== undefined) {
    instanceUrl = resolvedInstanceUrl;
  } else {
    try {
      // Strict: a failed settings read must not send a self-hosted token to
      // gitlab.com just because that is the display-time default.
      instanceUrl = await getInstanceUrlStrict();
    } catch {
      return {
        valid: false,
        authoritative: false,
        credentialRejected: false,
        error: "Couldn't read the GitLab instance setting — reopen this tab and try again",
      };
    }
  }
  const instanceHost = (() => {
    try {
      return new URL(instanceUrl).hostname;
    } catch {
      return instanceUrl;
    }
  })();

  let response: Response;
  try {
    response = await fetch(`${instanceUrl}/api/v4/user`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(GITLAB_AUTH_TIMEOUT_MS),
    });
  } catch {
    return {
      valid: false,
      authoritative: false,
      credentialRejected: false,
      error: `Couldn't reach ${instanceHost} — check the instance URL and your network`,
    };
  }

  if (response.status === 401) {
    return {
      valid: false,
      authoritative: true,
      credentialRejected: true,
      error: "GitLab rejected the token (401)",
    };
  }
  if (response.status === 403) {
    return {
      valid: false,
      authoritative: true,
      credentialRejected: false,
      error: "Token lacks API access (403) — it needs the api or read_api scope",
    };
  }
  if (!response.ok) {
    return {
      valid: false,
      authoritative: false,
      credentialRejected: false,
      error: `${instanceHost} answered ${response.status} — is this a GitLab instance?`,
    };
  }

  // An SSO gateway or captive portal can 200 with an HTML page; require JSON
  // before trusting the payload.
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return {
      valid: false,
      authoritative: false,
      credentialRejected: false,
      error: `${instanceHost} didn't answer with JSON — is this a GitLab instance?`,
    };
  }

  let user: { username?: unknown; avatar_url?: unknown };
  try {
    user = (await response.json()) as { username?: unknown; avatar_url?: unknown };
  } catch {
    return {
      valid: false,
      authoritative: false,
      credentialRejected: false,
      error: "GitLab returned an unreadable response",
    };
  }
  if (typeof user.username !== "string" || user.username.length === 0) {
    return {
      valid: false,
      authoritative: false,
      credentialRejected: false,
      error: "GitLab returned no user for the token",
    };
  }

  // Only when the caller is validating a CANDIDATE token: that is the save
  // path, and the destination it reached is what the save must bind to. A
  // stored-token probe is re-checking an already-bound credential and proves
  // nothing new — letting it write here would let a slow probe of the OLD
  // token stand in for the new one's provenance.
  if (recordProvenance) {
    recordProvenValidation(digestToken(token), instanceUrl);
  }

  const result: GitLabTokenValidationResult = {
    valid: true,
    authoritative: true,
    credentialRejected: false,
    username: user.username,
    ...(typeof user.avatar_url === "string" && user.avatar_url.length > 0
      ? { avatarUrl: user.avatar_url }
      : {}),
  };

  try {
    const introspection = await fetch(`${instanceUrl}/api/v4/personal_access_tokens/self`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(GITLAB_AUTH_TIMEOUT_MS),
    });
    if (introspection.ok) {
      const data = (await introspection.json()) as {
        scopes?: unknown;
        expires_at?: unknown;
      };
      if (Array.isArray(data.scopes)) {
        const scopes = data.scopes.filter((s): s is string => typeof s === "string");
        result.scopes = scopes;
        // Introspection is the only place scopes are knowable, so it is also
        // the only place an under-scoped token can be caught. `/user` answers
        // for a bare `read_user` token, which cannot read a single project —
        // accepting it would connect the provider and then 403 on every read.
        if (!scopes.includes("api") && !scopes.includes("read_api")) {
          return {
            valid: false,
            authoritative: true,
            credentialRejected: false,
            error: `Token lacks API access — it has ${scopes.join(", ") || "no scopes"}, and needs api or read_api`,
          };
        }
      }
      if (typeof data.expires_at === "string") {
        const t = Date.parse(data.expires_at);
        if (Number.isFinite(t)) result.expiresAt = t;
      } else if (data.expires_at === null) {
        result.expiresAt = null;
      }
    }
  } catch {
    // Introspection is best-effort — OAuth tokens and older instances 404 here.
  }

  return result;
}
