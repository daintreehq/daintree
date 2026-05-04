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

  it("dispose() prevents future start() calls", () => {
    mockWatcherStartResult = true;
    const host = makeHost();
    const ctrl = new WatcherController(host as WatcherControllerHost);

    ctrl.dispose();
    ctrl.start();
    expect(watcherStartCallCount).toBe(0);
    expect(ctrl.hasWatcher).toBe(false);
  });

  it("dispose() cancels pending retry timers", () => {
    mockRecursiveStartResult = false;
    mockGitOnlyStartResult = true;
    const host = makeHost({ isCurrent: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);

    ctrl.start();
    ctrl.dispose();
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
});
