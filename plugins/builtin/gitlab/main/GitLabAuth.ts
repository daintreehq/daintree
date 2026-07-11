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

let healthState: ForgeTokenHealthState = { status: "unknown", tokenVersion: 0, checkedAt: 0 };
const healthListeners = new Set<(state: ForgeTokenHealthState) => void>();
let lastHealthProbeAt = 0;

export function setInstanceUrlReader(reader: InstanceUrlReader | null): void {
  instanceUrlReader = reader;
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
    return normalizeInstanceUrl(raw);
  }
  return undefined;
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
  const configured = await readConfiguredInstanceUrl();
  if (configured === undefined) {
    return "gitlab.com";
  }
  return new URL(configured).hostname.toLowerCase();
}

export function getToken(): string | null {
  return memoryToken;
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
export function setMemoryToken(token: string | null): void {
  const next = token && token.trim().length > 0 ? token.trim() : null;
  if (next === memoryToken) return;
  memoryToken = next;
  tokenVersion += 1;
  validatedUser = null;
  validatedUserVersion = -1;
  lastHealthProbeAt = 0;
  setHealth("unknown");
}

export function setValidatedUserInfo(info: ValidatedUserInfo, versionAtStart: number): void {
  if (versionAtStart !== tokenVersion) return;
  validatedUser = info;
  validatedUserVersion = versionAtStart;
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
    const result = await validateGitLabToken(token);
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
  memoryToken = null;
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
export async function validateGitLabToken(token: string): Promise<GitLabTokenValidationResult> {
  const instanceUrl = await getInstanceUrl();
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
        result.scopes = data.scopes.filter((s): s is string => typeof s === "string");
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
