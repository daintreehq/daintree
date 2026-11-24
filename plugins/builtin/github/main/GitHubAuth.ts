import { graphql } from "@octokit/graphql";
import { GitHubRateLimitError, rateLimitServiceForHost } from "./GitHubRateLimitService.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
import {
  GITHUB_COM_HOST,
  apiHostOf,
  githubApiBase,
  githubGraphqlBase,
  isApiUrlFor,
  isServedGitHubHost,
} from "./GitHubHost.js";

export const GITHUB_API_TIMEOUT_MS = 15_000;
export const GITHUB_AUTH_TIMEOUT_MS = 10_000;

/**
 * Process-wide ceiling on concurrent GitHub API requests passing through
 * {@link rateLimitAwareFetch}. GitHub's secondary rate limit kicks in at
 * 100 concurrent requests per token; capping at 8 keeps us well clear even
 * across multiple processes that share the same token.
 */
export const GITHUB_FETCH_CONCURRENCY = 8;

/**
 * SSO re-authorization URLs returned via `X-GitHub-SSO` expire one hour
 * after issuance. Expose a bounded window so stale URLs aren't surfaced
 * to the renderer.
 */
const SSO_URL_TTL_MS = 60 * 60 * 1000;

export interface GitHubAuthMetadata {
  /** Re-authorization URL extracted from `X-GitHub-SSO: required; url=...` */
  ssoUrl?: string;
  /** Wall-clock ms at which the SSO URL was observed (for TTL enforcement) */
  ssoCapturedAt?: number;
  /** Expiry date parsed from `GitHub-Authentication-Token-Expiration`, or null */
  tokenExpiresAt?: Date | null;
}

let lastAuthMetadata: GitHubAuthMetadata | null = null;

function clearAuthMetadata(): void {
  lastAuthMetadata = null;
}

/**
 * Parse the `X-GitHub-SSO` header. GitHub emits two shapes:
 *   - `required; url=https://github.com/orgs/<org>/sso?authorization_request=<id>`
 *   - `partial-results; organizations=<csv>`
 * Only the first form carries a re-auth URL; return it when present.
 *
 * Validates that the URL is HTTPS and hosted on `github.com` (or a
 * subdomain) — a spoofed `api.github.com` response could otherwise
 * inject a phishing URL into the error message shown to the user.
 */
export function parseSsoHeader(headerValue: string | null): string | null {
  if (!headerValue) return null;
  const match = /url=(\S+)/.exec(headerValue);
  if (!match) return null;
  const url = match[1];
  if (!url || !url.startsWith("https://")) return null;
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    if (hostname !== "github.com" && !hostname.endsWith(".github.com")) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

export type SsoHeaderKind = "required" | "partial";

/**
 * Discriminate the form of an `X-GitHub-SSO` header.
 *
 * - `required` — the token must be re-authorized against the targeted org
 *   before this request can succeed. A companion `url=` is usually present
 *   and surfaced via {@link parseSsoHeader}.
 * - `partial-results` — the token is fine globally; one or more named orgs
 *   refused per-org SSO authorization, so the response carries partial data.
 *   Treating this as a globally invalid token misclassifies a per-org
 *   restriction as a token failure.
 *
 * Classification only — URL extraction and security validation remain in
 * {@link parseSsoHeader} so callers that need a clickable URL go through
 * the same hostname checks.
 */
export function parseSsoKind(headerValue: string | null): SsoHeaderKind | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim().toLowerCase();
  if (trimmed.startsWith("partial-results")) return "partial";
  if (trimmed.startsWith("required")) return "required";
  return null;
}

function parseTokenExpirationHeader(headerValue: string | null): Date | null {
  if (!headerValue) return null;
  const ms = Date.parse(headerValue);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms);
}

/**
 * Capture passive auth metadata from a GitHub response. Safe to call on every
 * response — no-ops when headers are absent. Kept module-level so the fetch
 * wrapper can feed it without introducing a circular dependency on the
 * {@link GitHubAuth} class.
 */
export function captureAuthMetadata(headers: { get(name: string): string | null }): void {
  const ssoUrl = parseSsoHeader(headers.get("x-github-sso"));
  const tokenExpiresAt = parseTokenExpirationHeader(
    headers.get("github-authentication-token-expiration")
  );

  if (!ssoUrl && !tokenExpiresAt) return;

  const next: GitHubAuthMetadata = { ...(lastAuthMetadata ?? {}) };
  if (ssoUrl) {
    next.ssoUrl = ssoUrl;
    next.ssoCapturedAt = Date.now();
  }
  if (tokenExpiresAt) {
    next.tokenExpiresAt = tokenExpiresAt;
  }
  lastAuthMetadata = next;
}

/**
 * Snapshot the most recent auth metadata, dropping any SSO URL that has
 * exceeded the GitHub-documented 1-hour TTL.
 */
export function getLastAuthMetadata(): GitHubAuthMetadata | null {
  if (!lastAuthMetadata) return null;
  const snapshot: GitHubAuthMetadata = { ...lastAuthMetadata };
  if (
    snapshot.ssoUrl &&
    snapshot.ssoCapturedAt !== undefined &&
    Date.now() - snapshot.ssoCapturedAt > SSO_URL_TTL_MS
  ) {
    delete snapshot.ssoUrl;
    delete snapshot.ssoCapturedAt;
  }
  if (!snapshot.ssoUrl && !snapshot.tokenExpiresAt) return null;
  return snapshot;
}

export interface GitHubTokenConfig {
  hasToken: boolean;
  scopes?: string[];
  username?: string;
  avatarUrl?: string;
}

export interface GitHubTokenValidation {
  valid: boolean;
  scopes: string[];
  username?: string;
  avatarUrl?: string;
  error?: string;
}

// Token storage interface - allows different implementations for main vs utility process
interface TokenStorage {
  get(): string | undefined;
  set(token: string): void;
  delete(): void;
}

// Default memory-only storage (safe for utility process)
class MemoryTokenStorage implements TokenStorage {
  private token: string | null = null;
  get(): string | undefined {
    return this.token ?? undefined;
  }
  set(token: string): void {
    this.token = token;
  }
  delete(): void {
    this.token = null;
  }
}

/**
 * One host's authentication state. github.com and a GitHub Enterprise Server
 * host each hold their own token and identity, so a repository on one is never
 * read with — and never sends — the other's credential.
 */
interface HostSession {
  memoryToken: string | null;
  cachedUsername: string | null;
  cachedAvatarUrl: string | null;
  cachedScopes: string[];
  tokenVersion: number;
  pendingValidation: Promise<void> | null;
}

function newSession(): HostSession {
  return {
    memoryToken: null,
    cachedUsername: null,
    cachedAvatarUrl: null,
    cachedScopes: [],
    tokenVersion: 0,
    pendingValidation: null,
  };
}

function normalizeHost(host: string): string {
  return host.toLowerCase();
}

export class GitHubAuth {
  // Durable storage backs github.com only; an enterprise token is persisted by
  // its own credential module and arrives here through setMemoryToken.
  private static storage: TokenStorage = new MemoryTokenStorage();
  private static readonly sessions = new Map<string, HostSession>();

  private static session(host: string = GITHUB_COM_HOST): HostSession {
    const key = normalizeHost(host);
    let session = this.sessions.get(key);
    if (!session) {
      session = newSession();
      this.sessions.set(key, session);
    }
    return session;
  }

  /**
   * Initialize with secure storage (call from main process only).
   * Must be called before any token operations that need persistence.
   */
  static initializeStorage(storage: TokenStorage): void {
    this.storage = storage;
    const storedToken = storage.get();
    if (storedToken) {
      this.session().memoryToken = storedToken;
    }
  }

  /**
   * The token for `host`, or undefined. Never falls back to another host's:
   * an Enterprise Server repository with no token of its own stays
   * unauthenticated rather than borrowing github.com's.
   */
  static getToken(host: string = GITHUB_COM_HOST): string | undefined {
    const key = normalizeHost(host);
    if (key !== GITHUB_COM_HOST) {
      if (!isServedGitHubHost(key)) return undefined;
      return this.sessions.get(key)?.memoryToken ?? undefined;
    }
    // Prefer memory token (set via IPC in utility process)
    const memoryToken = this.sessions.get(key)?.memoryToken;
    if (memoryToken) {
      return memoryToken;
    }
    return this.storage.get();
  }

  /** The host whose session holds `token`, or null for a token none holds (a candidate under validation). */
  static hostHoldingToken(token: string): string | null {
    for (const [host, session] of this.sessions) {
      if (session.memoryToken === token) return host;
    }
    if (this.storage.get() === token) return GITHUB_COM_HOST;
    return null;
  }

  private static resetSession(session: HostSession, host: string): void {
    session.tokenVersion++;
    session.pendingValidation = null;
    session.cachedUsername = null;
    session.cachedAvatarUrl = null;
    session.cachedScopes = [];
    rateLimitServiceForHost(host).clear();
    if (normalizeHost(host) === GITHUB_COM_HOST) clearAuthMetadata();
  }

  static setMemoryToken(token: string | null, host: string = GITHUB_COM_HOST): void {
    const normalized = token?.trim() ?? null;
    const session = this.session(host);
    session.memoryToken = normalized && normalized.length > 0 ? normalized : null;
    this.resetSession(session, host);
  }

  static hasToken(host: string = GITHUB_COM_HOST): boolean {
    return !!GitHubAuth.getToken(host);
  }

  static getTokenVersion(host: string = GITHUB_COM_HOST): number {
    return this.sessions.get(normalizeHost(host))?.tokenVersion ?? 0;
  }

  static setToken(token: string): void {
    const session = this.session();
    session.memoryToken = token.trim();
    this.storage.set(token.trim());
    this.resetSession(session, GITHUB_COM_HOST);
  }

  static clearToken(): void {
    const session = this.session();
    session.memoryToken = null;
    this.storage.delete();
    this.resetSession(session, GITHUB_COM_HOST);
  }

  static getConfig(host: string = GITHUB_COM_HOST): GitHubTokenConfig {
    const hasToken = GitHubAuth.hasToken(host);
    const session = this.sessions.get(normalizeHost(host));
    return {
      hasToken,
      username: hasToken ? (session?.cachedUsername ?? undefined) : undefined,
      avatarUrl: hasToken ? (session?.cachedAvatarUrl ?? undefined) : undefined,
      scopes:
        hasToken && session && session.cachedScopes.length > 0 ? session.cachedScopes : undefined,
    };
  }

  /**
   * Get config, ensuring user info is fetched if token exists but info is missing.
   * Use this instead of getConfig() when you need guaranteed user info.
   */
  static async getConfigAsync(host: string = GITHUB_COM_HOST): Promise<GitHubTokenConfig> {
    // If we have a token but no cached username, validate to get user info
    const session = this.session(host);
    if (this.hasToken(host) && !session.cachedUsername) {
      // Reuse pending validation to avoid duplicate requests
      if (!session.pendingValidation) {
        const token = this.getToken(host);
        if (token) {
          const versionAtStart = session.tokenVersion;
          const pending = this.validate(token, { host })
            .then((validation) => {
              if (validation.valid && validation.username) {
                this.setValidatedUserInfo(
                  validation.username,
                  validation.avatarUrl,
                  validation.scopes,
                  versionAtStart,
                  host
                );
              }
            })
            .catch(() => {
              // Ignore validation errors - user info will remain undefined
            })
            .finally(() => {
              if (session.pendingValidation === pending) session.pendingValidation = null;
            });
          session.pendingValidation = pending;
        }
      }
      if (session.pendingValidation) {
        await session.pendingValidation;
      }
    }
    return this.getConfig(host);
  }

  static setValidatedUserInfo(
    username: string,
    avatarUrl: string | undefined,
    scopes: string[],
    expectedVersion?: number,
    host: string = GITHUB_COM_HOST
  ): void {
    const session = this.session(host);
    if (expectedVersion !== undefined && session.tokenVersion !== expectedVersion) {
      return;
    }
    session.cachedUsername = username;
    session.cachedAvatarUrl = avatarUrl ?? null;
    session.cachedScopes = scopes;
  }

  /**
   * A GraphQL client for `host`, authenticated with that host's own token and
   * pointed at that host's endpoint, or null when the host has no token.
   */
  static createClient(host: string = GITHUB_COM_HOST): typeof graphql | null {
    const token = GitHubAuth.getToken(host);
    if (!token) return null;

    return graphql.defaults({
      baseUrl: githubGraphqlBase(host),
      headers: {
        authorization: `Bearer ${token}`,
      },
      request: {
        fetch: rateLimitAwareFetch,
      },
    });
  }

  /** Test-only reset of every host session. */
  static _resetSessionsForTests(): void {
    this.sessions.clear();
    this.storage = new MemoryTokenStorage();
  }

  /**
   * Validate a token against `GET /user`. `signal` lets a caller abandon the
   * check early; the built-in timeout still applies either way.
   */
  static async validate(
    token: string,
    options: GitHubValidateOptions = {}
  ): Promise<GitHubTokenValidation> {
    const { signal, detached = false } = options;
    const host = options.host ?? GITHUB_COM_HOST;
    if (!token || token.trim() === "") {
      return { valid: false, scopes: [], error: "Token is empty" };
    }

    if (
      !token.startsWith("ghp_") &&
      !token.startsWith("github_pat_") &&
      !token.startsWith("gho_")
    ) {
      if (token.length < 40) {
        return { valid: false, scopes: [], error: "Invalid token format" };
      }
    }

    let userUrl: string;
    try {
      userUrl = `${githubApiBase(host)}/user`;
    } catch (error) {
      return { valid: false, scopes: [], error: formatErrorMessage(error, "Unknown GitHub host") };
    }

    try {
      const response = await rateLimitAwareFetch(userUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "Daintree-Electron",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(GITHUB_AUTH_TIMEOUT_MS)])
          : AbortSignal.timeout(GITHUB_AUTH_TIMEOUT_MS),
        // Validation must succeed even when a previous token left the
        // circuit-breaker in a blocked state — otherwise the user can never
        // recover by entering a new token. The semaphore still applies so
        // a flurry of validate calls can't drown background work.
        daintreeSkipRateLimitPreflight: true,
        daintreeDetached: detached,
      });

      if (!response.ok) {
        if (response.status === 401) {
          // Confirm a definitive revoked-token signal in the body before
          // declaring the token bad — a brief auth-service incident can
          // surface as a 401 with an HTML error page or unrelated JSON,
          // and we don't want the Settings flow to flip a healthy token
          // into "invalid" on a transient blip. Mirrors the classifier
          // rule used by `parseGitHubError`.
          let bodyText = "";
          try {
            bodyText = await response.text();
          } catch {
            // ignore — fall through to transient
          }
          if (bodyText.includes("Bad credentials")) {
            return { valid: false, scopes: [], error: "Invalid or expired token" };
          }
          return {
            valid: false,
            scopes: [],
            error: "GitHub is temporarily unavailable. Please retry.",
          };
        }
        if (response.status === 403) {
          // Distinguish a secondary-rate-limit 403 from a permissions 403 —
          // both share status but mean very different things to the user.
          // If `retry-after` is present the wrapper's Phase 1 already
          // registered a secondary block; otherwise inspect the body.
          const retryAfter = response.headers.get("retry-after");
          let secondaryHit = retryAfter !== null && retryAfter !== "";
          if (!secondaryHit) {
            try {
              const bodyText = await response.text();
              const lower = bodyText.toLowerCase();
              secondaryHit =
                lower.includes("secondary rate limit") || lower.includes("abuse detection");
            } catch {
              // fall through to permissions error
            }
          }
          if (secondaryHit) {
            return {
              valid: false,
              scopes: [],
              error: "GitHub secondary rate limit triggered. Please retry shortly.",
            };
          }
          return { valid: false, scopes: [], error: "Token lacks required permissions" };
        }
        if (response.status >= 500 && response.status <= 599) {
          return {
            valid: false,
            scopes: [],
            error: "GitHub is temporarily unavailable. Please retry.",
          };
        }
        return {
          valid: false,
          scopes: [],
          error: `GitHub API error: ${response.status} ${response.statusText}`.trim(),
        };
      }

      const userData = (await response.json()) as { login?: string; avatar_url?: string };
      const scopesHeader = response.headers.get("x-oauth-scopes");
      const scopes = scopesHeader
        ? scopesHeader
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [];

      return {
        valid: true,
        scopes,
        username: userData.login,
        avatarUrl: userData.avatar_url,
      };
    } catch (error) {
      const message = formatErrorMessage(error, "Failed to validate GitHub token");
      const isTimeout = error instanceof Error && error.name === "TimeoutError";
      if (
        isTimeout ||
        message.includes("ENOTFOUND") ||
        message.includes("ETIMEDOUT") ||
        message.includes("ECONNREFUSED") ||
        message.includes("ECONNRESET") ||
        message.includes("EAI_AGAIN") ||
        message.includes("network") ||
        message.includes("fetch failed") ||
        message.includes("timed out")
      ) {
        return {
          valid: false,
          scopes: [],
          error:
            host === GITHUB_COM_HOST
              ? "Cannot reach GitHub. Check your internet connection."
              : `Cannot reach ${host}. Check your network connection.`,
        };
      }
      return { valid: false, scopes: [], error: message };
    }
  }
}

/**
 * FIFO async semaphore. `acquire()` resolves to a `release` callback the
 * caller must invoke (in `finally`) to free the slot. Queued waiters are
 * resolved in order — never starved — and `release()` is idempotent so a
 * double-call from an over-eager `finally` is harmless.
 */
class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly max: number) {}

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const grant = (): void => {
        let released = false;
        const release = (): void => {
          if (released) return;
          released = true;
          this.active--;
          const next = this.waiters.shift();
          if (next) {
            this.active++;
            next();
          }
        };
        resolve(release);
      };
      if (this.active < this.max) {
        this.active++;
        grant();
      } else {
        this.waiters.push(grant);
      }
    });
  }

  /** Test-only inspector. */
  _getActiveForTests(): number {
    return this.active;
  }

  /** Test-only inspector. */
  _getPendingForTests(): number {
    return this.waiters.length;
  }

  /** Test-only reset. Drops any queued waiters and zeroes the active count. */
  _resetForTests(): void {
    this.active = 0;
    this.waiters.length = 0;
  }
}

const githubFetchSemaphore = new Semaphore(GITHUB_FETCH_CONCURRENCY);

/** Test-only helper for inspecting the shared semaphore in unit tests. */
export function _getGithubFetchSemaphoreForTests(): {
  active: number;
  pending: number;
  max: number;
} {
  return {
    active: githubFetchSemaphore._getActiveForTests(),
    pending: githubFetchSemaphore._getPendingForTests(),
    max: GITHUB_FETCH_CONCURRENCY,
  };
}

/** Test-only helper to reset the shared semaphore between unit tests. */
export function _resetGithubFetchSemaphoreForTests(): void {
  githubFetchSemaphore._resetForTests();
}

/**
 * Custom fetch wrapper used by `@octokit/graphql` via
 * `graphql.defaults({ request: { fetch } })` and by all direct REST callers
 * in this package. Two protections live here:
 *
 * 1. Preflight circuit-breaker: if the rate-limit service is currently
 *    blocking requests, throw {@link GitHubRateLimitError} before opening
 *    a socket. Bypassable via `init.daintreeSkipRateLimitPreflight = true`
 *    for the token-validation path, which must work even when stale state
 *    from a previous token would otherwise gate it.
 * 2. Process-wide concurrency cap of {@link GITHUB_FETCH_CONCURRENCY} —
 *    bursty callers (PR discovery, batch checks) queue rather than fan out
 *    100+ concurrent requests and trip GitHub's secondary limit.
 *
 * `@octokit/graphql` v9 resolves to the parsed `data.data` payload — the raw
 * `Response` (and its headers) are dropped before the promise resolves.
 * Installing this fetch wrapper is the only reliable place to observe GitHub
 * rate-limit headers on every response (both 2xx and error paths).
 *
 * Response handling is intentionally two-phase: a synchronous header-only
 * classification runs first so the response can return to Octokit
 * immediately, and the body-text classification (used to detect secondary
 * rate limits that GitHub reports via a 403 body rather than a `retry-after`
 * header) runs off the critical path. This prevents a stuck response body
 * from blocking every GitHub call behind the fetch wrapper.
 */
export interface GitHubValidateOptions {
  signal?: AbortSignal;
  /** The GitHub host to validate against: github.com unless named. */
  host?: string;
  /**
   * The token may not be the configured one (e.g. a credential being
   * previewed for import), so its response must not touch the configured
   * token's rate-limit breaker or auth metadata.
   */
  detached?: boolean;
}

export interface RateLimitAwareFetchInit extends RequestInit {
  /**
   * Skip the preflight circuit-breaker check for this request. Used by
   * `GitHubAuth.validate()` so a user explicitly testing a token isn't
   * blocked by stale rate-limit state from a previous token. The semaphore
   * is still honored.
   */
  daintreeSkipRateLimitPreflight?: boolean;
  /**
   * The request authenticates with a token other than the configured one, so
   * its rate-limit headers and auth metadata describe a different account.
   * Skips recording both; another account's exhausted quota must not block
   * the configured account's requests.
   */
  daintreeDetached?: boolean;
}

function requestUrlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function bearerTokenOf(headers: HeadersInit | undefined): string | null {
  if (!headers) return null;
  let value: string | null | undefined;
  if (headers instanceof Headers) {
    value = headers.get("authorization");
  } else if (Array.isArray(headers)) {
    value = headers.find(([name]) => name.toLowerCase() === "authorization")?.[1];
  } else {
    for (const [name, headerValue] of Object.entries(headers)) {
      if (name.toLowerCase() === "authorization") value = headerValue;
    }
  }
  const match = typeof value === "string" ? /^(?:bearer|token)\s+(\S+)$/i.exec(value.trim()) : null;
  return match?.[1] ?? null;
}

/**
 * Refuse to send a token one host's session holds to any other host. Every
 * caller builds the URL and picks the token from the same repository host, so
 * this never fires in a correct path; it turns a missed call site into an
 * error instead of a credential sent to the wrong server.
 */
function assertTokenBoundToHost(input: RequestInfo | URL, init: RequestInit | undefined): void {
  const tokens = [bearerTokenOf(init?.headers)];
  // A Request carries headers of its own, which fetch sends unless `init` overrides them.
  if (typeof input === "object" && !(input instanceof URL))
    tokens.push(bearerTokenOf(input.headers));
  const url = requestUrlOf(input);
  for (const token of tokens) {
    if (!token) continue;
    const holder = GitHubAuth.hostHoldingToken(token);
    // A held token goes only to its own host's exact API origin; anything
    // else, including a lookalike path or port on another server, is refused.
    if (holder !== null && !isApiUrlFor(url, holder)) {
      throw new Error(`Refused to send the ${holder} GitHub token to ${safeOrigin(url)}`);
    }
  }
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "an unparseable URL";
  }
}

export async function rateLimitAwareFetch(
  input: RequestInfo | URL,
  init?: RateLimitAwareFetchInit
): Promise<Response> {
  const skipPreflight = init?.daintreeSkipRateLimitPreflight === true;
  const detached = init?.daintreeDetached === true;
  // Anything that isn't recognisably an Enterprise Server API URL is
  // github.com's, as it was before there was more than one host.
  const requestHost = apiHostOf(requestUrlOf(input)) ?? GITHUB_COM_HOST;
  assertTokenBoundToHost(input, init);
  // A detached check that skips the breaker never touches it, so validating a
  // token for a host that's never saved one allocates nothing for it.
  const rateLimits = detached && skipPreflight ? null : rateLimitServiceForHost(requestHost);

  if (!skipPreflight && rateLimits) {
    const block = rateLimits.shouldBlockRequest();
    if (block.blocked && block.reason && block.resumeAt) {
      throw new GitHubRateLimitError(block.reason, block.resumeAt);
    }
  }

  // Strip the custom properties before forwarding so `globalThis.fetch`
  // doesn't see unknown init fields.
  let fetchInit: RequestInit | undefined = init;
  if (init && ("daintreeSkipRateLimitPreflight" in init || "daintreeDetached" in init)) {
    const {
      daintreeSkipRateLimitPreflight: _ignoredPreflight,
      daintreeDetached: _ignoredDetached,
      ...rest
    } = init;
    void _ignoredPreflight;
    void _ignoredDetached;
    fetchInit = rest;
  }

  const release = await githubFetchSemaphore.acquire();
  const versionAtStart = GitHubAuth.getTokenVersion(requestHost);
  try {
    // Post-acquire re-check: while this request was queued in the semaphore,
    // another request may have completed and registered a block. Without
    // this re-check, queued waiters would dispatch into an active block and
    // amplify the rate-limit violation instead of stopping at the gate.
    if (!skipPreflight && rateLimits) {
      const reblock = rateLimits.shouldBlockRequest();
      if (reblock.blocked && reblock.reason && reblock.resumeAt) {
        throw new GitHubRateLimitError(reblock.reason, reblock.resumeAt);
      }
    }

    const response = await globalThis.fetch(input, fetchInit);
    if (detached || !rateLimits) return response;

    const requestId = response.headers.get("x-github-request-id") ?? undefined;

    // Phase 1 — header-only classification runs immediately. Catches the
    // retry-after path, the primary-limit path, and the 2xx clear path.
    try {
      rateLimits.update(response.headers, response.status, undefined, requestId);
    } catch {
      // Rate-limit bookkeeping must never break the underlying request.
    }

    // Late-arriving response from a previous token: discard so it can't
    // clobber `lastAuthMetadata` set by the currently-configured token.
    // Mirrors the same guard in `GitHubTokenHealthService.runCheck()`.
    // SSO re-authorization and token-expiry metadata describe the github.com
    // account; parseSsoHeader only trusts github.com URLs.
    if (
      requestHost === GITHUB_COM_HOST &&
      GitHubAuth.getTokenVersion(requestHost) === versionAtStart
    ) {
      try {
        captureAuthMetadata(response.headers);
      } catch {
        // Metadata capture must never break the underlying request.
      }
    }

    // Phase 2 — body-text classification for 403/429 responses that GitHub
    // reports via body text rather than a `retry-after` header. Runs
    // *synchronously* before `release()` so the block is registered before
    // any queued waiter can acquire the slot. The body of a 403/429 is
    // small and already buffered after `fetch()` resolves, so this adds
    // only microseconds of latency on the error path.
    if (!response.ok && (response.status === 403 || response.status === 429)) {
      try {
        const bodyText = await response.clone().text();
        rateLimits.update(response.headers, response.status, bodyText, requestId);
      } catch {
        // Cloning can fail on aborted streams; header-only classification
        // already covered the headered case.
      }
    }

    return response;
  } finally {
    release();
  }
}
