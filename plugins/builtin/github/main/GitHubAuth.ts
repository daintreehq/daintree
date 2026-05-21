import { graphql } from "@octokit/graphql";
import { gitHubRateLimitService, GitHubRateLimitError } from "./GitHubRateLimitService.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";

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

export class GitHubAuth {
  private static storage: TokenStorage = new MemoryTokenStorage();
  private static memoryToken: string | null = null;
  private static cachedUsername: string | null = null;
  private static cachedAvatarUrl: string | null = null;
  private static cachedScopes: string[] = [];
  private static tokenVersion = 0;

  /**
   * Initialize with secure storage (call from main process only).
   * Must be called before any token operations that need persistence.
   */
  static initializeStorage(storage: TokenStorage): void {
    this.storage = storage;
    const storedToken = storage.get();
    if (storedToken) {
      this.memoryToken = storedToken;
    }
  }

  static getToken(): string | undefined {
    // Prefer memory token (set via IPC in utility process)
    if (this.memoryToken) {
      return this.memoryToken;
    }
    return this.storage.get();
  }

  static setMemoryToken(token: string | null): void {
    const normalized = token?.trim() ?? null;
    this.memoryToken = normalized && normalized.length > 0 ? normalized : null;
    this.tokenVersion++;
    this.pendingValidation = null;
    this.cachedUsername = null;
    this.cachedAvatarUrl = null;
    this.cachedScopes = [];
    gitHubRateLimitService.clear();
    clearAuthMetadata();
  }

  static hasToken(): boolean {
    return !!GitHubAuth.getToken();
  }

  static getTokenVersion(): number {
    return this.tokenVersion;
  }

  static setToken(token: string): void {
    this.memoryToken = token.trim();
    this.storage.set(token.trim());
    this.tokenVersion++;
    this.pendingValidation = null;
    this.cachedUsername = null;
    this.cachedAvatarUrl = null;
    this.cachedScopes = [];
    gitHubRateLimitService.clear();
    clearAuthMetadata();
  }

  static clearToken(): void {
    this.memoryToken = null;
    this.cachedUsername = null;
    this.cachedAvatarUrl = null;
    this.cachedScopes = [];
    this.tokenVersion++;
    this.pendingValidation = null;
    this.storage.delete();
    gitHubRateLimitService.clear();
    clearAuthMetadata();
  }

  private static pendingValidation: Promise<void> | null = null;

  static getConfig(): GitHubTokenConfig {
    const hasToken = GitHubAuth.hasToken();
    return {
      hasToken,
      username: hasToken ? (this.cachedUsername ?? undefined) : undefined,
      avatarUrl: hasToken ? (this.cachedAvatarUrl ?? undefined) : undefined,
      scopes: hasToken && this.cachedScopes.length > 0 ? this.cachedScopes : undefined,
    };
  }

  /**
   * Get config, ensuring user info is fetched if token exists but info is missing.
   * Use this instead of getConfig() when you need guaranteed user info.
   */
  static async getConfigAsync(): Promise<GitHubTokenConfig> {
    // If we have a token but no cached username, validate to get user info
    if (this.hasToken() && !this.cachedUsername) {
      // Reuse pending validation to avoid duplicate requests
      if (!this.pendingValidation) {
        const token = this.getToken();
        if (token) {
          const versionAtStart = this.tokenVersion;
          this.pendingValidation = this.validate(token)
            .then((validation) => {
              if (validation.valid && validation.username) {
                this.setValidatedUserInfo(
                  validation.username,
                  validation.avatarUrl,
                  validation.scopes,
                  versionAtStart
                );
              }
            })
            .catch(() => {
              // Ignore validation errors - user info will remain undefined
            })
            .finally(() => {
              this.pendingValidation = null;
            });
        }
      }
      if (this.pendingValidation) {
        await this.pendingValidation;
      }
    }
    return this.getConfig();
  }

  static setValidatedUserInfo(
    username: string,
    avatarUrl: string | undefined,
    scopes: string[],
    expectedVersion?: number
  ): void {
    if (expectedVersion !== undefined && this.tokenVersion !== expectedVersion) {
      return;
    }
    this.cachedUsername = username;
    this.cachedAvatarUrl = avatarUrl ?? null;
    this.cachedScopes = scopes;
  }

  static createClient(): typeof graphql | null {
    const token = GitHubAuth.getToken();
    if (!token) return null;

    return graphql.defaults({
      headers: {
        authorization: `Bearer ${token}`,
      },
      request: {
        fetch: rateLimitAwareFetch,
      },
    });
  }

  static async validate(token: string): Promise<GitHubTokenValidation> {
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

    try {
      const response = await rateLimitAwareFetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "Daintree-Electron",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(GITHUB_AUTH_TIMEOUT_MS),
        // Validation must succeed even when a previous token left the
        // circuit-breaker in a blocked state — otherwise the user can never
        // recover by entering a new token. The semaphore still applies so
        // a flurry of validate calls can't drown background work.
        daintreeSkipRateLimitPreflight: true,
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
          error: "Cannot reach GitHub. Check your internet connection.",
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
export interface RateLimitAwareFetchInit extends RequestInit {
  /**
   * Skip the preflight circuit-breaker check for this request. Used by
   * `GitHubAuth.validate()` so a user explicitly testing a token isn't
   * blocked by stale rate-limit state from a previous token. The semaphore
   * is still honored.
   */
  daintreeSkipRateLimitPreflight?: boolean;
}

export async function rateLimitAwareFetch(
  input: RequestInfo | URL,
  init?: RateLimitAwareFetchInit
): Promise<Response> {
  const skipPreflight = init?.daintreeSkipRateLimitPreflight === true;

  if (!skipPreflight) {
    const block = gitHubRateLimitService.shouldBlockRequest();
    if (block.blocked && block.reason && block.resumeAt) {
      throw new GitHubRateLimitError(block.reason, block.resumeAt);
    }
  }

  // Strip the custom property before forwarding so `globalThis.fetch`
  // doesn't see an unknown init field.
  let fetchInit: RequestInit | undefined = init;
  if (init && "daintreeSkipRateLimitPreflight" in init) {
    const { daintreeSkipRateLimitPreflight: _ignored, ...rest } = init;
    void _ignored;
    fetchInit = rest;
  }

  const release = await githubFetchSemaphore.acquire();
  const versionAtStart = GitHubAuth.getTokenVersion();
  try {
    // Post-acquire re-check: while this request was queued in the semaphore,
    // another request may have completed and registered a block. Without
    // this re-check, queued waiters would dispatch into an active block and
    // amplify the rate-limit violation instead of stopping at the gate.
    if (!skipPreflight) {
      const reblock = gitHubRateLimitService.shouldBlockRequest();
      if (reblock.blocked && reblock.reason && reblock.resumeAt) {
        throw new GitHubRateLimitError(reblock.reason, reblock.resumeAt);
      }
    }

    const response = await globalThis.fetch(input, fetchInit);

    const requestId = response.headers.get("x-github-request-id") ?? undefined;

    // Phase 1 — header-only classification runs immediately. Catches the
    // retry-after path, the primary-limit path, and the 2xx clear path.
    try {
      gitHubRateLimitService.update(response.headers, response.status, undefined, requestId);
    } catch {
      // Rate-limit bookkeeping must never break the underlying request.
    }

    // Late-arriving response from a previous token: discard so it can't
    // clobber `lastAuthMetadata` set by the currently-configured token.
    // Mirrors the same guard in `GitHubTokenHealthService.runCheck()`.
    if (GitHubAuth.getTokenVersion() === versionAtStart) {
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
        gitHubRateLimitService.update(response.headers, response.status, bodyText, requestId);
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
