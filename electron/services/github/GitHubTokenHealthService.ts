import type {
  GitHubTokenHealthPayload,
  GitHubTokenHealthStatus,
} from "../../../shared/types/ipc/github.js";
import { logDebug, logInfo, logWarn } from "../../utils/logger.js";
import { GitHubAuth, captureAuthMetadata, getLastAuthMetadata } from "./GitHubAuth.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";

/** How often background probes run when the app is actively used. */
export const HEALTH_CHECK_INTERVAL_MS = 30 * 60 * 1000;

/** Minimum gap between probes triggered by focus/wake events. */
export const HEALTH_CHECK_FOCUS_COOLDOWN_MS = 5 * 60 * 1000;

/** Timeout on the probe's fetch call — GitHub's `/rate_limit` should respond quickly. */
export const HEALTH_CHECK_FETCH_TIMEOUT_MS = 10_000;

type StateChangeListener = (state: GitHubTokenHealthPayload) => void;

type FetchFn = typeof globalThis.fetch;

interface GitHubTokenHealthServiceOptions {
  /** Override for tests — inject a mock fetch. */
  fetchImpl?: FetchFn;
  /** Override for tests — inject a deterministic clock. */
  now?: () => number;
}

/**
 * Background health check for the configured GitHub personal access token.
 *
 * GitHub's `GET /rate_limit` endpoint is the ideal probe here:
 *   - Returns HTTP 200 and is exempt from primary quota accounting when the
 *     token is valid (zero-quota, safe to poll indefinitely).
 *   - Returns HTTP 401 "Bad credentials" when the token is expired, revoked,
 *     or malformed — authoritative and unambiguous.
 *
 * Network failures (`ENOTFOUND`, `ETIMEDOUT`, etc.) deliberately do NOT
 * flip the service into `unhealthy`; only an explicit 401 does. This avoids
 * surfacing a "Reconnect to GitHub" banner when the user is merely offline.
 *
 * A monotonically increasing `tokenVersion` (owned by {@link GitHubAuth})
 * guards against a stale in-flight probe clobbering a freshly-updated token.
 */
class GitHubTokenHealthServiceImpl {
  private status: GitHubTokenHealthStatus = "unknown";
  private lastCheckedAt = 0;
  private tokenVersionAtLastCheck = -1;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pendingCheck: Promise<void> | null = null;
  private readonly listeners = new Set<StateChangeListener>();

  private fetchImpl: FetchFn;
  private now: () => number;

  constructor(options: GitHubTokenHealthServiceOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Register a subscriber that fires on every state transition. Transports
   * (main-process broadcast to renderer) hook in here.
   */
  onStateChange(listener: StateChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Snapshot of the current state — safe to call before any probe has run. */
  getState(): GitHubTokenHealthPayload {
    const metadata = getLastAuthMetadata();
    return {
      status: this.status,
      tokenVersion: this.tokenVersionAtLastCheck,
      checkedAt: this.lastCheckedAt,
      ssoUrl: metadata?.ssoUrl,
    };
  }

  /**
   * Begin polling. Safe to call multiple times — subsequent calls are no-ops.
   * Fires an immediate probe asynchronously so the first result is available
   * soon after startup without blocking the caller.
   */
  start(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void this.runCheck({ reason: "interval" });
    }, HEALTH_CHECK_INTERVAL_MS);
    void this.runCheck({ reason: "start" });
  }

  /** Stop polling and tear down listeners. Safe to call multiple times. */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Alias for {@link stop} — matches the lifecycle naming used elsewhere. */
  dispose(): void {
    this.stop();
    this.listeners.clear();
    this.resetState();
  }

  /**
   * Run a probe immediately, subject to a 5-minute cooldown unless `force`
   * is set. Intended for focus/wake handlers that want to recheck promptly
   * without hammering the API when the user is toggling windows rapidly.
   */
  refresh(options: { force?: boolean } = {}): Promise<void> {
    const force = options.force === true;
    if (!force) {
      const elapsed = this.now() - this.lastCheckedAt;
      if (this.lastCheckedAt > 0 && elapsed < HEALTH_CHECK_FOCUS_COOLDOWN_MS) {
        logDebug("GitHub token health: skipping refresh within cooldown", { elapsed });
        return Promise.resolve();
      }
    }
    return this.runCheck({ reason: force ? "forced" : "refresh" });
  }

  /**
   * Drop state back to `unknown` — used on token change so a stale healthy
   * badge from the previous token doesn't bleed into the new token's
   * reality.
   */
  resetState(): void {
    if (this.status === "unknown" && this.lastCheckedAt === 0) return;
    this.status = "unknown";
    this.lastCheckedAt = 0;
    this.tokenVersionAtLastCheck = -1;
    this.notifyListeners();
  }

  /** Test-only helper. */
  _resetForTests(): void {
    this.stop();
    this.listeners.clear();
    this.status = "unknown";
    this.lastCheckedAt = 0;
    this.tokenVersionAtLastCheck = -1;
    this.pendingCheck = null;
  }

  /** Test-only helper. */
  _setFetchForTests(fetchImpl: FetchFn): void {
    this.fetchImpl = fetchImpl;
  }

  /** Test-only helper. */
  _setNowForTests(now: () => number): void {
    this.now = now;
  }

  private async runCheck(context: { reason: string }): Promise<void> {
    // Coalesce concurrent probes — two wake/focus events firing back-to-back
    // shouldn't produce two in-flight requests.
    if (this.pendingCheck) return this.pendingCheck;

    const token = GitHubAuth.getToken();
    if (!token) {
      // No token configured: clear any lingering state so a previously-unhealthy
      // banner doesn't hang around after the user clears the token.
      if (this.status !== "unknown") {
        this.status = "unknown";
        this.lastCheckedAt = this.now();
        this.notifyListeners();
      }
      return;
    }

    const versionAtStart = GitHubAuth.getTokenVersion();

    this.pendingCheck = (async () => {
      try {
        const response = await this.fetchImpl("https://api.github.com/rate_limit", {
          headers: {
            Authorization: `token ${token}`,
            Accept: "application/vnd.github.v3+json",
          },
          signal: AbortSignal.timeout(HEALTH_CHECK_FETCH_TIMEOUT_MS),
        });

        // Late-arriving probe from a previous token: discard so it can't
        // clobber state — including `lastAuthMetadata` — set by the
        // currently-configured token. Must be checked *before* passive
        // metadata capture so a stale `X-GitHub-SSO` header from token A
        // doesn't repopulate the metadata store after token B took over.
        if (GitHubAuth.getTokenVersion() !== versionAtStart) {
          logDebug("GitHub token health: stale probe discarded", {
            versionAtStart,
            currentVersion: GitHubAuth.getTokenVersion(),
          });
          return;
        }

        // Passive auth metadata capture (X-GitHub-SSO, token expiry header)
        // — this is the same capture the Octokit fetch wrapper does, but the
        // health probe uses raw `fetch()` so we mirror the behavior here.
        try {
          captureAuthMetadata(response.headers);
        } catch {
          // Metadata capture must never break the probe.
        }

        if (response.status === 401) {
          this.transitionTo("unhealthy", versionAtStart);
          return;
        }

        if (response.status >= 200 && response.status < 300) {
          this.transitionTo("healthy", versionAtStart);
          return;
        }

        // Non-401 errors (403 from org policy, 5xx from GitHub downtime, etc.)
        // aren't definitive signals about the token itself. Log and leave the
        // state untouched so a transient server error doesn't trigger a
        // spurious reconnect banner.
        logWarn("GitHub token health: inconclusive response status", {
          status: response.status,
          reason: context.reason,
        });
      } catch (err) {
        // Network failures (`ENOTFOUND`, `ETIMEDOUT`, `AbortError`, etc.) are
        // not authoritative token-dead signals — don't flip state.
        logDebug("GitHub token health: probe failed (network/transport)", {
          error: formatErrorMessage(err, "Token health probe failed"),
          reason: context.reason,
        });
      }
    })().finally(() => {
      this.pendingCheck = null;
    });

    return this.pendingCheck;
  }

  private transitionTo(status: GitHubTokenHealthStatus, tokenVersion: number): void {
    const previous = this.status;
    this.status = status;
    this.lastCheckedAt = this.now();
    this.tokenVersionAtLastCheck = tokenVersion;

    if (previous !== status) {
      if (status === "unhealthy") {
        logInfo("GitHub token health: unhealthy (401 from /rate_limit)");
      } else if (status === "healthy") {
        logInfo("GitHub token health: healthy");
      }
      this.notifyListeners();
    } else {
      logDebug("GitHub token health: unchanged", { status });
    }
  }

  private notifyListeners(): void {
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (err) {
        // A misbehaving transport must not break health-check bookkeeping.
        logWarn("GitHub token-health listener threw", {
          error: formatErrorMessage(err, "Token-health listener failed"),
        });
      }
    }
  }
}

export { GitHubTokenHealthServiceImpl };
export const gitHubTokenHealthService = new GitHubTokenHealthServiceImpl();
