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

export interface FetchSchedulerHost {
  readonly isRunning: boolean;
  readonly isCurrent: boolean;
  readonly hasInitialStatus: boolean;
  readonly hasFetchCallback: boolean;
  /**
   * Execute the actual fetch through the coordinator. Resolves regardless of
   * outcome — errors are classified by the coordinator and don't block local
   * status updates. `force` bypasses the per-repo failure cache (used by wake
   * and auth-rotation hooks).
   */
  onExecuteFetch(force: boolean): Promise<void> | void;
  /**
   * Re-emit a snapshot so the renderer reflects the in-flight transition.
   * Called twice per fetch: once when the in-flight promise is created, again
   * when it resolves.
   */
  onUpdate(): void;
}

export class FetchScheduler {
  private fetchTimer: NodeJS.Timeout | null = null;
  private _pendingFetchPromise: Promise<void> | null = null;
  /**
   * When `triggerNow()` is called while a non-force fetch is in-flight, we
   * can't drop the force request — wake / auth-rotation hooks rely on it
   * bypassing the failure cache. Defer it: set this flag, let the in-flight
   * call complete, then run a forced fetch in the post-pending hook.
   */
  private _pendingForceFetch = false;
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

  /** Force an immediate fetch, bypassing the per-repo failure cache. */
  triggerNow(): Promise<void> {
    return this.run(true);
  }

  clearTimer(): void {
    if (this.fetchTimer) {
      clearTimeout(this.fetchTimer);
      this.fetchTimer = null;
    }
  }

  private async run(force: boolean): Promise<void> {
    if (this.disposed || !this.host.isRunning) return;
    if (!this.host.hasFetchCallback) return;
    if (this._pendingFetchPromise) {
      // A fetch is already in-flight. Drop non-force duplicates, but defer a
      // force request so wake / auth-rotation can still bypass the failure
      // cache once the current fetch lands.
      if (force) {
        this._pendingForceFetch = true;
        await this._pendingFetchPromise;
      }
      return;
    }

    const run = Promise.resolve(this.host.onExecuteFetch(force))
      .catch(() => {
        // Coordinator handles classification; scheduler doesn't surface
        // fetch errors directly — they don't block local-status updates.
      })
      .finally(() => {
        this._pendingFetchPromise = null;
        const queuedForce = this._pendingForceFetch;
        this._pendingForceFetch = false;
        // Emit so `isFetchInFlight` flips back to false on the renderer.
        // `WorkspaceService` will follow up with the freshly-resolved
        // `lastFetchedAt`/`fetchAuthFailed` via `setFetchState`, which emits
        // again only if those values changed.
        if (this.host.hasInitialStatus) {
          this.host.onUpdate();
        }
        if (!this.disposed && this.host.isRunning) {
          if (queuedForce) {
            void this.run(true);
          } else {
            this.schedule(false);
          }
        }
      });
    this._pendingFetchPromise = run;
    // Surface the in-flight transition immediately so the card pulses while
    // git is talking to the remote, without waiting for a status poll.
    if (this.host.hasInitialStatus) {
      this.host.onUpdate();
    }
    await run;
  }
}
