import { createBackgroundFetchGit } from "../utils/hardenedGit.js";
import { getGitCommonDir } from "../utils/gitUtils.js";
import { classifyGitError, extractGitErrorMessage } from "../../shared/utils/gitOperationErrors.js";
import type { GitOperationReason } from "../../shared/types/ipc/errors.js";

const FETCH_ABORT_TIMEOUT_MS = 60_000;

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
        };
      }
      if (Date.now() < failure.retryAt) {
        return {
          status: "skipped",
          skipReason: "in-failure-window",
          reason: failure.reason,
        };
      }
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_ABORT_TIMEOUT_MS);
    let succeeded = false;
    try {
      const git = createBackgroundFetchGit(opts.worktreePath, {
        signal: controller.signal,
      });
      await git.raw(["fetch", "origin", "--no-auto-gc", "--prune"]);

      const state = this.states.get(commonDir);
      if (!state || state.generation !== generationAtStart) {
        return { status: "skipped", skipReason: "stale-generation" };
      }
      state.failure = null;
      state.lastSuccessfulFetch = Date.now();
      succeeded = true;
      return { status: "success" };
    } catch (error) {
      const reason = classifyGitError(error);
      const state = this.states.get(commonDir);
      if (!state || state.generation !== generationAtStart) {
        return { status: "skipped", skipReason: "stale-generation" };
      }
      state.failure = this.classifyForCache(reason, state.lastSuccessfulFetch, error);
      return { status: "failed", reason };
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
      const jitter = Math.random() * NETWORK_FAILURE_JITTER_MS;
      return {
        kind: "network",
        reason,
        retryAt: now + NETWORK_FAILURE_TTL_MS + jitter,
      };
    }
    // Aborts (the 60s timeout firing) look like generic errors; bucket them
    // with transient so they retry on a short window.
    if (this.isAbortError(error)) {
      const jitter = Math.random() * TRANSIENT_FAILURE_JITTER_MS;
      return {
        kind: "transient",
        reason,
        retryAt: now + TRANSIENT_FAILURE_TTL_MS + jitter,
      };
    }
    const jitter = Math.random() * TRANSIENT_FAILURE_JITTER_MS;
    return {
      kind: "transient",
      reason,
      retryAt: now + TRANSIENT_FAILURE_TTL_MS + jitter,
    };
  }

  private isAbortError(error: unknown): boolean {
    const msg = extractGitErrorMessage(error);
    return /aborted|operation was aborted|AbortError/i.test(msg);
  }
}
