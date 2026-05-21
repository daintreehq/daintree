import { GitFileWatcher } from "../utils/gitFileWatcher.js";
import { invalidateGitStatusCache } from "../utils/git.js";
import { MutableDisposable, toDisposable, type IDisposable } from "../utils/lifecycle.js";

const GIT_WATCH_SELF_TRIGGER_COOLDOWN_MS = 1000;
const WATCHER_FALLBACK_POLL_INTERVAL_MS = 300_000;
const WATCHER_GIT_ONLY_ACTIVE_POLL_INTERVAL_MS = 60_000;
const WATCHER_RETRY_INTERVAL_MS = 30_000;
const WATCHER_MAX_RETRIES = 5;
const MAX_RESETS_PER_SESSION = 3;
const WATCHER_WORKTREE_MIN_DEBOUNCE_MS = 250;
const WATCHER_WORKTREE_MAX_DEBOUNCE_MS = 800;
const WATCHER_WORKTREE_MAX_WAIT_MS = 1500;
const WATCHER_FOCUS_DOWNGRADE_DELAY_MS = 3_000;

export type WatcherMode = "none" | "git-only" | "recursive";

export interface WatcherControllerHost {
  readonly isRunning: boolean;
  readonly isCurrent: boolean;
  readonly gitWatchEnabled: boolean;
  readonly gitWatchDebounceMs: number;
  readonly worktreeId: string;
  readonly worktreePath: string;
  readonly branch: string | undefined;
  readonly isUpdating: boolean;
  readonly lastGitStatusCompletedAt: number;
  /**
   * Trigger a forced updateGitStatus(true). Invoked when the watcher
   * decides a refresh is warranted (file change observed, debounced flush,
   * or pending-flag drained after an in-flight update completes).
   */
  onTriggerUpdate(): void;
  onInotifyLimitReached(worktreeId: string): void;
  onEmfileLimitReached(worktreeId: string): void;
  /**
   * Fired when a recursive watcher successfully re-arms after a prior
   * degradation (ENOSPC/EMFILE or any runtime failure that forced the
   * git-only fallback). Lets the host reset its one-shot degradation
   * guards and clear the persistent degraded indicator.
   */
  onWatcherRecovered?(): void;
}

/**
 * Manages the git file watcher lifecycle for a single worktree. Tiers
 * granularity by focus state: focused worktrees get the recursive watcher;
 * background worktrees stay on the cheap `.git/`-only watch. Recovers from
 * runtime failures by reconstructing in `git-only` mode and retrying the
 * recursive arm on a backoff. Coordinates self-triggered refreshes via a
 * pending-flag protocol so concurrent updates don't pile up.
 */
export class WatcherController {
  private gitWatcher = new MutableDisposable<IDisposable>();
  private gitWatcherMode: WatcherMode = "none";
  private gitWatchDebounceTimer: NodeJS.Timeout | null = null;
  private gitWatchRefreshPending = false;
  private watcherRetryTimer: NodeJS.Timeout | null = null;
  private watcherRetryCount = 0;
  private retryBudgetResetCount = 0;
  private downgradeTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  /**
   * Set when the watcher drops to the git-only fallback after a recursive
   * failure; cleared when the recursive arm is restored. Drives the
   * `onWatcherRecovered` signal so recovery only fires after a genuine
   * degradation — not on the normal "none" → "recursive" cold start.
   */
  private wasDegraded = false;

  constructor(private readonly host: WatcherControllerHost) {}

  get hasWatcher(): boolean {
    return this.gitWatcher.value !== undefined;
  }

  get currentMode(): WatcherMode {
    return this.gitWatcherMode;
  }

  desiredMode(): "git-only" | "recursive" {
    return this.host.isCurrent ? "recursive" : "git-only";
  }

  /**
   * Poll cadence is mode-aware. Recursive coverage drops the heartbeat to
   * 5min — the watcher catches every working-tree edit, so the timer is
   * just a safety net for OS suspend/wake and rare watcher-ghost cases.
   * Git-only on the active worktree tightens to 60s so mid-edit changes
   * that bypass .git/ are still picked up reasonably; background git-only
   * shares the 5min fallback. No watcher falls back to the supplied
   * adaptive interval.
   */
  pollIntervalMs(adaptiveFallback: () => number): number {
    switch (this.gitWatcherMode) {
      case "recursive":
        return WATCHER_FALLBACK_POLL_INTERVAL_MS;
      case "git-only":
        return this.host.isCurrent
          ? WATCHER_GIT_ONLY_ACTIVE_POLL_INTERVAL_MS
          : WATCHER_FALLBACK_POLL_INTERVAL_MS;
      case "none":
      default:
        return adaptiveFallback();
    }
  }

  /**
   * Start the git file watcher. The mode is tiered by `host.isCurrent`:
   * focused worktrees get the recursive watcher; background worktrees get
   * only the cheap .git/ watchers. On recursive failure (e.g. ENOSPC at
   * startup), the per-file .git/ watchers are preserved by immediately
   * reconstructing in "git-only" mode.
   */
  start(mode: "git-only" | "recursive" = this.desiredMode()): void {
    if (this.disposed) return;
    if (!this.host.isRunning || !this.host.gitWatchEnabled || this.gitWatcher.value) {
      return;
    }

    const watcher = new GitFileWatcher({
      worktreePath: this.host.worktreePath,
      branch: this.host.branch,
      debounceMs: this.host.gitWatchDebounceMs,
      onChange: () => this.handleGitFileChange(),
      watchWorktree: mode === "recursive",
      worktreeMinDebounceMs: WATCHER_WORKTREE_MIN_DEBOUNCE_MS,
      worktreeMaxDebounceMs: WATCHER_WORKTREE_MAX_DEBOUNCE_MS,
      worktreeMaxWaitMs: WATCHER_WORKTREE_MAX_WAIT_MS,
      onWatcherFailed: () => this.handleWatcherFailed(),
      onInotifyLimitReached: () => this.host.onInotifyLimitReached(this.host.worktreeId),
      onEmfileLimitReached: () => this.host.onEmfileLimitReached(this.host.worktreeId),
    });

    const started = watcher.start();
    if (started) {
      this.gitWatcher.value = toDisposable(() => watcher.dispose());
      this.gitWatcherMode = mode;
      if (mode === "recursive" && this.wasDegraded) {
        // Recursive coverage restored after a degradation. Signal recovery
        // exactly once per degradation episode so the host can reset its
        // one-shot guards and clear the persistent degraded indicator.
        this.wasDegraded = false;
        this.host.onWatcherRecovered?.();
      }
      // Retry budget is managed by stop(true) (reset) and scheduleRetry()
      // (increment). Resetting it here would defeat exhaustion — a failing
      // git-only fallback path would keep getting fresh budget every cycle.
    } else {
      watcher.dispose();
      if (mode === "recursive") {
        // Recursive arm failed — mark degraded so the eventual successful
        // re-arm signals recovery, even if the watcher returned false without
        // routing through `onWatcherFailed`.
        this.wasDegraded = true;
        // The recursive watcher fires `onWatcherFailed` synchronously on
        // startup ENOSPC/EMFILE before returning false, so handleWatcherFailed
        // may have already installed a git-only fallback by this point. Only
        // attempt the downgrade ourselves when no degraded watcher exists.
        if (!this.gitWatcher.value) {
          this.start("git-only");
        }
        // Background worktrees don't want recursive at all, so don't keep
        // poking at it; the next focus flip re-arms via the focus change.
        if (this.host.isCurrent) {
          this.scheduleRetry();
        }
      } else {
        // git-only itself failed (e.g. getGitDir returned null). Stay dark
        // and let the polling fallback cover it; no retry loop.
        this.gitWatcherMode = "none";
      }
    }
  }

  /**
   * Tear down the watcher. The recursive-retry budget (timer + counter) is
   * separate from the watcher instance and survives benign rotations like
   * focus changes, branch checkouts, and mode upgrades; only a true shutdown
   * (`stop(true)`) or a feature disable should reset it.
   */
  stop(resetRetryBudget: boolean = true): void {
    this.gitWatcher.clear();
    this.gitWatcherMode = "none";
    if (this.gitWatchDebounceTimer) {
      clearTimeout(this.gitWatchDebounceTimer);
      this.gitWatchDebounceTimer = null;
    }
    if (this.downgradeTimer) {
      clearTimeout(this.downgradeTimer);
      this.downgradeTimer = null;
    }
    if (resetRetryBudget) {
      if (this.watcherRetryTimer) {
        clearTimeout(this.watcherRetryTimer);
        this.watcherRetryTimer = null;
      }
      this.watcherRetryCount = 0;
      this.retryBudgetResetCount = 0;
      // A true shutdown / feature-disable ends the degradation episode, so a
      // later re-arm is a fresh start, not a recovery. Benign rotations
      // (stop(false) via update()) preserve the flag so a legitimate
      // recovery still signals — mirrors the retry-budget lifecycle.
      this.wasDegraded = false;
    }
    this.gitWatchRefreshPending = false;
  }

  /**
   * Rotate the watcher (re-arm at the desired mode). Preserves the
   * recursive retry budget so a user-triggered refresh or a branch
   * checkout doesn't grant the failing recursive arm a fresh budget on
   * the same constrained kernel.
   */
  update(): void {
    this.stop(false);
    if (!this.disposed && this.host.isRunning && this.host.gitWatchEnabled) {
      this.start();
    }
  }

  /**
   * Reconcile watcher state. Stop if disabled while running; start if
   * enabled and not yet armed; rotate if granularity disagrees with focus.
   * Skips the granularity rotation when a focus-driven downgrade timer is
   * pending — otherwise periodic reconciliation (e.g. updateWorktrees) would
   * defeat the hysteresis the moment a focused worktree turns background.
   */
  ensureState(): void {
    if (!this.host.gitWatchEnabled && this.gitWatcher.value) {
      this.stop();
    } else if (this.host.gitWatchEnabled && this.host.isRunning && !this.gitWatcher.value) {
      this.start();
    } else if (
      this.host.gitWatchEnabled &&
      this.host.isRunning &&
      this.gitWatcher.value &&
      this.gitWatcherMode !== this.desiredMode() &&
      this.downgradeTimer === null
    ) {
      // Existing watcher granularity disagrees with focus state — re-arm
      // so the active worktree gets the recursive watcher and background
      // worktrees stay on the cheap .git/-only watch.
      this.update();
    }
  }

  restartIfRunning(): void {
    if (this.gitWatcher.value) {
      this.update();
    }
  }

  /**
   * React to a focus-tier change. Upgrades (background → focused) re-arm the
   * recursive watcher immediately so the user sees fresh state right after
   * switching to a worktree. Downgrades (focused → background) settle for
   * `WATCHER_FOCUS_DOWNGRADE_DELAY_MS` to absorb rapid focus toggles before
   * tearing down the recursive arm — this avoids inotify churn on quick
   * back-and-forth and keeps the watcher alive through transient passes.
   *
   * Returns `true` when an immediate rotation occurred (caller should
   * re-derive poll cadence); `false` when the change was deferred or had no
   * effect on the current granularity.
   */
  handleFocusChange(isCurrent: boolean): boolean {
    if (this.disposed || !this.host.isRunning || !this.host.gitWatchEnabled) {
      return false;
    }

    if (isCurrent) {
      if (this.downgradeTimer) {
        clearTimeout(this.downgradeTimer);
        this.downgradeTimer = null;
      }
      if (!this.gitWatcher.value) {
        // Recovery path: a previous start failed and left us with no
        // watcher. Focusing should attempt to arm the recursive variant.
        this.start();
        return true;
      }
      if (this.gitWatcherMode !== "recursive") {
        this.update();
        return true;
      }
      return false;
    }

    if (!this.gitWatcher.value || this.gitWatcherMode !== "recursive") {
      return false;
    }
    if (this.downgradeTimer) {
      return false;
    }
    this.downgradeTimer = setTimeout(() => {
      this.downgradeTimer = null;
      if (
        this.disposed ||
        !this.host.isRunning ||
        !this.host.gitWatchEnabled ||
        this.host.isCurrent ||
        this.gitWatcherMode !== "recursive"
      ) {
        return;
      }
      this.update();
    }, WATCHER_FOCUS_DOWNGRADE_DELAY_MS).unref();
    return false;
  }

  /**
   * Cancel a pending recursive-arm retry without disposing the watcher
   * itself. Used by `pausePolling()` so a backgrounded app stops burning
   * timer slots while the watcher continues to observe `.git/`.
   */
  clearRetryTimer(): void {
    if (this.watcherRetryTimer) {
      clearTimeout(this.watcherRetryTimer);
      this.watcherRetryTimer = null;
    }
  }

  /**
   * Reset the recursive-arm retry budget so transient kernel constraints
   * (inotify limits cleared after closing a heavy process, sleep/wake) don't
   * require a full project reload. Gated by a session cap to prevent
   * thrashing on truly constrained systems.
   *
   * Resets on any non-zero counter, not only exhaustion — a user hitting
   * refresh during the backoff window (count 1-4) may want immediate relief
   * and doesn't need to wait for budget exhaustion before the recovery path
   * is available. The session cap still bounds total resets.
   *
   * Returns `true` when the budget was actually reset (non-zero counter,
   * under the cap); callers can use this to decide whether a re-arm attempt
   * is worthwhile.
   */
  resetRetryBudget(): boolean {
    if (this.disposed) return false;
    if (this.watcherRetryCount === 0) return false;
    if (this.retryBudgetResetCount >= MAX_RESETS_PER_SESSION) return false;

    if (this.watcherRetryTimer) {
      clearTimeout(this.watcherRetryTimer);
      this.watcherRetryTimer = null;
    }
    this.watcherRetryCount = 0;
    this.retryBudgetResetCount++;
    return true;
  }

  /**
   * Mark a refresh as needed. Used externally when an in-flight update has
   * to land before we can re-poll (e.g. external cache invalidation while
   * `_isUpdating` is true).
   */
  markPending(): void {
    this.gitWatchRefreshPending = true;
  }

  /**
   * Snapshot + clear the pending flag — used by the branch-change path to
   * preserve the pending state across a watcher rebuild.
   */
  takePending(): boolean {
    const pending = this.gitWatchRefreshPending;
    this.gitWatchRefreshPending = false;
    return pending;
  }

  /**
   * Schedule a debounced flush — used by the index.lock recovery path.
   * Idempotent: if a debounce timer is already armed, the existing one
   * fires and triggers the flush.
   */
  scheduleDelayedFlush(): void {
    if (this.disposed || this.gitWatchDebounceTimer) return;
    this.gitWatchDebounceTimer = setTimeout(() => {
      this.gitWatchDebounceTimer = null;
      this.flushPendingIfReady();
    }, this.host.gitWatchDebounceMs);
  }

  /**
   * Drain the pending flag if we can run a refresh now. Called from the
   * monitor's `updateGitStatus` finally block (host's `isUpdating` flag is
   * already cleared by then) and from the debounce timer's callback.
   *
   * `respectDebounce=true` — used by the finally block — keeps the flush a
   * no-op when a debounce timer is already armed; the timer will fire on
   * its own schedule and call this with `respectDebounce=false`. Without
   * this guard the finally block could flush immediately and a follow-up
   * timer fire would be redundant work.
   */
  flushPendingIfReady(respectDebounce: boolean = false): void {
    if (this.disposed) return;
    if (!this.host.isRunning || this.host.isUpdating || !this.gitWatchRefreshPending) {
      return;
    }
    if (respectDebounce && this.gitWatchDebounceTimer) {
      return;
    }
    this.gitWatchRefreshPending = false;
    invalidateGitStatusCache(this.host.worktreePath);
    this.host.onTriggerUpdate();
  }

  /**
   * Recursive watcher reported a runtime failure. Preserve the cheap .git/
   * watchers by reconstructing in "git-only" mode, then schedule a retry of
   * the recursive arm on the active worktree only.
   */
  private handleWatcherFailed(): void {
    if (this.disposed) return;
    // Universal degradation point: GitFileWatcher fires onWatcherFailed for
    // ENOSPC/EMFILE limits (in addition to the limit callbacks) and for any
    // other runtime failure. Arm the recovery signal for the next successful
    // recursive re-arm.
    this.wasDegraded = true;
    this.gitWatcher.clear();
    this.gitWatcherMode = "none";
    this.start("git-only");
    if (this.host.isCurrent) {
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (
      this.disposed ||
      !this.host.isRunning ||
      !this.host.gitWatchEnabled ||
      this.watcherRetryTimer ||
      !this.host.isCurrent
    ) {
      return;
    }

    this.watcherRetryCount++;
    if (this.watcherRetryCount > WATCHER_MAX_RETRIES) {
      return;
    }

    this.watcherRetryTimer = setTimeout(() => {
      this.watcherRetryTimer = null;
      if (
        !this.disposed &&
        this.host.isRunning &&
        this.host.gitWatchEnabled &&
        this.host.isCurrent &&
        this.gitWatcherMode !== "recursive"
      ) {
        // Drop any current git-only instance so start()'s idempotent
        // guard doesn't bail; reconstruction installs the recursive variant.
        this.gitWatcher.clear();
        this.gitWatcherMode = "none";
        this.start("recursive");
      }
    }, WATCHER_RETRY_INTERVAL_MS).unref();
  }

  private handleGitFileChange(): void {
    if (this.disposed || !this.host.isRunning) return;

    if (!this.host.isUpdating) {
      const msSinceLastStatus = Date.now() - this.host.lastGitStatusCompletedAt;
      if (msSinceLastStatus < GIT_WATCH_SELF_TRIGGER_COOLDOWN_MS) {
        this.gitWatchRefreshPending = true;
        // Arm a bounded drain so an isolated `.git/` event that arrives
        // inside the self-trigger window still surfaces shortly after the
        // cooldown lifts, instead of waiting for the next poll cycle (60–
        // 300s). Reuses the shared debounce slot so we keep the
        // "at most one pending flush timer" invariant.
        if (this.gitWatchDebounceTimer === null) {
          const remainingMs = GIT_WATCH_SELF_TRIGGER_COOLDOWN_MS - msSinceLastStatus;
          this.gitWatchDebounceTimer = setTimeout(() => {
            this.gitWatchDebounceTimer = null;
            if (this.disposed) return;
            this.flushPendingIfReady();
          }, remainingMs + 10).unref();
        }
        return;
      }
    }

    this.gitWatchRefreshPending = true;
    invalidateGitStatusCache(this.host.worktreePath);

    if (this.host.isUpdating) {
      if (this.gitWatchDebounceTimer) {
        clearTimeout(this.gitWatchDebounceTimer);
      }
      this.gitWatchDebounceTimer = setTimeout(() => {
        this.gitWatchDebounceTimer = null;
        this.flushPendingIfReady();
      }, this.host.gitWatchDebounceMs);
      return;
    }

    this.flushPendingIfReady();
  }
}
