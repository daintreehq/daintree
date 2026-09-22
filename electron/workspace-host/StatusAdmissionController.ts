/**
 * Rate budget for watcher-driven git-status passes while nobody is looking.
 *
 * Watcher flushes call `updateGitStatus` directly rather than through
 * `pollQueue` — deliberately, because a single save must reach the sidebar
 * without waiting behind anyone. That path has no ceiling of its own: the
 * queue's concurrency bounds how many passes run *at once*, never how many
 * start per second, so N worktrees under sustained agent writes can spawn git
 * as fast as their debounces flush.
 *
 * While the app is focused that is the behaviour we want. While it is merely
 * visible, this admits the same requests at a bounded rate and keeps one
 * pending request per worktree, so a storm across twenty worktrees costs a
 * predictable trickle instead of a fork per flush. Nothing is dropped: a
 * coalesced request runs when a token frees, and every request is admitted
 * immediately the moment attenuation lifts.
 */

/** Tokens available per {@link REFILL_INTERVAL_MS}, and the burst ceiling. */
const ADMISSIONS_PER_INTERVAL = 3;
const REFILL_INTERVAL_MS = 5_000;

export class StatusAdmissionController {
  private attenuated = false;
  private tokens = ADMISSIONS_PER_INTERVAL;
  private lastRefillAt = Date.now();
  private drainTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  /** One pending request per worktree; a later one replaces its predecessor. */
  private readonly pending = new Map<string, () => void>();

  constructor(private readonly now: () => number = Date.now) {
    this.lastRefillAt = this.now();
  }

  setAttenuated(attenuated: boolean): void {
    if (this.attenuated === attenuated) return;
    this.attenuated = attenuated;
    // Lifting attenuation is the user coming back. Everything parked runs now,
    // ahead of any timer, so the first thing they see is current.
    if (!attenuated) this.flushPending();
  }

  /**
   * Run `request` for `key`, now or as soon as the budget allows. Unattenuated
   * requests are never delayed.
   */
  request(key: string, run: () => void): void {
    if (this.disposed) return;
    if (!this.attenuated) {
      run();
      return;
    }
    this.pending.set(key, run);
    this.drain();
  }

  /** Forget a worktree's parked request — it is going away. */
  cancel(key: string): void {
    this.pending.delete(key);
    if (this.pending.size === 0) this.clearDrainTimer();
  }

  dispose(): void {
    this.disposed = true;
    this.pending.clear();
    this.clearDrainTimer();
  }

  private refill(): void {
    const now = this.now();
    const elapsed = now - this.lastRefillAt;
    if (elapsed < REFILL_INTERVAL_MS) return;
    const intervals = Math.floor(elapsed / REFILL_INTERVAL_MS);
    this.tokens = Math.min(
      ADMISSIONS_PER_INTERVAL,
      this.tokens + intervals * ADMISSIONS_PER_INTERVAL
    );
    this.lastRefillAt += intervals * REFILL_INTERVAL_MS;
  }

  private drain(): void {
    if (this.disposed) return;
    this.refill();
    while (this.tokens > 0 && this.pending.size > 0) {
      // Map iteration order is insertion order, so the worktree that has been
      // waiting longest goes first and nothing can be starved by a noisy peer.
      const [key, run] = this.pending.entries().next().value as [string, () => void];
      this.pending.delete(key);
      this.tokens -= 1;
      run();
    }
    if (this.pending.size > 0) this.armDrainTimer();
    else this.clearDrainTimer();
  }

  private flushPending(): void {
    const parked = [...this.pending.values()];
    this.pending.clear();
    this.clearDrainTimer();
    for (const run of parked) run();
  }

  private armDrainTimer(): void {
    if (this.drainTimer) return;
    const waitMs = Math.max(0, REFILL_INTERVAL_MS - (this.now() - this.lastRefillAt));
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.drain();
    }, waitMs);
    this.drainTimer.unref?.();
  }

  private clearDrainTimer(): void {
    if (!this.drainTimer) return;
    clearTimeout(this.drainTimer);
    this.drainTimer = null;
  }
}
