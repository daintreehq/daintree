import { createBackgroundFetchGit } from "../utils/hardenedGit.js";
import { getGitCommonDir } from "../utils/gitUtils.js";
import { classifyGitError } from "../../shared/utils/gitOperationErrors.js";
import type { GitOperationReason } from "../../shared/types/ipc/errors.js";
import type { WorkspaceFetchResult } from "../../shared/types/workspace-host.js";

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

/**
 * Recency and failure state for one (commondir, remote) pair.
 *
 * Deliberately NOT per-commondir: once a repo fetches more than one remote, a
 * shared entry lets a broken credential on one remote suspend fetches of a
 * perfectly healthy sibling, and lets two remotes' failures interleave into
 * one `authRetryCount` — which would confirm an auth failure on a single burst
 * instead of across retries over time, re-alarming every card.
 *
 * The serialization chain stays per-commondir (see {@link RepoFetchCoordinator.chains}).
 * The two scopes look symmetric and are not: refs are shared through the
 * commondir, so concurrent fetches race on `packed-refs.lock` no matter which
 * remote each one targets, while credentials and reachability are per-remote.
 */
interface RemoteState {
  failure: FetchFailureEntry | null;
  lastSuccessfulFetch: number | null;
  /**
   * Whether the fetch behind {@link lastSuccessfulFetch} passed `--prune`.
   * The recency window is a superset test, not an equality one: a pruned
   * success covers a later plain fetch, but a plain success must NOT satisfy a
   * prune request or "Fetch and prune" clicked seconds after "Fetch" would
   * silently never prune.
   */
  lastSuccessfulFetchPruned: boolean;
  /** Bumped when the repo's monitors are torn down so stale completions discard. */
  generation: number;
}

/** The remote assumed when a caller names none — matches the pre-#11747 behavior. */
const DEFAULT_REMOTE = "origin";

/**
 * Control character, so it can't collide with a path or a remote name (git
 * forbids control characters in both).
 */
const STATE_KEY_DELIMITER = "\u0000";

function stateKey(commonDir: string, remote: string): string {
  return `${commonDir}${STATE_KEY_DELIMITER}${remote}`;
}

/** `prune` defaults to on — see {@link FetchOptions.prune}. */
function prunesRefs(opts: FetchOptions): boolean {
  return opts.prune !== false;
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
  onAuthFailureConfirmed?: (commonDir: string, remote: string, reason: GitOperationReason) => void;
}

export interface FetchOptions {
  worktreeId: string;
  worktreePath: string;
  /** When true, ignore the failure cache (manual user-triggered refresh). */
  force?: boolean;
  /**
   * Remotes to refresh, in any order. Deduped internally, and `primaryRemote`
   * is always fetched first. Defaults to `[origin]`, which is what every
   * single-remote repo resolves to — so the common case still issues exactly
   * one `git fetch`, unchanged from before #11747.
   *
   * Never expanded to `--all`: a mirror or a slow deploy remote would land on
   * the poll loop, and `--all` also collapses per-remote failure isolation
   * back into one opaque exit code.
   */
  remotes?: readonly string[];
  /**
   * The remote whose outcome describes this worktree — the one the divergence
   * counts are actually measured against. Its result is what
   * {@link RepoFetchCoordinator.fetchForWorktree} returns and what the card
   * renders, because an auxiliary remote succeeding says nothing about whether
   * the numbers on screen are fresh. Defaults to the first entry of
   * `remotes`.
   */
  primaryRemote?: string;
  /**
   * Pass `--prune`, deleting remote-tracking refs for branches gone from the
   * remote. Defaults to `true`: every scheduled, wake, and auth-retry fetch has
   * pruned since #6564, and dropping that would let `refs/remotes/` accumulate
   * dead branches in a worktree-heavy repo. Only the explicit "Fetch" menu row
   * passes `false`, which is the whole reason this is an option rather than a
   * constant (#12091).
   */
  prune?: boolean;
}

/**
 * Result of one coordinator fetch. Defined in `shared/types/workspace-host.ts`
 * because a manual fetch's outcome crosses the workspace-host boundary back to
 * the main process (#12091); aliased here so every existing reference keeps its
 * local name.
 */
export type FetchResult = WorkspaceFetchResult;

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
 *   - A repo may need more than one remote refreshed — a fork whose base
 *     branch lives on `upstream` reads refs `origin` never carries (#11747).
 *     Serialization stays per-commondir because the `packed-refs.lock` race
 *     doesn't care which remote is being fetched; recency and failure state go
 *     per-(commondir, remote) because credentials and reachability very much
 *     do. The two scopes look symmetric and need opposite keying.
 */ export class RepoFetchCoordinator {
  /**
   * Recency and failure state, keyed by (commondir, remote) — see
   * {@link RemoteState} for why this dimension is not shared with the chain.
   */
  private readonly states = new Map<string, RemoteState>();
  /**
   * In-flight chain per commondir. Every fetch awaits the prior one for the
   * same repo regardless of which remote it targets, because `packed-refs` is
   * shared through the commondir and does not care whose refs are being
   * written.
   */
  private readonly chains = new Map<string, Promise<void>>();
  /**
   * Coordinator-wide generation baseline. Bumped by `destroy()` so any new
   * `RemoteState` created after a project switch (e.g. when reopening the same
   * repo path on a fresh project) starts at a higher generation than any
   * still-in-flight pre-destroy fetch. Without this, a stale completion that
   * captured `generationAtStart=0` could pass the guard against a fresh
   * `state.generation=0` and corrupt the new project's failure cache.
   */
  private baseGeneration = 0;

  constructor(private readonly callbacks: RepoFetchCoordinatorCallbacks = {}) {}

  /**
   * Schedule a fetch for the given worktree. Resolves with the status of the
   * primary remote — the one whose freshness the worktree's counts depend on.
   * Multiple worktrees that share a `git common-dir` are serialized on a
   * single per-repo promise chain, as are the remotes within one call.
   */
  async fetchForWorktree(opts: FetchOptions): Promise<FetchResult> {
    const baseGenerationAtStart = this.baseGeneration;
    const commonDir = await getGitCommonDir(opts.worktreePath, { logErrors: false });
    if (!commonDir) {
      return { status: "skipped", skipReason: "no-common-dir" };
    }
    if (this.baseGeneration !== baseGenerationAtStart) {
      // destroy() ran while the commondir resolved. Creating state now would
      // repopulate the cleared map at the fresh generation, letting this
      // stale continuation dodge runFetch's stale-generation guard.
      return { status: "skipped", skipReason: "stale-generation" };
    }

    const remotes = this.planRemotes(opts);
    const primary = remotes[0]!;

    // Pre-chain triage: a remote inside its backoff window or covered by a
    // recent success is answered without queueing at all, so a burst of
    // sibling polls collapses instead of stacking chain links.
    const settled = new Map<string, FetchResult>();
    const pending: string[] = [];
    for (const remote of remotes) {
      const state = this.getOrCreateState(commonDir, remote);
      if (!opts.force) {
        const skip = this.failureSkipResult(state, remote);
        // Inside the backoff window we skip; once it elapses, fall through and
        // re-attempt. Auth-class failures auto-retry on a widening schedule
        // rather than suspending the repo's fetch indefinitely.
        if (skip) {
          settled.set(remote, skip);
          continue;
        }
      }
      const recent = this.recentSuccessResult(state, opts.force === true, remote, prunesRefs(opts));
      if (recent) {
        settled.set(remote, recent);
        continue;
      }
      pending.push(remote);
    }

    if (pending.length > 0) {
      const generations = new Map(
        pending.map((remote) => [remote, this.getOrCreateState(commonDir, remote).generation])
      );
      const chain = this.chains.get(commonDir) ?? Promise.resolve();
      const batch = chain.then(() => this.runBatch(commonDir, pending, generations, opts));
      this.chains.set(
        commonDir,
        batch.then(
          () => undefined,
          () => undefined
        )
      );
      for (const [remote, result] of await batch) {
        settled.set(remote, result);
      }
    }

    const primaryResult = settled.get(primary) ?? {
      status: "skipped" as const,
      skipReason: "stale-generation" as const,
      remote: primary,
    };
    const auxiliaryFailed = remotes.some(
      (remote) => remote !== primary && settled.get(remote)?.status === "failed"
    );
    return auxiliaryFailed ? { ...primaryResult, auxiliaryFailed } : primaryResult;
  }

  /**
   * The deduped remote list for one call, primary first. Fetch order matters:
   * the primary's result is what the card renders, so it should not sit behind
   * a slow auxiliary remote's 60s timeout.
   */
  private planRemotes(opts: FetchOptions): string[] {
    const requested = (opts.remotes ?? []).filter(
      (remote) => typeof remote === "string" && remote.length > 0
    );
    const primary =
      opts.primaryRemote && opts.primaryRemote.length > 0
        ? opts.primaryRemote
        : (requested[0] ?? DEFAULT_REMOTE);
    const ordered = [primary];
    for (const remote of requested) {
      if (!ordered.includes(remote)) ordered.push(remote);
    }
    return ordered;
  }

  /**
   * Fetch each pending remote in turn on the caller's chain link. Sequential
   * rather than concurrent: they share `packed-refs`, which is the same reason
   * sibling worktrees serialize. A failure on one remote does not stop the
   * others — that isolation is the point of the per-remote state.
   */
  private async runBatch(
    commonDir: string,
    remotes: readonly string[],
    generations: ReadonlyMap<string, number>,
    opts: FetchOptions
  ): Promise<Map<string, FetchResult>> {
    const results = new Map<string, FetchResult>();
    let anyFetched = false;
    for (const remote of remotes) {
      const generationAtStart = generations.get(remote) ?? this.baseGeneration;
      const { result, fetched } = await this.runFetch(commonDir, remote, generationAtStart, opts);
      results.set(remote, result);
      // `fetched`, not `status === "success"`: the post-chain recency check
      // also reports success, and firing the observer for a sibling that
      // merely reused another's refs would refresh every card N times per
      // scheduled poll.
      if (fetched) anyFetched = true;
    }
    // One notification per batch, not per remote: the observer refreshes the
    // worktree's status, and doing that N times for one scheduled poll is
    // wasted work. Fired outside runFetch so a throwing observer can't poison
    // any remote's failure cache.
    if (anyFetched) {
      try {
        this.callbacks.onFetchSuccess?.(opts.worktreeId);
      } catch {
        // Observer threw — silently swallow; the fetches themselves succeeded.
      }
    }
    return results;
  }

  /**
   * Drop network-class failures so the next fetch attempt is allowed
   * immediately. Called on OS wake / network reconnect. Applies across every
   * remote — a reconnect restores all of them at once.
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
   * GitHub credentials so previously-failing repos can fetch again. Applies
   * across every remote: a credential refresh is not remote-specific, and
   * leaving a sibling remote suspended would make the retry look ineffective.
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
    this.chains.clear();
    this.baseGeneration += 1;
  }

  /**
   * Test/diagnostic accessor. With no `remote`, reports whether ANY remote of
   * the repo is in a failure window.
   */
  hasFailureFor(commonDir: string, remote?: string): boolean {
    if (remote !== undefined) {
      return this.states.get(stateKey(commonDir, remote))?.failure != null;
    }
    const prefix = `${commonDir}${STATE_KEY_DELIMITER}`;
    for (const [key, state] of this.states) {
      if (key.startsWith(prefix) && state.failure != null) return true;
    }
    return false;
  }

  /**
   * Test/diagnostic accessor. Scoped to one remote — a repo-wide maximum would
   * report a freshness the primary remote may not have.
   */
  getLastSuccessfulFetch(commonDir: string, remote: string = DEFAULT_REMOTE): number | null {
    return this.states.get(stateKey(commonDir, remote))?.lastSuccessfulFetch ?? null;
  }

  /**
   * Success result reusing the last fetch when it landed within the recency
   * window — `null` when a real fetch is needed. Never applies over a cached
   * failure so failure surfacing keeps today's semantics. A negative elapsed
   * (clock moved backwards) also forces a real fetch.
   */
  private recentSuccessResult(
    state: RemoteState,
    force: boolean,
    remote: string,
    prune: boolean
  ): FetchResult | null {
    if (state.failure || state.lastSuccessfulFetch === null) return null;
    // A prune request the cached success didn't prune for is a different
    // operation, not a duplicate of it — reusing it would drop the prune.
    if (prune && !state.lastSuccessfulFetchPruned) return null;
    const window = force ? FORCE_FETCH_RECENCY_WINDOW_MS : FETCH_RECENCY_WINDOW_MS;
    const elapsed = Date.now() - state.lastSuccessfulFetch;
    if (elapsed < 0 || elapsed >= window) return null;
    return {
      status: "success",
      lastFetchedAt: state.lastSuccessfulFetch,
      authFailed: false,
      networkFailed: false,
      remote,
    };
  }

  /**
   * Skip result for a remote still inside its failure backoff window — `null`
   * once the window elapses (so the caller re-attempts the fetch). Shared by
   * the pre-queue check and the post-chain re-check so a burst of sibling
   * fetches that all queue before the first failure lands still collapses to a
   * single git invocation once that failure is cached.
   */
  private failureSkipResult(state: RemoteState, remote: string): FetchResult | null {
    const failure = state.failure;
    if (!failure || Date.now() >= failure.retryAt) return null;
    const isAuth = failure.kind === "auth";
    return {
      status: "skipped",
      skipReason: isAuth ? "auth-suspended" : "in-failure-window",
      reason: failure.reason,
      lastFetchedAt: state.lastSuccessfulFetch,
      // Only surface the per-card auth stripe once the failure is confirmed
      // (several retries exhausted). Pre-confirmation auth failures show the
      // softer transient "Couldn't reach the remote" tooltip instead, so a
      // single blip doesn't alarm every worktree card.
      authFailed: isAuth && failure.confirmed === true,
      networkFailed: isAuth ? failure.confirmed !== true : true,
      remote,
    };
  }

  private getOrCreateState(commonDir: string, remote: string): RemoteState {
    const key = stateKey(commonDir, remote);
    let state = this.states.get(key);
    if (!state) {
      state = {
        failure: null,
        lastSuccessfulFetch: null,
        lastSuccessfulFetchPruned: false,
        generation: this.baseGeneration,
      };
      this.states.set(key, state);
    }
    return state;
  }

  /**
   * Run one remote's fetch. `fetched` distinguishes a git invocation that
   * actually landed from a result reused off another sibling's — only the
   * former should notify observers.
   */
  private async runFetch(
    commonDir: string,
    remote: string,
    generationAtStart: number,
    opts: FetchOptions
  ): Promise<{ result: FetchResult; fetched: boolean }> {
    const key = stateKey(commonDir, remote);
    const stateAtStart = this.states.get(key);
    if (!stateAtStart || stateAtStart.generation !== generationAtStart) {
      return {
        result: { status: "skipped", skipReason: "stale-generation", remote },
        fetched: false,
      };
    }
    // Re-check recency after waiting on the chain — back-to-back sibling
    // fetches (wake storm, auth retry) all queue before the first completes,
    // so the dedup has to look at the timestamp the prior link just wrote.
    const recent = this.recentSuccessResult(
      stateAtStart,
      opts.force === true,
      remote,
      prunesRefs(opts)
    );
    if (recent) {
      return { result: recent, fetched: false };
    }
    // Same dedup for failures: once the first sibling in a burst caches a
    // failure, the rest skip instead of each spawning another git fetch (and
    // re-incrementing the auth retry count). Force fetches still bypass this —
    // their same-window failures are coalesced in `buildAuthFailureEntry`.
    if (opts.force !== true) {
      const skip = this.failureSkipResult(stateAtStart, remote);
      if (skip) return { result: skip, fetched: false };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_ABORT_TIMEOUT_MS);
    try {
      const git = await createBackgroundFetchGit(opts.worktreePath, {
        signal: controller.signal,
      });
      // --no-write-fetch-head: skip writing FETCH_HEAD on background fetches
      // so concurrent foreground operations (status polls, user pushes) don't
      // contend on the same file. Requires Git ≥ 2.29 — all supported platforms
      // ship ≥ 2.34, so no version guard is needed.
      const prune = prunesRefs(opts);
      // `--no-prune`, not merely omitting `--prune`: `fetch.prune=true` or
      // `remote.<name>.prune=true` in the user's git config would otherwise
      // prune anyway, and the whole point of the "Fetch" row is that it does
      // not delete refs. The flag has to be explicit in BOTH directions or the
      // choice the menu offers isn't one.
      await git.raw([
        "fetch",
        remote,
        "--no-auto-gc",
        prune ? "--prune" : "--no-prune",
        "--no-write-fetch-head",
      ]);

      const state = this.states.get(key);
      if (!state || state.generation !== generationAtStart) {
        return {
          result: { status: "skipped", skipReason: "stale-generation", remote },
          fetched: false,
        };
      }
      state.failure = null;
      state.lastSuccessfulFetch = Date.now();
      state.lastSuccessfulFetchPruned = prune;
      return {
        result: {
          status: "success",
          lastFetchedAt: state.lastSuccessfulFetch,
          authFailed: false,
          networkFailed: false,
          remote,
        },
        fetched: true,
      };
    } catch (error) {
      const reason = classifyGitError(error);
      const state = this.states.get(key);
      if (!state || state.generation !== generationAtStart) {
        return {
          result: { status: "skipped", skipReason: "stale-generation", remote },
          fetched: false,
        };
      }
      state.failure = this.classifyForCache(reason, commonDir, remote, state, error);
      const failure = state.failure;
      const isAuth = failure.kind === "auth";
      return {
        result: {
          status: "failed",
          reason,
          lastFetchedAt: state.lastSuccessfulFetch,
          // Auth-class failures only raise the per-card stripe once confirmed;
          // until then (and for every non-auth failure) the softer transient
          // "Couldn't reach the remote" tooltip line carries the signal.
          authFailed: isAuth && failure.confirmed === true,
          networkFailed: isAuth ? failure.confirmed !== true : true,
          remote,
        },
        fetched: false,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private classifyForCache(
    reason: GitOperationReason,
    commonDir: string,
    remote: string,
    state: RemoteState,
    error: unknown
  ): FetchFailureEntry {
    const now = Date.now();
    if (reason === "auth-failed") {
      return this.buildAuthFailureEntry(reason, commonDir, remote, state, now);
    }
    if (reason === "repository-not-found") {
      // After at least one prior success, a 404 from this remote almost always
      // indicates GitHub's "404 instead of 403" permission masking. Treat it
      // on the same auth backoff/confirmation path so we don't hammer retries.
      if (state.lastSuccessfulFetch !== null) {
        return this.buildAuthFailureEntry(reason, commonDir, remote, state, now);
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
   *
   * `state` is the per-(commondir, remote) entry, so the retry count advances
   * per remote. Sharing it across remotes would let two independent failures
   * confirm each other, which is the same "fake confirmation threshold" bug
   * the same-window coalescing below exists to prevent.
   */
  private buildAuthFailureEntry(
    reason: GitOperationReason,
    commonDir: string,
    remote: string,
    state: RemoteState,
    now: number
  ): FetchFailureEntry {
    const prior = state.failure?.kind === "auth" ? state.failure : null;
    // A failure observed while the prior backoff window is still open belongs
    // to the SAME retry round — concurrent sibling fetches and force-retries
    // (which bypass the failure-cache skip) all land here within milliseconds.
    // Counting each would confirm the failure on a single burst instead of
    // across retries over time, re-alarming every card. Keep the prior entry
    // unchanged so the count only advances once per elapsed backoff window.
    if (prior && now < prior.retryAt) {
      return prior;
    }
    const authRetryCount = (prior?.authRetryCount ?? 0) + 1;
    const stepIndex = Math.min(authRetryCount - 1, AUTH_FAILURE_BACKOFF_SCHEDULE_MS.length - 1);
    const confirmed = authRetryCount >= AUTH_FAILURE_CONFIRM_RETRIES;
    const wasConfirmed = prior?.confirmed === true;
    if (confirmed && !wasConfirmed) {
      // Notify on the transition only. Wrapped defensively — a throwing
      // observer must not abort building the failure entry below.
      try {
        this.callbacks.onAuthFailureConfirmed?.(commonDir, remote, reason);
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
