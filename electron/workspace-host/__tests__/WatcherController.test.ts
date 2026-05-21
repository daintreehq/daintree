import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../utils/git.js", () => ({
  invalidateGitStatusCache: vi.fn(),
  getWorktreeChangesWithStats: vi.fn(),
}));

let mockWatcherStartResult = false;
let mockRecursiveStartResult: boolean | undefined;
let mockGitOnlyStartResult: boolean | undefined;
let mockWatcherStartFiresFailure = false;
let capturedOnInotifyLimitReached: (() => void) | undefined;
let capturedOnEmfileLimitReached: (() => void) | undefined;
let capturedWatcherOptions: Record<string, unknown> | undefined;
let watcherStartCallCount = 0;

vi.mock("../../utils/gitFileWatcher.js", () => {
  return {
    GitFileWatcher: class {
      private readonly onWatcherFailed?: () => void;
      private readonly watchWorktree: boolean;
      constructor(
        opts: {
          onWatcherFailed?: () => void;
          onInotifyLimitReached?: () => void;
          onEmfileLimitReached?: () => void;
          watchWorktree?: boolean;
        } & Record<string, unknown>
      ) {
        this.onWatcherFailed = opts.onWatcherFailed;
        this.watchWorktree = opts.watchWorktree === true;
        capturedOnInotifyLimitReached = opts.onInotifyLimitReached;
        capturedOnEmfileLimitReached = opts.onEmfileLimitReached;
        capturedWatcherOptions = opts;
      }
      start() {
        watcherStartCallCount++;
        const result = this.watchWorktree
          ? (mockRecursiveStartResult ?? mockWatcherStartResult)
          : (mockGitOnlyStartResult ?? mockWatcherStartResult);
        if (this.watchWorktree && mockWatcherStartFiresFailure && !result) {
          this.onWatcherFailed?.();
        }
        return result;
      }
      dispose() {}
    },
  };
});

import { WatcherController, type WatcherControllerHost } from "../WatcherController.js";

interface MutableHost {
  isRunning: boolean;
  isCurrent: boolean;
  gitWatchEnabled: boolean;
  gitWatchDebounceMs: number;
  worktreeId: string;
  worktreePath: string;
  branch: string | undefined;
  isUpdating: boolean;
  lastGitStatusCompletedAt: number;
  onTriggerUpdate: ReturnType<typeof vi.fn>;
  onInotifyLimitReached: ReturnType<typeof vi.fn>;
  onEmfileLimitReached: ReturnType<typeof vi.fn>;
  onWatcherRecovered: ReturnType<typeof vi.fn>;
}

function makeHost(overrides: Partial<MutableHost> = {}): MutableHost {
  return {
    isRunning: true,
    isCurrent: true,
    gitWatchEnabled: true,
    gitWatchDebounceMs: 300,
    worktreeId: "/test/worktree",
    worktreePath: "/test/worktree",
    branch: "main",
    isUpdating: false,
    lastGitStatusCompletedAt: 0,
    onTriggerUpdate: vi.fn(),
    onInotifyLimitReached: vi.fn(),
    onEmfileLimitReached: vi.fn(),
    onWatcherRecovered: vi.fn(),
    ...overrides,
  };
}

describe("WatcherController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockWatcherStartResult = false;
    mockRecursiveStartResult = undefined;
    mockGitOnlyStartResult = undefined;
    mockWatcherStartFiresFailure = false;
    watcherStartCallCount = 0;
    capturedOnInotifyLimitReached = undefined;
    capturedOnEmfileLimitReached = undefined;
    capturedWatcherOptions = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not start when host.isRunning is false", () => {
    const host = makeHost({ isRunning: false });
    const ctrl = new WatcherController(host as WatcherControllerHost);

    ctrl.start();
    expect(watcherStartCallCount).toBe(0);
    expect(ctrl.hasWatcher).toBe(false);
  });

  it("does not start when host.gitWatchEnabled is false", () => {
    const host = makeHost({ gitWatchEnabled: false });
    const ctrl = new WatcherController(host as WatcherControllerHost);

    ctrl.start();
    expect(watcherStartCallCount).toBe(0);
  });

  it("starts in recursive mode for focused worktrees", () => {
    mockWatcherStartResult = true;
    const host = makeHost({ isCurrent: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);

    ctrl.start();
    expect(watcherStartCallCount).toBe(1);
    expect(ctrl.currentMode).toBe("recursive");
    expect(ctrl.hasWatcher).toBe(true);
    expect(capturedWatcherOptions?.watchWorktree).toBe(true);
  });

  it("starts in git-only mode for background worktrees", () => {
    mockWatcherStartResult = true;
    const host = makeHost({ isCurrent: false });
    const ctrl = new WatcherController(host as WatcherControllerHost);

    ctrl.start();
    expect(ctrl.currentMode).toBe("git-only");
    expect(capturedWatcherOptions?.watchWorktree).toBe(false);
  });

  it("falls back to git-only when recursive fails synchronously via onWatcherFailed", () => {
    // Recursive fails AND fires onWatcherFailed synchronously; git-only succeeds.
    mockRecursiveStartResult = false;
    mockGitOnlyStartResult = true;
    mockWatcherStartFiresFailure = true;
    const host = makeHost({ isCurrent: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);

    ctrl.start();
    expect(ctrl.currentMode).toBe("git-only");
    expect(ctrl.hasWatcher).toBe(true);
  });

  it("schedules a recursive retry after a failed recursive start (focused only)", () => {
    mockRecursiveStartResult = false;
    mockGitOnlyStartResult = true;
    const host = makeHost({ isCurrent: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);

    ctrl.start();
    expect(ctrl.currentMode).toBe("git-only");

    // After the retry interval, recursive succeeds.
    mockRecursiveStartResult = true;
    vi.advanceTimersByTime(31_000);
    expect(ctrl.currentMode).toBe("recursive");
  });

  it("does not fire onWatcherRecovered on a clean cold start", () => {
    mockWatcherStartResult = true;
    const host = makeHost({ isCurrent: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);

    ctrl.start();
    expect(ctrl.currentMode).toBe("recursive");
    expect(host.onWatcherRecovered).not.toHaveBeenCalled();
  });

  it("fires onWatcherRecovered once when the recursive arm recovers via retry", () => {
    mockRecursiveStartResult = false;
    mockGitOnlyStartResult = true;
    const host = makeHost({ isCurrent: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);

    ctrl.start();
    expect(ctrl.currentMode).toBe("git-only");
    expect(host.onWatcherRecovered).not.toHaveBeenCalled();

    // Retry succeeds — recovery should signal exactly once.
    mockRecursiveStartResult = true;
    vi.advanceTimersByTime(31_000);
    expect(ctrl.currentMode).toBe("recursive");
    expect(host.onWatcherRecovered).toHaveBeenCalledTimes(1);
  });

  it("does not fire a false onWatcherRecovered after disable then re-enable", () => {
    // Degrade, then simulate a feature-disable (stop with budget reset) and a
    // later re-enable that arms recursive cleanly. No real recovery occurred,
    // so onWatcherRecovered must not fire.
    mockRecursiveStartResult = false;
    mockGitOnlyStartResult = true;
    const host = makeHost({ isCurrent: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);

    ctrl.start();
    expect(ctrl.currentMode).toBe("git-only");

    ctrl.stop(); // feature disable — ends the degradation episode
    mockRecursiveStartResult = true;
    ctrl.start("recursive");

    expect(ctrl.currentMode).toBe("recursive");
    expect(host.onWatcherRecovered).not.toHaveBeenCalled();
  });

  it("preserves the recovery signal across a benign rotation (stop(false))", () => {
    // update() calls stop(false) then start(); a degraded watcher rotating
    // this way must still signal recovery when recursive finally arms.
    mockRecursiveStartResult = false;
    mockGitOnlyStartResult = true;
    const host = makeHost({ isCurrent: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);

    ctrl.start();
    expect(ctrl.currentMode).toBe("git-only");

    mockRecursiveStartResult = true;
    ctrl.update(); // stop(false) + start() — preserves wasDegraded

    expect(ctrl.currentMode).toBe("recursive");
    expect(host.onWatcherRecovered).toHaveBeenCalledTimes(1);
  });

  it("fires onWatcherRecovered after a synchronous onWatcherFailed fallback recovers", () => {
    // Recursive fails + fires onWatcherFailed synchronously; git-only succeeds.
    mockRecursiveStartResult = false;
    mockGitOnlyStartResult = true;
    mockWatcherStartFiresFailure = true;
    const host = makeHost({ isCurrent: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);

    ctrl.start();
    expect(ctrl.currentMode).toBe("git-only");
    expect(host.onWatcherRecovered).not.toHaveBeenCalled();

    mockRecursiveStartResult = true;
    mockWatcherStartFiresFailure = false;
    vi.advanceTimersByTime(31_000);
    expect(ctrl.currentMode).toBe("recursive");
    expect(host.onWatcherRecovered).toHaveBeenCalledTimes(1);
  });

  it("does not schedule a retry for background worktrees", () => {
    mockRecursiveStartResult = false;
    mockGitOnlyStartResult = true;
    const host = makeHost({ isCurrent: false });
    const ctrl = new WatcherController(host as WatcherControllerHost);

    // Background goes straight to git-only with no retry budget.
    ctrl.start();
    expect(ctrl.currentMode).toBe("git-only");

    mockRecursiveStartResult = true;
    vi.advanceTimersByTime(60_000);
    // Still git-only — no retry was scheduled.
    expect(ctrl.currentMode).toBe("git-only");
  });

  it("respects the WATCHER_MAX_RETRIES (5) budget", () => {
    mockRecursiveStartResult = false;
    mockGitOnlyStartResult = true;
    const host = makeHost({ isCurrent: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);

    ctrl.start();
    // 5 retries × 30s — should attempt to upgrade but always fail.
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(31_000);
    }
    // After exhaustion, no further retry scheduled.
    const startsAtCap = watcherStartCallCount;
    vi.advanceTimersByTime(120_000);
    expect(watcherStartCallCount).toBe(startsAtCap);
  });

  it("update() rotates without resetting the retry budget", () => {
    mockRecursiveStartResult = false;
    mockGitOnlyStartResult = true;
    const host = makeHost({ isCurrent: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);

    ctrl.start();
    // Burn 2 retries.
    vi.advanceTimersByTime(31_000);
    vi.advanceTimersByTime(31_000);

    // Rotate (e.g. branch checkout) — budget should NOT reset.
    ctrl.update();

    // Now allow recursive to succeed; remaining budget = 3 retries.
    mockRecursiveStartResult = true;
    vi.advanceTimersByTime(31_000);
    expect(ctrl.currentMode).toBe("recursive");
  });

  it("stop(true) resets the retry budget — restart allows a full 5-retry budget", () => {
    mockRecursiveStartResult = false;
    mockGitOnlyStartResult = true;
    const host = makeHost({ isCurrent: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);

    // Burn 3 retries on the first run.
    ctrl.start();
    vi.advanceTimersByTime(31_000);
    vi.advanceTimersByTime(31_000);
    vi.advanceTimersByTime(31_000);

    ctrl.stop(true);

    // Restart — fresh budget should mean recursive can succeed within budget.
    ctrl.start();
    // Now allow recursive to succeed at the next retry — budget was reset
    // so retryCount=1 at this point. If reset failed and budget was still
    // close to MAX_RETRIES, recursive might never get an upgrade.
    mockRecursiveStartResult = true;
    vi.advanceTimersByTime(31_000);
    expect(ctrl.currentMode).toBe("recursive");
  });

  it("stop(false) preserves the retry budget — exhausted budget stays exhausted across rotation", () => {
    mockRecursiveStartResult = false;
    mockGitOnlyStartResult = true;
    const host = makeHost({ isCurrent: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);

    // Exhaust the entire 5-retry budget on the first run.
    ctrl.start();
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(31_000);
    }

    // Capture starts after exhaustion — confirm we hit the cap.
    const startsAtExhaustion = watcherStartCallCount;
    vi.advanceTimersByTime(120_000);
    expect(watcherStartCallCount).toBe(startsAtExhaustion);

    // Rotation should NOT grant a fresh budget — stop(false) preserves count.
    ctrl.stop(false);
    ctrl.start();
    const startsAfterRotation = watcherStartCallCount;

    // Even if recursive could succeed now, no retry should fire because
    // the budget was already exhausted before rotation.
    mockRecursiveStartResult = true;
    vi.advanceTimersByTime(120_000);
    expect(watcherStartCallCount).toBe(startsAfterRotation);
    expect(ctrl.currentMode).toBe("git-only");
  });

  it("ensureState() stops the watcher when gitWatchEnabled flips off", () => {
    mockWatcherStartResult = true;
    const host = makeHost();
    const ctrl = new WatcherController(host as WatcherControllerHost);

    ctrl.start();
    expect(ctrl.hasWatcher).toBe(true);

    host.gitWatchEnabled = false;
    ctrl.ensureState();
    expect(ctrl.hasWatcher).toBe(false);
  });

  it("ensureState() starts the watcher when re-enabled mid-run", () => {
    const host = makeHost({ gitWatchEnabled: false });
    const ctrl = new WatcherController(host as WatcherControllerHost);

    ctrl.ensureState();
    expect(ctrl.hasWatcher).toBe(false);

    mockWatcherStartResult = true;
    host.gitWatchEnabled = true;
    ctrl.ensureState();
    expect(ctrl.hasWatcher).toBe(true);
  });

  it("ensureState() rotates when granularity disagrees with focus", () => {
    mockWatcherStartResult = true;
    const host = makeHost({ isCurrent: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);

    ctrl.start();
    expect(ctrl.currentMode).toBe("recursive");

    host.isCurrent = false;
    ctrl.ensureState();
    expect(ctrl.currentMode).toBe("git-only");
  });

  it("triggers onTriggerUpdate when a file change arrives outside the cooldown", () => {
    mockWatcherStartResult = true;
    const host = makeHost({ lastGitStatusCompletedAt: 0 });
    const ctrl = new WatcherController(host as WatcherControllerHost);
    ctrl.start();

    // Advance Date.now beyond the 1s cooldown.
    vi.setSystemTime(2_000);
    const onChange = capturedWatcherOptions?.onChange as (() => void) | undefined;
    onChange?.();

    expect(host.onTriggerUpdate).toHaveBeenCalledTimes(1);
  });

  it("debounces a file change that arrives during an in-flight update", async () => {
    mockWatcherStartResult = true;
    const host = makeHost({ isUpdating: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);
    ctrl.start();

    (capturedWatcherOptions?.onChange as () => void)();
    expect(host.onTriggerUpdate).not.toHaveBeenCalled();

    // After debounceMs, the timer fires but isUpdating still true → no flush.
    await vi.advanceTimersByTimeAsync(301);
    expect(host.onTriggerUpdate).not.toHaveBeenCalled();

    // Once the update completes (host flips), monitor calls flushPendingIfReady.
    host.isUpdating = false;
    ctrl.flushPendingIfReady(true);
    expect(host.onTriggerUpdate).toHaveBeenCalledTimes(1);
  });

  it("queues the pending flag when a change arrives within the cooldown window", () => {
    mockWatcherStartResult = true;
    const host = makeHost({ lastGitStatusCompletedAt: Date.now() });
    const ctrl = new WatcherController(host as WatcherControllerHost);
    ctrl.start();

    (capturedWatcherOptions?.onChange as () => void)();
    expect(host.onTriggerUpdate).not.toHaveBeenCalled();

    // Pending is set; flushing later will trigger.
    ctrl.flushPendingIfReady(false);
    expect(host.onTriggerUpdate).toHaveBeenCalledTimes(1);
  });

  it("flushPendingIfReady(respectDebounce=true) is a no-op while a debounce timer is armed", () => {
    mockWatcherStartResult = true;
    const host = makeHost({ isUpdating: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);
    ctrl.start();

    (capturedWatcherOptions?.onChange as () => void)();
    // Debounce timer is armed. Now finalize the update.
    host.isUpdating = false;
    ctrl.flushPendingIfReady(true);
    // Still no trigger — debounce will handle it.
    expect(host.onTriggerUpdate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(301);
    expect(host.onTriggerUpdate).toHaveBeenCalledTimes(1);
  });

  it("scheduleDelayedFlush() arms a debounce timer that flushes when ready", () => {
    mockWatcherStartResult = true;
    const host = makeHost();
    const ctrl = new WatcherController(host as WatcherControllerHost);
    ctrl.start();

    ctrl.markPending();
    ctrl.scheduleDelayedFlush();
    expect(host.onTriggerUpdate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(301);
    expect(host.onTriggerUpdate).toHaveBeenCalledTimes(1);
  });

  it("clearRetryTimer() cancels the retry without disposing the watcher", () => {
    mockRecursiveStartResult = false;
    mockGitOnlyStartResult = true;
    const host = makeHost({ isCurrent: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);

    ctrl.start();
    expect(ctrl.currentMode).toBe("git-only");

    ctrl.clearRetryTimer();
    mockRecursiveStartResult = true;
    vi.advanceTimersByTime(120_000);
    // No retry — still git-only.
    expect(ctrl.currentMode).toBe("git-only");
    // But the watcher is still active.
    expect(ctrl.hasWatcher).toBe(true);
  });

  it("stop(true) clears watcher and retry state", () => {
    mockWatcherStartResult = true;
    const host = makeHost();
    const ctrl = new WatcherController(host as WatcherControllerHost);

    ctrl.start();
    ctrl.stop(true);
    expect(ctrl.hasWatcher).toBe(false);
    expect(ctrl.currentMode).toBe("none");
  });

  it("stop(true) cancels pending retry timers", () => {
    mockRecursiveStartResult = false;
    mockGitOnlyStartResult = true;
    const host = makeHost({ isCurrent: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);

    ctrl.start();
    ctrl.stop(true);
    mockRecursiveStartResult = true;
    vi.advanceTimersByTime(120_000);
    // No retry should have run.
    expect(ctrl.currentMode).toBe("none");
  });

  it("forwards onInotifyLimitReached and onEmfileLimitReached", () => {
    mockWatcherStartResult = true;
    const host = makeHost();
    const ctrl = new WatcherController(host as WatcherControllerHost);
    ctrl.start();

    capturedOnInotifyLimitReached?.();
    capturedOnEmfileLimitReached?.();
    expect(host.onInotifyLimitReached).toHaveBeenCalledWith("/test/worktree");
    expect(host.onEmfileLimitReached).toHaveBeenCalledWith("/test/worktree");
  });

  it("uses the 250ms worktree min-debounce floor", () => {
    mockWatcherStartResult = true;
    const host = makeHost({ isCurrent: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);
    ctrl.start();

    expect(capturedWatcherOptions).toMatchObject({ worktreeMinDebounceMs: 250 });
  });

  it("handleFocusChange(false) defers the downgrade by the settle delay", () => {
    mockWatcherStartResult = true;
    const host = makeHost({ isCurrent: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);
    ctrl.start();
    expect(ctrl.currentMode).toBe("recursive");
    const startsBeforeFlip = watcherStartCallCount;

    host.isCurrent = false;
    const rotated = ctrl.handleFocusChange(false);

    expect(rotated).toBe(false);
    // No synchronous rebuild — the recursive watcher stays armed.
    expect(watcherStartCallCount).toBe(startsBeforeFlip);
    expect(ctrl.currentMode).toBe("recursive");

    // After the 3s settle delay, the controller rebuilds in git-only mode.
    vi.advanceTimersByTime(3_000);
    expect(watcherStartCallCount).toBe(startsBeforeFlip + 1);
    expect(ctrl.currentMode).toBe("git-only");
  });

  it("handleFocusChange(true) cancels a pending downgrade and keeps recursive", () => {
    mockWatcherStartResult = true;
    const host = makeHost({ isCurrent: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);
    ctrl.start();
    const startsBeforeFlip = watcherStartCallCount;

    host.isCurrent = false;
    ctrl.handleFocusChange(false);

    // Re-focus before the settle window elapses.
    vi.advanceTimersByTime(1_500);
    host.isCurrent = true;
    const rotated = ctrl.handleFocusChange(true);

    // Already recursive — no rotation needed.
    expect(rotated).toBe(false);

    // Let the original settle window pass — the timer should not fire.
    vi.advanceTimersByTime(5_000);
    expect(watcherStartCallCount).toBe(startsBeforeFlip);
    expect(ctrl.currentMode).toBe("recursive");
  });

  it("handleFocusChange(true) immediately upgrades a git-only watcher and reports rotation", () => {
    mockWatcherStartResult = true;
    const host = makeHost({ isCurrent: false });
    const ctrl = new WatcherController(host as WatcherControllerHost);
    ctrl.start();
    expect(ctrl.currentMode).toBe("git-only");
    const startsBeforeFlip = watcherStartCallCount;

    host.isCurrent = true;
    const rotated = ctrl.handleFocusChange(true);

    expect(rotated).toBe(true);
    expect(watcherStartCallCount).toBe(startsBeforeFlip + 1);
    expect(ctrl.currentMode).toBe("recursive");
  });

  it("stop() cancels a pending downgrade timer", () => {
    mockWatcherStartResult = true;
    const host = makeHost({ isCurrent: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);
    ctrl.start();
    const startsBeforeFlip = watcherStartCallCount;

    host.isCurrent = false;
    ctrl.handleFocusChange(false);
    ctrl.stop(true);

    vi.advanceTimersByTime(5_000);
    // Timer was cleared — no rebuild fired after stop.
    expect(watcherStartCallCount).toBe(startsBeforeFlip);
    expect(ctrl.currentMode).toBe("none");
  });

  it("arms a drain timer when a change arrives inside the cooldown window", () => {
    mockWatcherStartResult = true;
    // Pin "now" at t=2s and place `lastGitStatusCompletedAt` 500ms back —
    // we're 500ms into the 1s self-trigger cooldown, so the drain should
    // fire at t≈2.51s.
    vi.setSystemTime(2_000);
    const host = makeHost({ lastGitStatusCompletedAt: 1_500 });
    const ctrl = new WatcherController(host as WatcherControllerHost);
    ctrl.start();

    (capturedWatcherOptions?.onChange as () => void)();
    expect(host.onTriggerUpdate).not.toHaveBeenCalled();

    // Advance past the remaining cooldown + the 10ms epsilon.
    vi.advanceTimersByTime(600);
    expect(host.onTriggerUpdate).toHaveBeenCalledTimes(1);
  });

  it("does not double-arm the drain timer when multiple changes land in the cooldown", () => {
    mockWatcherStartResult = true;
    vi.setSystemTime(2_000);
    const host = makeHost({ lastGitStatusCompletedAt: 1_500 });
    const ctrl = new WatcherController(host as WatcherControllerHost);
    ctrl.start();

    const onChange = capturedWatcherOptions?.onChange as () => void;
    onChange();
    onChange();
    onChange();

    vi.advanceTimersByTime(600);
    // Drain still fires exactly once — pending flag collapses bursts.
    expect(host.onTriggerUpdate).toHaveBeenCalledTimes(1);
  });

  it("ensureState() does not bypass a pending downgrade timer", () => {
    mockWatcherStartResult = true;
    const host = makeHost({ isCurrent: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);
    ctrl.start();
    expect(ctrl.currentMode).toBe("recursive");
    const startsBeforeFlip = watcherStartCallCount;

    // Simulate WorkspaceService.updateWorktrees: set isCurrent then call
    // ensureState. The downgrade timer must keep the recursive watcher
    // alive through the periodic reconciliation pass.
    host.isCurrent = false;
    ctrl.handleFocusChange(false);
    ctrl.ensureState();

    expect(watcherStartCallCount).toBe(startsBeforeFlip);
    expect(ctrl.currentMode).toBe("recursive");

    // After the settle delay, the controller rebuilds in git-only mode.
    vi.advanceTimersByTime(3_000);
    expect(ctrl.currentMode).toBe("git-only");
    expect(watcherStartCallCount).toBe(startsBeforeFlip + 1);
  });

  it("handleFocusChange(true) starts a watcher when none exists", () => {
    // Simulate: a previous start failed (mode 'none', no watcher), then
    // the user focuses this worktree via setActiveWorktree. The watcher
    // must be re-attempted, not silently skipped.
    mockWatcherStartResult = false;
    const host = makeHost({ isCurrent: false });
    const ctrl = new WatcherController(host as WatcherControllerHost);
    ctrl.start();
    expect(ctrl.hasWatcher).toBe(false);
    expect(ctrl.currentMode).toBe("none");
    const startsBeforeFlip = watcherStartCallCount;

    mockWatcherStartResult = true;
    host.isCurrent = true;
    const rotated = ctrl.handleFocusChange(true);

    expect(rotated).toBe(true);
    expect(watcherStartCallCount).toBe(startsBeforeFlip + 1);
    expect(ctrl.hasWatcher).toBe(true);
    expect(ctrl.currentMode).toBe("recursive");
  });

  it("stop() cancels a pending cooldown drain timer", () => {
    mockWatcherStartResult = true;
    vi.setSystemTime(2_000);
    const host = makeHost({ lastGitStatusCompletedAt: 1_500 });
    const ctrl = new WatcherController(host as WatcherControllerHost);
    ctrl.start();

    (capturedWatcherOptions?.onChange as () => void)();
    ctrl.stop(true);

    vi.advanceTimersByTime(1_000);
    // Drain timer cleared on stop — no flush fires after teardown.
    expect(host.onTriggerUpdate).not.toHaveBeenCalled();
  });

  describe("resetRetryBudget", () => {
    it("resets exhausted budget so subsequent failure schedules a retry", () => {
      mockRecursiveStartResult = false;
      mockGitOnlyStartResult = true;
      const host = makeHost({ isCurrent: true });
      const ctrl = new WatcherController(host as WatcherControllerHost);

      ctrl.start();
      for (let i = 0; i < 6; i++) {
        vi.advanceTimersByTime(31_000);
      }
      const startsAtExhaustion = watcherStartCallCount;
      vi.advanceTimersByTime(120_000);
      expect(watcherStartCallCount).toBe(startsAtExhaustion);

      const result = ctrl.resetRetryBudget();
      expect(result).toBe(true);

      // update() tears down git-only and re-attempts recursive. Recursive
      // fails → git-only installed + scheduleRetry() with fresh counter.
      ctrl.update();
      vi.advanceTimersByTime(31_000);
      expect(watcherStartCallCount).toBeGreaterThan(startsAtExhaustion);
    });

    it("no-ops when watcherRetryCount is zero (does not consume cap)", () => {
      const host = makeHost({ isCurrent: true });
      const ctrl = new WatcherController(host as WatcherControllerHost);
      const result = ctrl.resetRetryBudget();
      expect(result).toBe(false);

      // Should be able to reset after actual exhaustion.
      mockRecursiveStartResult = false;
      mockGitOnlyStartResult = true;
      ctrl.start();
      for (let i = 0; i < 6; i++) {
        vi.advanceTimersByTime(31_000);
      }
      expect(ctrl.resetRetryBudget()).toBe(true);
    });

    it("capped at MAX_RESETS_PER_SESSION (3)", () => {
      mockRecursiveStartResult = false;
      mockGitOnlyStartResult = true;
      const host = makeHost({ isCurrent: true });
      const ctrl = new WatcherController(host as WatcherControllerHost);

      ctrl.start();
      for (let i = 0; i < 6; i++) {
        vi.advanceTimersByTime(31_000);
      }

      // 3 resets allowed; update() re-arms after each reset so retries
      // can burn through the fresh budget.
      for (let r = 0; r < 3; r++) {
        expect(ctrl.resetRetryBudget()).toBe(true);
        ctrl.update();
        for (let i = 0; i < 6; i++) {
          vi.advanceTimersByTime(31_000);
        }
      }
      // 4th reset denied.
      expect(ctrl.resetRetryBudget()).toBe(false);
    });

    it("clears a pending retry timer", () => {
      mockRecursiveStartResult = false;
      mockGitOnlyStartResult = true;
      const host = makeHost({ isCurrent: true });
      const ctrl = new WatcherController(host as WatcherControllerHost);

      ctrl.start();
      // Let one retry fire so a new timer for retry 2 is pending.
      vi.advanceTimersByTime(31_000);
      const startsAfterOneRetry = watcherStartCallCount;

      const result = ctrl.resetRetryBudget();
      expect(result).toBe(true);

      // The pending timer was cleared — advancing 30s should NOT fire a retry
      // since the budget just reset (count=0) and nothing scheduled a new one.
      vi.advanceTimersByTime(31_000);
      expect(watcherStartCallCount).toBe(startsAfterOneRetry);
    });

    it("stop(true) resets both the retry budget and the session cap", () => {
      mockRecursiveStartResult = false;
      mockGitOnlyStartResult = true;
      const host = makeHost({ isCurrent: true });
      const ctrl = new WatcherController(host as WatcherControllerHost);

      ctrl.start();
      for (let i = 0; i < 6; i++) {
        vi.advanceTimersByTime(31_000);
      }
      // Consume all 3 resets.
      for (let r = 0; r < 3; r++) {
        expect(ctrl.resetRetryBudget()).toBe(true);
        ctrl.update();
        for (let i = 0; i < 6; i++) {
          vi.advanceTimersByTime(31_000);
        }
      }
      expect(ctrl.resetRetryBudget()).toBe(false);

      // Full teardown resets the session cap.
      ctrl.stop(true);
      // After stop(true), budget starts fresh. Re-arm and exhaust.
      ctrl.start();
      for (let i = 0; i < 6; i++) {
        vi.advanceTimersByTime(31_000);
      }
      expect(ctrl.resetRetryBudget()).toBe(true);
    });

    it("stop(false) preserves both the retry count and the session cap", () => {
      mockRecursiveStartResult = false;
      mockGitOnlyStartResult = true;
      const host = makeHost({ isCurrent: true });
      const ctrl = new WatcherController(host as WatcherControllerHost);

      ctrl.start();
      for (let i = 0; i < 6; i++) {
        vi.advanceTimersByTime(31_000);
      }
      expect(ctrl.resetRetryBudget()).toBe(true);
      ctrl.update();
      for (let i = 0; i < 6; i++) {
        vi.advanceTimersByTime(31_000);
      }
      // 2nd reset — should succeed (2 of 3 consumed).
      expect(ctrl.resetRetryBudget()).toBe(true);

      // stop(false) should NOT restore the 2 already-consumed resets.
      ctrl.stop(false);
      ctrl.start();
      for (let i = 0; i < 6; i++) {
        vi.advanceTimersByTime(31_000);
      }
      const result = ctrl.resetRetryBudget();
      // After 2 resets consumed, the 3rd (last) should succeed.
      expect(result).toBe(true);
    });
  });
});
