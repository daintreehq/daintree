import { graphql } from "@octokit/graphql";
import { gitHubRateLimitService } from "./GitHubRateLimitService.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";

export const GITHUB_API_TIMEOUT_MS = 15_000;
export const GITHUB_AUTH_TIMEOUT_MS = 10_000;

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
        authorization: `token ${token}`,
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
      const response = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github.v3+json",
        },
        signal: AbortSignal.timeout(GITHUB_AUTH_TIMEOUT_MS),
      });

      if (!response.ok) {
        if (response.status === 401) {
          return { valid: false, scopes: [], error: "Invalid or expired token" };
        }
        if (response.status === 403) {
          return { valid: false, scopes: [], error: "Token lacks required permissions" };
        }
        return { valid: false, scopes: [], error: `GitHub API error: ${response.statusText}` };
      }

      const userData = (await response.json()) as { login?: string; avatar_url?: string };
      const scopesHeader = response.headers.get("x-oauth-scopes");
      const scopes = scopesHeader ? scopesHeader.split(",").map((s) => s.trim()) : [];

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
 * Custom fetch wrapper used by `@octokit/graphql` via
 * `graphql.defaults({ request: { fetch } })`.
 *
 * `@octokit/graphql` v9 resolves to the parsed `data.data` payload — the raw
 * `Response` (and its headers) are dropped before the promise resolves.
 * Installing this fetch wrapper is the only reliable place to observe GitHub
 * rate-limit headers on every response (both 2xx and error paths).
 *
 * The wrapper is intentionally two-phase: a synchronous header-only
 * classification runs first so the response can return to Octokit
 * immediately, and the body-text classification (used to detect secondary
 * rate limits that GitHub reports via a 403 body rather than a `retry-after`
 * header) runs off the critical path. This prevents a stuck response body
 * from blocking every GitHub call behind the fetch wrapper.
 */
async function rateLimitAwareFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const response = await globalThis.fetch(input, init);

  // Phase 1 — header-only classification runs immediately so the Response
  // can flow back to Octokit without waiting on the body.
  try {
    gitHubRateLimitService.update(response.headers, response.status);
  } catch {
    // Rate-limit bookkeeping must never break the underlying request.
  }

  // Passive auth-metadata capture: SSO re-authorization URL and token expiry
  // date. Same fire-and-forget contract as rate-limit bookkeeping.
  try {
    captureAuthMetadata(response.headers);
  } catch {
    // Metadata capture must never break the underlying request.
  }

  // Phase 2 — secondary-limit fallback classification when the 403/429
  // response carries no `retry-after` but explains the block in its body.
  // Scheduled off the hot path; any failures are swallowed.
  if (!response.ok && (response.status === 403 || response.status === 429)) {
    void response
      .clone()
      .text()
      .then((bodyText) => {
        try {
          gitHubRateLimitService.update(response.headers, response.status, bodyText);
        } catch {
          // Swallow — see Phase 1 comment.
        }
      })
      .catch(() => {
        // Cloning can fail on aborted streams; header-only classification
        // is already safe.
      });
  }

  return response;
}
