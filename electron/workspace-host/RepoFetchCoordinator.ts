import { createBackgroundFetchGit } from "../utils/hardenedGit.js";
import { getGitCommonDir } from "../utils/gitUtils.js";
import { classifyGitError } from "../../shared/utils/gitOperationErrors.js";
import type { GitOperationReason } from "../../shared/types/ipc/errors.js";

const FETCH_ABORT_TIMEOUT_MS = 60_000;

const FETCH_RECENCY_WINDOW_MS = 15_000;
const FORCE_FETCH_RECENCY_WINDOW_MS = 5_000;

const NETWORK_FAILURE_TTL_MS = 60_000;
const NETWORK_FAILURE_JITTER_MS = 30_000;
const REPO_NOT_FOUND_FIRST_FETCH_TTL_MS = 5 * 60_000;
const TRANSIENT_FAILURE_TTL_MS = 60_000;
const TRANSIENT_FAILURE_JITTER_MS = 30_000;
const AUTH_FAILURE_TTL_MS = Number.POSITIVE_INFINITY;

/** Failure categories with distinct retry semantics. */
type FetchFailureKind = "auth" | "network" | "repo-not-found-first" | "transient";

interface FetchFailureEntry {
  kind: FetchFailureKind;
  reason: GitOperationReason;
  retryAt: number;
}

interface RepoState {
  /** In-flight chain — every fetch awaits the prior one for the same commondir. */
  chain: Promise<void>;
  failure: FetchFailureEntry | null;
  lastSuccessfulFetch: number | null;
  /** Bumped when the repo's monitors are torn down so stale completions discard. */
  generation: number;
}

export interface RepoFetchCoordinatorCallbacks {
  onFetchSuccess?: (worktreeId: string) => void;
}

export interface FetchOptions {
  worktreeId: string;
  worktreePath: string;
  /** When true, ignore the failure cache (manual user-triggered refresh). */
  force?: boolean;
}

export interface FetchResult {
  status: "success" | "skipped" | "failed";
  /** Present when status === "failed". */
  reason?: GitOperationReason;
  /** Why we skipped — for logging / diagnostics. */
  skipReason?: "no-common-dir" | "in-failure-window" | "auth-suspended" | "stale-generation";
  /**
   * Coordinator's per-commondir `lastSuccessfulFetch` after this call settled.
   * Set on success (the timestamp just written) and on skipped/failed
   * outcomes (the prior timestamp, if any). Lets `WorkspaceService` propagate
   * the freshest known value to monitors without reaching into coordinator
   * internals.
   */
  lastFetchedAt?: number | null;
  /**
   * True when this call ended in (or remained in) an auth-class failure for
   * this commondir. Includes the `auth-suspended` skip case so the renderer
   * keeps showing the "Sign in to refresh" affordance instead of flashing
   * stale counts when a sibling's force-fetch is rate-cached.
   */
  authFailed?: boolean;
  /**
   * True when this call ended in (or remained in) a transient (network /
   * repo-not-found-first / generic transient) failure. Drives the
   * "Couldn't reach origin" tooltip line on the worktree card. False on
   * success, on auth-class failures (those use `authFailed`), and on the
   * `no-common-dir` skip path where we have no state to report.
   */
  networkFailed?: boolean;
}

/**
 * Per-repo coordinator for background `git fetch` calls.
 *
 * Why this exists:
 *   - Linked worktrees share the same `.git/objects` and `packed-refs`. If
 *     N worktrees fetch concurrently they race on `packed-refs.lock` and
 *     produce sporadic failures. Solution: per-commondir promise chain.
 *   - `git fetch` has no native timeout. A stalled connection can sit forever
 *     even with the lowSpeedLimit/lowSpeedTime config. Solution: an
 *     AbortController armed with a 60s timeout per fetch.
 *   - Auth failures must NOT auto-retry — repeated bad-token attempts trigger
 *     GitHub secondary rate limits. Solution: indefinite suspension cleared
 *     only by `clearAuthFailures()` (called when the user signs in / rotates
 *     a token).
 *   - Network blips and "repository-not-found-on-first-fetch" should retry
 *     after a short window. After at least one prior success, a 404 is more
 *     likely a permission revocation masked as 404 (GitHub does this) — treat
 *     it as auth-failed.
 *   - Sibling worktrees schedule independent cadence fetches against the same
 *     origin (and wake/auth-retry paths force one per monitor). A short
 *     recency window dedups them: when the repo fetched successfully moments
 *     ago, return that success without spawning git. Refs are shared via the
 *     commondir, so they are genuinely fresh for every sibling.
 */
export class RepoFetchCoordinator {
  private readonly states = new Map<string, RepoState>();
  /**
   * Coordinator-wide generation baseline. Bumped by `destroy()` so any new
   * `RepoState` created after a project switch (e.g. when reopening the same
   * repo path on a fresh project) starts at a higher generation than any
   * still-in-flight pre-destroy fetch. Without this, a stale completion that
   * captured `generationAtStart=0` could pass the guard against a fresh
   * `state.generation=0` and corrupt the new project's failure cache.
   */
  private baseGeneration = 0;

  constructor(private readonly callbacks: RepoFetchCoordinatorCallbacks = {}) {}

  /**
   * Schedule a fetch for the given worktree. Resolves with a status describing
   * what happened. Multiple worktrees that share a `git common-dir` are
   * serialized on a single per-repo promise chain.
   */
  async fetchForWorktree(opts: FetchOptions): Promise<FetchResult> {
    const commonDir = getGitCommonDir(opts.worktreePath, { logErrors: false });
    if (!commonDir) {
      return { status: "skipped", skipReason: "no-common-dir" };
    }

    const state = this.getOrCreateState(commonDir);

    if (!opts.force && state.failure) {
      const failure = state.failure;
      if (failure.kind === "auth") {
        return {
          status: "skipped",
          skipReason: "auth-suspended",
          reason: failure.reason,
          lastFetchedAt: state.lastSuccessfulFetch,
          authFailed: true,
          networkFailed: false,
        };
      }
      if (Date.now() < failure.retryAt) {
        return {
          status: "skipped",
          skipReason: "in-failure-window",
          reason: failure.reason,
          lastFetchedAt: state.lastSuccessfulFetch,
          authFailed: false,
          // Skipping inside the retry window means a transient failure is
          // still cached — keep the "Couldn't reach origin" tooltip up.
          networkFailed: true,
        };
      }
    }

    const recent = this.recentSuccessResult(state, opts.force === true);
    if (recent) {
      return recent;
    }

    const generationAtStart = state.generation;
    const result = state.chain.then(() => this.runFetch(commonDir, generationAtStart, opts));
    state.chain = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /**
   * Drop network-class failures so the next fetch attempt is allowed
   * immediately. Called on OS wake / network reconnect.
   */
  clearNetworkFailures(): void {
    for (const state of this.states.values()) {
      if (
        state.failure &&
        (state.failure.kind === "network" || state.failure.kind === "transient")
      ) {
        state.failure = null;
      }
    }
  }

  /**
   * Drop auth-suspension entries. Called when the user signs in / refreshes
   * GitHub credentials so previously-failing repos can fetch again.
   */
  clearAuthFailures(): void {
    for (const state of this.states.values()) {
      if (state.failure?.kind === "auth") {
        state.failure = null;
      }
    }
  }

  /** Force-clear all failure entries (e.g. on project switch). */
  clearAllFailures(): void {
    for (const state of this.states.values()) {
      state.failure = null;
    }
  }

  /**
   * Mark every known repo's generation as invalidated, dropping in-flight
   * results before they mutate state. Called on shutdown / project switch.
   * Bumps the coordinator-wide baseline too so freshly-created states (e.g.
   * after reopening the same repo on a different project) start above any
   * still-in-flight pre-destroy fetch's captured generation.
   */
  destroy(): void {
    for (const state of this.states.values()) {
      state.generation += 1;
      state.failure = null;
    }
    this.states.clear();
    this.baseGeneration += 1;
  }

  /** Test/diagnostic accessor. */
  hasFailureFor(commonDir: string): boolean {
    return this.states.get(commonDir)?.failure != null;
  }

  /** Test/diagnostic accessor. */
  getLastSuccessfulFetch(commonDir: string): number | null {
    return this.states.get(commonDir)?.lastSuccessfulFetch ?? null;
  }

  /**
   * Success result reusing the last fetch when it landed within the recency
   * window — `null` when a real fetch is needed. Never applies over a cached
   * failure so failure surfacing keeps today's semantics. A negative elapsed
   * (clock moved backwards) also forces a real fetch.
   */
  private recentSuccessResult(state: RepoState, force: boolean): FetchResult | null {
    if (state.failure || state.lastSuccessfulFetch === null) return null;
    const window = force ? FORCE_FETCH_RECENCY_WINDOW_MS : FETCH_RECENCY_WINDOW_MS;
    const elapsed = Date.now() - state.lastSuccessfulFetch;
    if (elapsed < 0 || elapsed >= window) return null;
    return {
      status: "success",
      lastFetchedAt: state.lastSuccessfulFetch,
      authFailed: false,
      networkFailed: false,
    };
  }

  private getOrCreateState(commonDir: string): RepoState {
    let state = this.states.get(commonDir);
    if (!state) {
      state = {
        chain: Promise.resolve(),
        failure: null,
        lastSuccessfulFetch: null,
        generation: this.baseGeneration,
      };
      this.states.set(commonDir, state);
    }
    return state;
  }

  private async runFetch(
    commonDir: string,
    generationAtStart: number,
    opts: FetchOptions
  ): Promise<FetchResult> {
    const stateAtStart = this.states.get(commonDir);
    if (!stateAtStart || stateAtStart.generation !== generationAtStart) {
      return { status: "skipped", skipReason: "stale-generation" };
    }
    // Re-check recency after waiting on the chain — back-to-back sibling
    // fetches (wake storm, auth retry) all queue before the first completes,
    // so the dedup has to look at the timestamp the prior link just wrote.
    const recent = this.recentSuccessResult(stateAtStart, opts.force === true);
    if (recent) {
      return recent;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_ABORT_TIMEOUT_MS);
    let succeeded = false;
    try {
      const git = createBackgroundFetchGit(opts.worktreePath, {
        signal: controller.signal,
      });
      // --no-write-fetch-head: skip writing FETCH_HEAD on background fetches
      // so concurrent foreground operations (status polls, user pushes) don't
      // contend on the same file. Requires Git ≥ 2.29 — all supported platforms
      // ship ≥ 2.34, so no version guard is needed.
      await git.raw(["fetch", "origin", "--no-auto-gc", "--prune", "--no-write-fetch-head"]);

      const state = this.states.get(commonDir);
      if (!state || state.generation !== generationAtStart) {
        return { status: "skipped", skipReason: "stale-generation" };
      }
      state.failure = null;
      state.lastSuccessfulFetch = Date.now();
      succeeded = true;
      return {
        status: "success",
        lastFetchedAt: state.lastSuccessfulFetch,
        authFailed: false,
        networkFailed: false,
      };
    } catch (error) {
      const reason = classifyGitError(error);
      const state = this.states.get(commonDir);
      if (!state || state.generation !== generationAtStart) {
        return { status: "skipped", skipReason: "stale-generation" };
      }
      state.failure = this.classifyForCache(reason, state.lastSuccessfulFetch, error);
      const isAuth = state.failure.kind === "auth";
      return {
        status: "failed",
        reason,
        lastFetchedAt: state.lastSuccessfulFetch,
        authFailed: isAuth,
        // Auth-class failures use `authFailed`; everything else surfaces as
        // a transient "Couldn't reach origin" tooltip line.
        networkFailed: !isAuth,
      };
    } finally {
      clearTimeout(timeout);
      // Notify outside the try/catch so a throwing observer can't poison the
      // failure cache. Wrapped defensively — `onFetchSuccess` is fire-and-forget.
      if (succeeded) {
        try {
          this.callbacks.onFetchSuccess?.(opts.worktreeId);
        } catch {
          // Observer threw — silently swallow; fetch itself succeeded.
        }
      }
    }
  }

  private classifyForCache(
    reason: GitOperationReason,
    lastSuccessfulFetch: number | null,
    error: unknown
  ): FetchFailureEntry {
    const now = Date.now();
    if (reason === "auth-failed") {
      return { kind: "auth", reason, retryAt: now + AUTH_FAILURE_TTL_MS };
    }
    if (reason === "repository-not-found") {
      // After at least one prior success, a 404 from origin almost always
      // indicates GitHub's "404 instead of 403" permission masking. Treat as
      // auth-failed so we don't hammer with retries.
      if (lastSuccessfulFetch !== null) {
        return { kind: "auth", reason, retryAt: now + AUTH_FAILURE_TTL_MS };
      }
      return {
        kind: "repo-not-found-first",
        reason,
        retryAt: now + REPO_NOT_FOUND_FIRST_FETCH_TTL_MS,
      };
    }
    if (reason === "network-unavailable") {
      const window = NETWORK_FAILURE_TTL_MS + NETWORK_FAILURE_JITTER_MS;
      return {
        kind: "network",
        reason,
        retryAt: now + Math.random() * window,
      };
    }
    // Aborts (the 60s timeout firing) look like generic errors; bucket them
    // with transient so they retry on a short window.
    if (this.isAbortError(error)) {
      const window = TRANSIENT_FAILURE_TTL_MS + TRANSIENT_FAILURE_JITTER_MS;
      return {
        kind: "transient",
        reason,
        retryAt: now + Math.random() * window,
      };
    }
    const window = TRANSIENT_FAILURE_TTL_MS + TRANSIENT_FAILURE_JITTER_MS;
    return {
      kind: "transient",
      reason,
      retryAt: now + Math.random() * window,
    };
  }

  private isAbortError(error: unknown): boolean {
    if (error != null && typeof error === "object") {
      const name = (error as { name?: string }).name;
      if (name === "AbortError") return true;
      // simple-git wraps AbortError in GitError — only check the known wrapper.
      const message = (error as { message?: string }).message;
      if (
        name === "GitError" &&
        typeof message === "string" &&
        /aborted|operation was aborted|abort/i.test(message)
      ) {
        return true;
      }
    }
    return false;
  }
}
