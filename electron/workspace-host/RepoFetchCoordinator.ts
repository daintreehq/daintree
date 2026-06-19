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

/**
 * Exponential backoff windows applied to auth-class fetch failures, indexed by
 * consecutive failure count (clamped to the last entry once exhausted). A bad
 * token or revoked credential resolves on its own only when the user re-auths,
 * but a transient credential-helper hiccup or a one-off 401 clears by itself —
 * so we auto-retry on a widening schedule instead of suspending the repo's
 * fetch forever. Hourly steady state stays well clear of GitHub's secondary
 * rate-limit ceiling.
 */
const AUTH_FAILURE_BACKOFF_SCHEDULE_MS = [5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000];
/**
 * Consecutive auth failures before the failure is treated as confirmed. Until
 * then the per-card "Forge authentication failed" stripe stays suppressed (the
 * card shows the softer transient state) so a single blip doesn't alarm every
 * worktree. The first three failures span ~20min (5+15) before escalation.
 */
const AUTH_FAILURE_CONFIRM_RETRIES = 3;
/**
 * Backoff window for forge secondary-rate-limit failures. Long on purpose —
 * retrying soon extends the limit window — but finite, so fetching resumes
 * automatically once the throttle clears.
 */
const RATE_LIMIT_FAILURE_TTL_MS = 45 * 60_000;
const RATE_LIMIT_FAILURE_JITTER_MS = 15 * 60_000;

/** Failure categories with distinct retry semantics. */
type FetchFailureKind = "auth" | "network" | "repo-not-found-first" | "transient";

interface FetchFailureEntry {
  kind: FetchFailureKind;
  reason: GitOperationReason;
  retryAt: number;
  /**
   * Consecutive auth-class failures observed for this repo. Drives the backoff
   * schedule and the confirmation threshold. Only set on `kind: "auth"` entries;
   * reset to undefined when a fetch succeeds (the entry is cleared).
   */
  authRetryCount?: number;
  /**
   * True once an auth-class failure has persisted past
   * `AUTH_FAILURE_CONFIRM_RETRIES`. Gates the per-card auth stripe and the
   * one-shot escalation callback. Only meaningful on `kind: "auth"` entries.
   */
  confirmed?: boolean;
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
  /**
   * Fired once per repo when an auth-class fetch failure persists past
   * `AUTH_FAILURE_CONFIRM_RETRIES` — i.e. the credential is genuinely broken,
   * not a transient blip. Used to surface a single escalation toast instead of
   * the per-card stripe. Fires only on the unconfirmed→confirmed transition;
   * `clearAuthFailures()` resets the state so a later re-confirmation re-fires.
   */
  onAuthFailureConfirmed?: (commonDir: string, reason: GitOperationReason) => void;
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
 *   - Auth failures auto-retry on a widening exponential backoff
 *     (`AUTH_FAILURE_BACKOFF_SCHEDULE_MS`) rather than suspending forever — a
 *     transient 401/credential-helper blip recovers on its own, and a genuinely
 *     broken token still gets retried hourly. The per-card auth stripe stays
 *     suppressed until the failure is `confirmed` (past
 *     `AUTH_FAILURE_CONFIRM_RETRIES`), at which point `onAuthFailureConfirmed`
 *     fires once so the renderer can show a single escalation toast.
 *     `clearAuthFailures()` (user sign-in / token rotation / manual retry)
 *     drops the suspension immediately.
 *   - Forge secondary rate limits (HTTP 403 with a `secondary rate limit`
 *     sideband) are classified separately from auth failures and backed off on
 *     a long but finite window so fetching resumes once the throttle clears.
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
      if (Date.now() < failure.retryAt) {
        const isAuth = failure.kind === "auth";
        return {
          status: "skipped",
          skipReason: isAuth ? "auth-suspended" : "in-failure-window",
          reason: failure.reason,
          lastFetchedAt: state.lastSuccessfulFetch,
          // Only surface the per-card auth stripe once the failure is
          // confirmed (several retries exhausted). Pre-confirmation auth
          // failures show the softer transient "Couldn't reach origin" tooltip
          // instead, so a single blip doesn't alarm every worktree card.
          authFailed: isAuth && failure.confirmed === true,
          networkFailed: isAuth ? failure.confirmed !== true : true,
        };
      }
      // The backoff window elapsed — fall through and re-attempt the fetch.
      // Auth-class failures auto-retry on a widening schedule rather than
      // suspending the repo's fetch indefinitely.
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
      const git = await createBackgroundFetchGit(opts.worktreePath, {
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
      state.failure = this.classifyForCache(reason, commonDir, state, error);
      const failure = state.failure;
      const isAuth = failure.kind === "auth";
      return {
        status: "failed",
        reason,
        lastFetchedAt: state.lastSuccessfulFetch,
        // Auth-class failures only raise the per-card stripe once confirmed;
        // until then (and for every non-auth failure) the softer transient
        // "Couldn't reach origin" tooltip line carries the signal.
        authFailed: isAuth && failure.confirmed === true,
        networkFailed: isAuth ? failure.confirmed !== true : true,
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
    commonDir: string,
    state: RepoState,
    error: unknown
  ): FetchFailureEntry {
    const now = Date.now();
    if (reason === "auth-failed") {
      return this.buildAuthFailureEntry(reason, commonDir, state, now);
    }
    if (reason === "repository-not-found") {
      // After at least one prior success, a 404 from origin almost always
      // indicates GitHub's "404 instead of 403" permission masking. Treat it
      // on the same auth backoff/confirmation path so we don't hammer retries.
      if (state.lastSuccessfulFetch !== null) {
        return this.buildAuthFailureEntry(reason, commonDir, state, now);
      }
      return {
        kind: "repo-not-found-first",
        reason,
        retryAt: now + REPO_NOT_FOUND_FIRST_FETCH_TTL_MS,
      };
    }
    if (reason === "rate-limited") {
      // Forge secondary rate limits clear on their own; back off a long while
      // (not the short network window) so retrying doesn't extend the limit.
      // Bucketed as "transient" so OS-wake / reconnect `clearNetworkFailures()`
      // also drops it — a fresh session shouldn't stay throttled.
      return {
        kind: "transient",
        reason,
        retryAt: now + RATE_LIMIT_FAILURE_TTL_MS + Math.random() * RATE_LIMIT_FAILURE_JITTER_MS,
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

  /**
   * Build (or advance) the auth-class failure entry. Increments the consecutive
   * retry count off the prior auth entry, schedules the next attempt on the
   * exponential backoff ladder, and marks the failure `confirmed` once it
   * persists past the threshold — firing `onAuthFailureConfirmed` exactly once
   * on the unconfirmed→confirmed transition.
   */
  private buildAuthFailureEntry(
    reason: GitOperationReason,
    commonDir: string,
    state: RepoState,
    now: number
  ): FetchFailureEntry {
    const prior = state.failure?.kind === "auth" ? state.failure : null;
    const authRetryCount = (prior?.authRetryCount ?? 0) + 1;
    const stepIndex = Math.min(authRetryCount - 1, AUTH_FAILURE_BACKOFF_SCHEDULE_MS.length - 1);
    const confirmed = authRetryCount >= AUTH_FAILURE_CONFIRM_RETRIES;
    const wasConfirmed = prior?.confirmed === true;
    if (confirmed && !wasConfirmed) {
      // Notify on the transition only. Wrapped defensively — a throwing
      // observer must not abort building the failure entry below.
      try {
        this.callbacks.onAuthFailureConfirmed?.(commonDir, reason);
      } catch {
        // Observer threw — swallow; the failure cache must stay consistent.
      }
    }
    return {
      kind: "auth",
      reason,
      retryAt: now + AUTH_FAILURE_BACKOFF_SCHEDULE_MS[stepIndex],
      authRetryCount,
      confirmed,
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
