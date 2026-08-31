import type { WorkspaceFetchResult } from "../../shared/types/workspace-host.js";

// Background fetch cadence — independent from the local-status poll. Focused
// (current) worktrees fetch frequently so ahead/behind counts stay fresh while
// the user is looking at them; everything else falls back to a low-rate
// background tier to avoid hammering remotes for repos the user isn't viewing.
// Jitter is applied at the call site to avoid thundering-herd alignment when
// multiple worktrees were started together.
// Defaults match the "balanced" ResourceProfileConfig values.
const FETCH_INTERVAL_FOCUSED_DEFAULT_MS = 30_000;
const FETCH_INTERVAL_BACKGROUND_DEFAULT_MS = 5 * 60_000;
// Jitter fraction applied around the base interval to spread fetch alignment.
const FETCH_JITTER_FRACTION = 0.25;
// Initial fetch fires shortly after start so users don't wait a full cadence
// window for fresh ahead/behind on app launch.
const FETCH_INITIAL_DELAY_MIN_MS = 2_000;
const FETCH_INITIAL_DELAY_MAX_MS = 5_000;

function randomBetween(minMs: number, maxMs: number): number {
  if (maxMs <= minMs) return minMs;
  return minMs + Math.floor(Math.random() * (maxMs - minMs));
}

/**
 * Coalesce two queued prune requests into the stronger one. `undefined` means
 * "coordinator default", which prunes — so only two explicit `false`s produce a
 * non-pruning run.
 */
function widenPrune(a: boolean | undefined, b: boolean | undefined): boolean {
  return a !== false || b !== false;
}

export interface FetchSchedulerHost {
  readonly isRunning: boolean;
  readonly isCurrent: boolean;
  readonly hasInitialStatus: boolean;
  readonly hasFetchCallback: boolean;
  /**
   * Execute the actual fetch through the coordinator. Resolves regardless of
   * outcome — errors are classified by the coordinator and don't block local
   * status updates. `force` bypasses the per-repo failure cache (used by wake
   * and auth-rotation hooks). `prune` is undefined on every scheduled path,
   * which the coordinator reads as "prune" — the pre-#12091 behavior.
   *
   * The resolved value is the primary remote's result, which the user-triggered
   * path reports back to the renderer. Scheduled callers ignore it.
   */
  onExecuteFetch(
    force: boolean,
    prune?: boolean
  ): Promise<WorkspaceFetchResult | void> | WorkspaceFetchResult | void;
  /**
   * Re-emit a snapshot so the renderer reflects the in-flight transition.
   * Called twice per fetch: once when the in-flight promise is created, again
   * when it resolves.
   */
  onUpdate(): void;
}

export class FetchScheduler {
  private fetchTimer: NodeJS.Timeout | null = null;
  private _pendingFetchPromise: Promise<unknown> | null = null;
  /**
   * When `triggerNow()` is called while a non-force fetch is in-flight, we
   * can't drop the force request — wake / auth-rotation hooks rely on it
   * bypassing the failure cache. Defer it: park the request here, let the
   * in-flight call complete, then run a forced fetch in the post-pending hook.
   *
   * Held as a deferred promise rather than a bare flag so `triggerNow()`
   * resolves with the result of the fetch it actually asked for. With a flag,
   * awaiting the *in-flight* promise resolved before the deferred fetch had
   * run, so a caller reporting the outcome to the user reported the previous
   * fetch's (#12091). Concurrent deferred requests coalesce onto one run and
   * `prune` widens to the strongest request — a queued "Fetch and prune" is
   * not satisfied by a queued plain "Fetch".
   */
  private _pendingForceFetch: {
    prune: boolean | undefined;
    promise: Promise<WorkspaceFetchResult | void>;
    resolve: (value: WorkspaceFetchResult | void) => void;
  } | null = null;
  private disposed = false;

  private focusedIntervalMs = FETCH_INTERVAL_FOCUSED_DEFAULT_MS;
  private backgroundIntervalMs = FETCH_INTERVAL_BACKGROUND_DEFAULT_MS;

  constructor(private readonly host: FetchSchedulerHost) {}

  get isFetchInFlight(): boolean {
    return this._pendingFetchPromise !== null;
  }

  /** Update fetch cadence intervals (called from WorktreeMonitor.updateConfig). */
  updateIntervals(activeMs?: number, backgroundMs?: number): void {
    let changed = false;
    if (activeMs !== undefined && this.focusedIntervalMs !== activeMs) {
      this.focusedIntervalMs = activeMs;
      changed = true;
    }
    if (backgroundMs !== undefined && this.backgroundIntervalMs !== backgroundMs) {
      this.backgroundIntervalMs = backgroundMs;
      changed = true;
    }
    // Re-arm with new cadence if a timer is already pending.
    if (changed) {
      this.reschedule(false);
    }
  }

  /**
   * Schedule the next fetch. Idempotent — no-op if a timer is already armed.
   * `initial=true` uses the short startup-tier delay (2-5s) regardless of
   * focus, so focus-flips and resumes get fresh counts quickly.
   */
  schedule(initial: boolean = false): void {
    if (this.disposed) return;
    if (!this.host.isRunning) return;
    if (!this.host.hasFetchCallback) return;
    if (this.fetchTimer) return;

    const delay = initial
      ? randomBetween(FETCH_INITIAL_DELAY_MIN_MS, FETCH_INITIAL_DELAY_MAX_MS)
      : this.pickInterval();

    this.fetchTimer = setTimeout(() => {
      this.fetchTimer = null;
      if (this.disposed || !this.host.isRunning) return;
      void this.run(false);
    }, delay);
  }

  private pickInterval(): number {
    const base = this.host.isCurrent ? this.focusedIntervalMs : this.backgroundIntervalMs;
    const jitterRange = Math.floor(base * FETCH_JITTER_FRACTION);
    const minMs = Math.max(1000, base - jitterRange);
    const maxMs = Math.max(minMs + 1000, base + jitterRange);
    return randomBetween(minMs, maxMs);
  }

  /** Clear the timer and re-arm — used by the focus-change setter. */
  reschedule(initial: boolean = false): void {
    this.clearTimer();
    this.schedule(initial);
  }

  /**
   * Force an immediate fetch, bypassing the per-repo failure cache. Resolves
   * with the primary remote's result, or `undefined` when the scheduler
   * declined to run one at all (disposed, stopped, no callback).
   */
  triggerNow(prune?: boolean): Promise<WorkspaceFetchResult | void> {
    return this.run(true, prune);
  }

  clearTimer(): void {
    if (this.fetchTimer) {
      clearTimeout(this.fetchTimer);
      this.fetchTimer = null;
    }
  }

  private async run(force: boolean, prune?: boolean): Promise<WorkspaceFetchResult | void> {
    if (this.disposed || !this.host.isRunning) return;
    if (!this.host.hasFetchCallback) return;
    if (this._pendingFetchPromise) {
      // A fetch is already in-flight. Drop non-force duplicates, but defer a
      // force request so wake / auth-rotation can still bypass the failure
      // cache once the current fetch lands.
      if (!force) return;
      return await this.queueForceFetch(prune);
    }

    const run = Promise.resolve(this.host.onExecuteFetch(force, prune))
      .catch(() => {
        // Coordinator handles classification; scheduler doesn't surface
        // fetch errors directly — they don't block local-status updates.
      })
      .finally(() => {
        this._pendingFetchPromise = null;
        const queued = this._pendingForceFetch;
        this._pendingForceFetch = null;
        // Emit so `isFetchInFlight` flips back to false on the renderer.
        // `WorkspaceService` will follow up with the freshly-resolved
        // `lastFetchedAt`/`fetchAuthFailed` via `setFetchState`, which emits
        // again only if those values changed.
        //
        // Isolated: this is a synchronous observer reaching arbitrary listeners
        // (`sys:worktree:update`). Letting it throw past this point would strand
        // a queued request on a promise nothing can now resolve AND leave the
        // cadence timer un-armed, so one bad listener would stop background
        // fetching for the rest of the session.
        this.emitUpdate();
        if (queued) {
          // A queued request must settle even when the scheduler has since
          // stopped, or its caller waits forever. `run` returns undefined on a
          // stopped scheduler, which is exactly the "declined" signal.
          void this.run(true, queued.prune).then(queued.resolve, () => queued.resolve());
        } else if (!this.disposed && this.host.isRunning) {
          this.schedule(false);
        }
      });
    this._pendingFetchPromise = run;
    // Surface the in-flight transition immediately so the card pulses while
    // git is talking to the remote, without waiting for a status poll. Isolated
    // for the same reason as the completion emit below — and this one is the
    // sharper edge: a throw here escapes `run()` itself, which the scheduled
    // path calls as `void this.run(false)`, so one bad listener becomes an
    // unhandled rejection AND leaves the fetch un-awaited.
    this.emitUpdate();
    return await run;
  }

  /**
   * Emit a snapshot, absorbing anything the observer throws.
   *
   * `onUpdate` reaches arbitrary `sys:worktree:update` listeners. A throw that
   * escaped would either surface as an unhandled rejection on the scheduled
   * path or, from the completion hook, strand a queued request on a promise
   * nothing can resolve and leave the cadence timer un-armed — one bad listener
   * would stop background fetching for the rest of the session.
   */
  private emitUpdate(): void {
    if (!this.host.hasInitialStatus) return;
    try {
      this.host.onUpdate();
    } catch {
      // The observer's problem, not the scheduler's.
    }
  }

  /**
   * Park a forced request behind the in-flight fetch. Repeat callers share one
   * deferred run; `prune` widens to the strongest request so a queued
   * "Fetch and prune" is never satisfied by a queued plain "Fetch".
   */
  private queueForceFetch(prune: boolean | undefined): Promise<WorkspaceFetchResult | void> {
    const existing = this._pendingForceFetch;
    if (existing) {
      existing.prune = widenPrune(existing.prune, prune);
      return existing.promise;
    }
    let resolve!: (value: WorkspaceFetchResult | void) => void;
    const promise = new Promise<WorkspaceFetchResult | void>((res) => {
      resolve = res;
    });
    this._pendingForceFetch = { prune, promise, resolve };
    return promise;
  }
}
