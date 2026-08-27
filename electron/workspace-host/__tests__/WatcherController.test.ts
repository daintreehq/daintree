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
        return Promise.resolve(result);
      }
      dispose() {}
    },
  };
});

import { WatcherController, type WatcherControllerHost } from "../WatcherController.js";

// Flush the microtask chain behind an async watcher arm (arm completion may
// itself initiate a fallback arm whose completion lands one tick later).
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

interface MutableHost {
  isRunning: boolean;
  isElevated: boolean;
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
  onWorktreeFilesChanged: ReturnType<typeof vi.fn>;
}

function makeHost(overrides: Partial<MutableHost> = {}): MutableHost {
  return {
    isRunning: true,
    isElevated: true,
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
    onWorktreeFilesChanged: vi.fn(),
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

  it("does not start when host.isRunning is false", async () => {
    const host = makeHost({ isRunning: false });
    const ctrl = new WatcherController(host as WatcherControllerHost);

    ctrl.start();

    await settle();
    expect(watcherStartCallCount).toBe(0);
    expect(ctrl.hasWatcher).toBe(false);
  });

  it("does not start when host.gitWatchEnabled is false", async () => {
    const host = makeHost({ gitWatchEnabled: false });
    const ctrl = new WatcherController(host as WatcherControllerHost);

    ctrl.start();

    await settle();
    expect(watcherStartCallCount).toBe(0);
  });

  it("starts in recursive mode for focused worktrees", async () => {
    mockWatcherStartResult = true;
    const host = makeHost({ isElevated: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);

    ctrl.start();

    await settle();
    expect(watcherStartCallCount).toBe(1);
    expect(ctrl.currentMode).toBe("recursive");
    expect(ctrl.hasWatcher).toBe(true);
    expect(capturedWatcherOptions?.watchWorktree).toBe(true);
  });

  it("starts in git-only mode for background worktrees", async () => {
    mockWatcherStartResult = true;
    const host = makeHost({ isElevated: false });
    const ctrl = new WatcherController(host as WatcherControllerHost);

    ctrl.start();

    await settle();
    expect(ctrl.currentMode).toBe("git-only");
    expect(capturedWatcherOptions?.watchWorktree).toBe(false);
  });

  it("falls back to git-only when recursive fails synchronously via onWatcherFailed", async () => {
    // Recursive fails AND fires onWatcherFailed synchronously; git-only succeeds.
    mockRecursiveStartResult = false;
    mockGitOnlyStartResult = true;
    mockWatcherStartFiresFailure = true;
    const host = makeHost({ isElevated: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);

    ctrl.start();

    await settle();
    expect(ctrl.currentMode).toBe("git-only");
    expect(ctrl.hasWatcher).toBe(true);
  });

  it("schedules a recursive retry after a failed recursive start (focused only)", async () => {
    mockRecursiveStartResult = false;
    mockGitOnlyStartResult = true;
    const host = makeHost({ isElevated: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);

    ctrl.start();

    await settle();
    expect(ctrl.currentMode).toBe("git-only");

    // After the retry interval, recursive succeeds.
    mockRecursiveStartResult = true;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(ctrl.currentMode).toBe("recursive");
  });

  it("does not fire onWatcherRecovered on a clean cold start", async () => {
    mockWatcherStartResult = true;
    const host = makeHost({ isElevated: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);

    ctrl.start();

    await settle();
    expect(ctrl.currentMode).toBe("recursive");
    expect(host.onWatcherRecovered).not.toHaveBeenCalled();
  });

  it("fires onWatcherRecovered once when the recursive arm recovers via retry", async () => {
    mockRecursiveStartResult = false;
    mockGitOnlyStartResult = true;
    const host = makeHost({ isElevated: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);

    ctrl.start();

    await settle();
    expect(ctrl.currentMode).toBe("git-only");
    expect(host.onWatcherRecovered).not.toHaveBeenCalled();

    // Retry succeeds — recovery should signal exactly once.
    mockRecursiveStartResult = true;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(ctrl.currentMode).toBe("recursive");
    expect(host.onWatcherRecovered).toHaveBeenCalledTimes(1);
  });

  it("does not fire a false onWatcherRecovered after disable then re-enable", async () => {
    // Degrade, then simulate a feature-disable (stop with budget reset) and a
    // later re-enable that arms recursive cleanly. No real recovery occurred,
    // so onWatcherRecovered must not fire.
    mockRecursiveStartResult = false;
    mockGitOnlyStartResult = true;
    const host = makeHost({ isElevated: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);

    ctrl.start();

    await settle();
    expect(ctrl.currentMode).toBe("git-only");

    ctrl.stop(); // feature disable — ends the degradation episode
    mockRecursiveStartResult = true;
    ctrl.start("recursive");
    await settle();

    expect(ctrl.currentMode).toBe("recursive");
    expect(host.onWatcherRecovered).not.toHaveBeenCalled();
  });

  it("preserves the recovery signal across a benign rotation (stop(false))", async () => {
    // update() calls stop(false) then start(); a degraded watcher rotating
    // this way must still signal recovery when recursive finally arms.
    mockRecursiveStartResult = false;
    mockGitOnlyStartResult = true;
    const host = makeHost({ isElevated: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);

    ctrl.start();

    await settle();
    expect(ctrl.currentMode).toBe("git-only");

    mockRecursiveStartResult = true;
    ctrl.update(); // stop(false) + start() — preserves wasDegraded
    await settle();

    expect(ctrl.currentMode).toBe("recursive");
    expect(host.onWatcherRecovered).toHaveBeenCalledTimes(1);
  });

  it("fires onWatcherRecovered after a synchronous onWatcherFailed fallback recovers", async () => {
    // Recursive fails + fires onWatcherFailed synchronously; git-only succeeds.
    mockRecursiveStartResult = false;
    mockGitOnlyStartResult = true;
    mockWatcherStartFiresFailure = true;
    const host = makeHost({ isElevated: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);

    ctrl.start();

    await settle();
    expect(ctrl.currentMode).toBe("git-only");
    expect(host.onWatcherRecovered).not.toHaveBeenCalled();

    mockRecursiveStartResult = true;
    mockWatcherStartFiresFailure = false;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(ctrl.currentMode).toBe("recursive");
    expect(host.onWatcherRecovered).toHaveBeenCalledTimes(1);
  });

  it("does not schedule a retry for background worktrees", async () => {
    mockRecursiveStartResult = false;
    mockGitOnlyStartResult = true;
    const host = makeHost({ isElevated: false });
    const ctrl = new WatcherController(host as WatcherControllerHost);

    // Background goes straight to git-only with no retry budget.
    ctrl.start();
    await settle();
    expect(ctrl.currentMode).toBe("git-only");

    mockRecursiveStartResult = true;
    await vi.advanceTimersByTimeAsync(60_000);
    // Still git-only — no retry was scheduled.
    expect(ctrl.currentMode).toBe("git-only");
  });

  it("respects the WATCHER_MAX_RETRIES (5) budget", async () => {
    mockRecursiveStartResult = false;
    mockGitOnlyStartResult = true;
    const host = makeHost({ isElevated: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);

    ctrl.start();

    await settle();
    // 5 retries × 30s — should attempt to upgrade but always fail.
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(31_000);
    }
    // After exhaustion, no further retry scheduled.
    const startsAtCap = watcherStartCallCount;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(watcherStartCallCount).toBe(startsAtCap);
  });

  it("update() rotates without resetting the retry budget", async () => {
    mockRecursiveStartResult = false;
    mockGitOnlyStartResult = true;
    const host = makeHost({ isElevated: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);

    ctrl.start();

    await settle();
    // Burn 2 retries.
    await vi.advanceTimersByTimeAsync(31_000);
    await vi.advanceTimersByTimeAsync(31_000);

    // Rotate (e.g. branch checkout) — budget should NOT reset.
    ctrl.update();
    await settle();

    // Now allow recursive to succeed; remaining budget = 3 retries.
    mockRecursiveStartResult = true;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(ctrl.currentMode).toBe("recursive");
  });

  it("stop(true) resets the retry budget — restart allows a full 5-retry budget", async () => {
    mockRecursiveStartResult = false;
    mockGitOnlyStartResult = true;
    const host = makeHost({ isElevated: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);

    // Burn 3 retries on the first run.
    ctrl.start();
    await settle();
    await vi.advanceTimersByTimeAsync(31_000);
    await vi.advanceTimersByTimeAsync(31_000);
    await vi.advanceTimersByTimeAsync(31_000);

    ctrl.stop(true);

    // Restart — fresh budget should mean recursive can succeed within budget.
    ctrl.start();
    await settle();
    // Now allow recursive to succeed at the next retry — budget was reset
    // so retryCount=1 at this point. If reset failed and budget was still
    // close to MAX_RETRIES, recursive might never get an upgrade.
    mockRecursiveStartResult = true;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(ctrl.currentMode).toBe("recursive");
  });

  it("stop(false) preserves the retry budget — exhausted budget stays exhausted across rotation", async () => {
    mockRecursiveStartResult = false;
    mockGitOnlyStartResult = true;
    const host = makeHost({ isElevated: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);

    // Exhaust the entire 5-retry budget on the first run.
    ctrl.start();
    await settle();
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(31_000);
    }

    // Capture starts after exhaustion — confirm we hit the cap.
    const startsAtExhaustion = watcherStartCallCount;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(watcherStartCallCount).toBe(startsAtExhaustion);

    // Rotation should NOT grant a fresh budget — stop(false) preserves count.
    ctrl.stop(false);
    ctrl.start();
    await settle();
    const startsAfterRotation = watcherStartCallCount;

    // Even if recursive could succeed now, no retry should fire because
    // the budget was already exhausted before rotation.
    mockRecursiveStartResult = true;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(watcherStartCallCount).toBe(startsAfterRotation);
    expect(ctrl.currentMode).toBe("git-only");
  });

  it("ensureState() stops the watcher when gitWatchEnabled flips off", async () => {
    mockWatcherStartResult = true;
    const host = makeHost();
    const ctrl = new WatcherController(host as WatcherControllerHost);

    ctrl.start();

    await settle();
    expect(ctrl.hasWatcher).toBe(true);

    host.gitWatchEnabled = false;
    ctrl.ensureState();
    await settle();
    expect(ctrl.hasWatcher).toBe(false);
  });

  it("ensureState() starts the watcher when re-enabled mid-run", async () => {
    const host = makeHost({ gitWatchEnabled: false });
    const ctrl = new WatcherController(host as WatcherControllerHost);

    ctrl.ensureState();

    await settle();
    expect(ctrl.hasWatcher).toBe(false);

    mockWatcherStartResult = true;
    host.gitWatchEnabled = true;
    ctrl.ensureState();
    await settle();
    expect(ctrl.hasWatcher).toBe(true);
  });

  it("ensureState() rotates when granularity disagrees with focus", async () => {
    mockWatcherStartResult = true;
    const host = makeHost({ isElevated: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);

    ctrl.start();

    await settle();
    expect(ctrl.currentMode).toBe("recursive");

    host.isElevated = false;
    ctrl.ensureState();
    await settle();
    expect(ctrl.currentMode).toBe("git-only");
  });

  it("triggers onTriggerUpdate when a file change arrives outside the cooldown", async () => {
    mockWatcherStartResult = true;
    const host = makeHost({ lastGitStatusCompletedAt: 0 });
    const ctrl = new WatcherController(host as WatcherControllerHost);
    ctrl.start();
    await settle();

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
    await settle();

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

  it("queues the pending flag when a change arrives within the cooldown window", async () => {
    mockWatcherStartResult = true;
    const host = makeHost({ lastGitStatusCompletedAt: Date.now() });
    const ctrl = new WatcherController(host as WatcherControllerHost);
    ctrl.start();
    await settle();

    (capturedWatcherOptions?.onChange as () => void)();
    expect(host.onTriggerUpdate).not.toHaveBeenCalled();

    // Pending is set; flushing later will trigger.
    ctrl.flushPendingIfReady(false);
    expect(host.onTriggerUpdate).toHaveBeenCalledTimes(1);
  });

  it("flushPendingIfReady(respectDebounce=true) is a no-op while a debounce timer is armed", async () => {
    mockWatcherStartResult = true;
    const host = makeHost({ isUpdating: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);
    ctrl.start();
    await settle();

    (capturedWatcherOptions?.onChange as () => void)();
    // Debounce timer is armed. Now finalize the update.
    host.isUpdating = false;
    ctrl.flushPendingIfReady(true);
    // Still no trigger — debounce will handle it.
    expect(host.onTriggerUpdate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(301);
    expect(host.onTriggerUpdate).toHaveBeenCalledTimes(1);
  });

  it("scheduleDelayedFlush() arms a debounce timer that flushes when ready", async () => {
    mockWatcherStartResult = true;
    const host = makeHost();
    const ctrl = new WatcherController(host as WatcherControllerHost);
    ctrl.start();
    await settle();

    ctrl.markPending();
    ctrl.scheduleDelayedFlush();
    expect(host.onTriggerUpdate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(301);
    expect(host.onTriggerUpdate).toHaveBeenCalledTimes(1);
  });

  it("clearRetryTimer() cancels the retry without disposing the watcher", async () => {
    mockRecursiveStartResult = false;
    mockGitOnlyStartResult = true;
    const host = makeHost({ isElevated: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);

    ctrl.start();

    await settle();
    expect(ctrl.currentMode).toBe("git-only");

    ctrl.clearRetryTimer();
    mockRecursiveStartResult = true;
    await vi.advanceTimersByTimeAsync(120_000);
    // No retry — still git-only.
    expect(ctrl.currentMode).toBe("git-only");
    // But the watcher is still active.
    expect(ctrl.hasWatcher).toBe(true);
  });

  it("stop(true) clears watcher and retry state", async () => {
    mockWatcherStartResult = true;
    const host = makeHost();
    const ctrl = new WatcherController(host as WatcherControllerHost);

    ctrl.start();

    await settle();
    ctrl.stop(true);
    expect(ctrl.hasWatcher).toBe(false);
    expect(ctrl.currentMode).toBe("none");
  });

  it("stop(true) cancels pending retry timers", async () => {
    mockRecursiveStartResult = false;
    mockGitOnlyStartResult = true;
    const host = makeHost({ isElevated: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);

    ctrl.start();

    await settle();
    ctrl.stop(true);
    mockRecursiveStartResult = true;
    await vi.advanceTimersByTimeAsync(120_000);
    // No retry should have run.
    expect(ctrl.currentMode).toBe("none");
  });

  it("forwards onInotifyLimitReached and onEmfileLimitReached", async () => {
    mockWatcherStartResult = true;
    const host = makeHost();
    const ctrl = new WatcherController(host as WatcherControllerHost);
    ctrl.start();
    await settle();

    capturedOnInotifyLimitReached?.();
    capturedOnEmfileLimitReached?.();
    expect(host.onInotifyLimitReached).toHaveBeenCalledWith("/test/worktree");
    expect(host.onEmfileLimitReached).toHaveBeenCalledWith("/test/worktree");
  });

  it("forwards onWorktreeFilesChanged to the host when the recursive watcher flushes", async () => {
    mockWatcherStartResult = true;
    const host = makeHost({ isElevated: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);
    ctrl.start();
    await settle();

    const fireWorktreeFilesChanged = capturedWatcherOptions?.onWorktreeFilesChanged as
      (() => void) | undefined;
    expect(fireWorktreeFilesChanged).toBeDefined();

    fireWorktreeFilesChanged?.();
    expect(host.onWorktreeFilesChanged).toHaveBeenCalledTimes(1);
  });

  it("drops a late onWorktreeFilesChanged once the host is no longer running", async () => {
    mockWatcherStartResult = true;
    const host = makeHost({ isElevated: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);
    ctrl.start();
    await settle();

    const fireWorktreeFilesChanged = capturedWatcherOptions?.onWorktreeFilesChanged as
      (() => void) | undefined;

    // A watcher rotated out (or a stopped controller) can still fire its
    // debounced flush; the controller-level guard must not stamp the host
    // after teardown.
    host.isRunning = false;
    ctrl.stop();
    fireWorktreeFilesChanged?.();

    expect(host.onWorktreeFilesChanged).not.toHaveBeenCalled();
  });

  it("uses the 250ms worktree min-debounce floor", async () => {
    mockWatcherStartResult = true;
    const host = makeHost({ isElevated: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);
    ctrl.start();
    await settle();

    expect(capturedWatcherOptions).toMatchObject({ worktreeMinDebounceMs: 250 });
  });

  it("handleElevationChange(false) defers the downgrade by the settle delay", async () => {
    mockWatcherStartResult = true;
    const host = makeHost({ isElevated: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);
    ctrl.start();
    await settle();
    expect(ctrl.currentMode).toBe("recursive");
    const startsBeforeFlip = watcherStartCallCount;

    host.isElevated = false;
    const rotated = ctrl.handleElevationChange(false);
    await settle();

    expect(rotated).toBe(false);
    // No synchronous rebuild — the recursive watcher stays armed.
    expect(watcherStartCallCount).toBe(startsBeforeFlip);
    expect(ctrl.currentMode).toBe("recursive");

    // After the 3s settle delay, the controller rebuilds in git-only mode.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(watcherStartCallCount).toBe(startsBeforeFlip + 1);
    expect(ctrl.currentMode).toBe("git-only");
  });

  it("handleElevationChange(true) cancels a pending downgrade and keeps recursive", async () => {
    mockWatcherStartResult = true;
    const host = makeHost({ isElevated: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);
    ctrl.start();
    await settle();
    const startsBeforeFlip = watcherStartCallCount;

    host.isElevated = false;
    ctrl.handleElevationChange(false);
    await settle();

    // Re-focus before the settle window elapses.
    await vi.advanceTimersByTimeAsync(1_500);
    host.isElevated = true;
    const rotated = ctrl.handleElevationChange(true);
    await settle();

    // Already recursive — no rotation needed.
    expect(rotated).toBe(false);

    // Let the original settle window pass — the timer should not fire.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(watcherStartCallCount).toBe(startsBeforeFlip);
    expect(ctrl.currentMode).toBe("recursive");
  });

  it("handleElevationChange(true) immediately upgrades a git-only watcher and reports rotation", async () => {
    mockWatcherStartResult = true;
    const host = makeHost({ isElevated: false });
    const ctrl = new WatcherController(host as WatcherControllerHost);
    ctrl.start();
    await settle();
    expect(ctrl.currentMode).toBe("git-only");
    const startsBeforeFlip = watcherStartCallCount;

    host.isElevated = true;
    const rotated = ctrl.handleElevationChange(true);
    await settle();

    expect(rotated).toBe(true);
    expect(watcherStartCallCount).toBe(startsBeforeFlip + 1);
    expect(ctrl.currentMode).toBe("recursive");
  });

  it("stop() cancels a pending downgrade timer", async () => {
    mockWatcherStartResult = true;
    const host = makeHost({ isElevated: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);
    ctrl.start();
    await settle();
    const startsBeforeFlip = watcherStartCallCount;

    host.isElevated = false;
    ctrl.handleElevationChange(false);
    await settle();
    ctrl.stop(true);

    await vi.advanceTimersByTimeAsync(5_000);
    // Timer was cleared — no rebuild fired after stop.
    expect(watcherStartCallCount).toBe(startsBeforeFlip);
    expect(ctrl.currentMode).toBe("none");
  });

  it("arms a drain timer when a change arrives inside the cooldown window", async () => {
    mockWatcherStartResult = true;
    // Pin "now" at t=2s and place `lastGitStatusCompletedAt` 500ms back —
    // we're 500ms into the 1s self-trigger cooldown, so the drain should
    // fire at t≈2.51s.
    vi.setSystemTime(2_000);
    const host = makeHost({ lastGitStatusCompletedAt: 1_500 });
    const ctrl = new WatcherController(host as WatcherControllerHost);
    ctrl.start();
    await settle();

    (capturedWatcherOptions?.onChange as () => void)();
    expect(host.onTriggerUpdate).not.toHaveBeenCalled();

    // Advance past the remaining cooldown + the 10ms epsilon.
    await vi.advanceTimersByTimeAsync(600);
    expect(host.onTriggerUpdate).toHaveBeenCalledTimes(1);
  });

  it("does not double-arm the drain timer when multiple changes land in the cooldown", async () => {
    mockWatcherStartResult = true;
    vi.setSystemTime(2_000);
    const host = makeHost({ lastGitStatusCompletedAt: 1_500 });
    const ctrl = new WatcherController(host as WatcherControllerHost);
    ctrl.start();
    await settle();

    const onChange = capturedWatcherOptions?.onChange as () => void;
    onChange();
    onChange();
    onChange();

    await vi.advanceTimersByTimeAsync(600);
    // Drain still fires exactly once — pending flag collapses bursts.
    expect(host.onTriggerUpdate).toHaveBeenCalledTimes(1);
  });

  it("ensureState() does not bypass a pending downgrade timer", async () => {
    mockWatcherStartResult = true;
    const host = makeHost({ isElevated: true });
    const ctrl = new WatcherController(host as WatcherControllerHost);
    ctrl.start();
    await settle();
    expect(ctrl.currentMode).toBe("recursive");
    const startsBeforeFlip = watcherStartCallCount;

    // Simulate WorkspaceService.updateWorktrees: set isElevated then call
    // ensureState. The downgrade timer must keep the recursive watcher
    // alive through the periodic reconciliation pass.
    host.isElevated = false;
    ctrl.handleElevationChange(false);
    await settle();
    ctrl.ensureState();
    await settle();

    expect(watcherStartCallCount).toBe(startsBeforeFlip);
    expect(ctrl.currentMode).toBe("recursive");

    // After the settle delay, the controller rebuilds in git-only mode.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(ctrl.currentMode).toBe("git-only");
    expect(watcherStartCallCount).toBe(startsBeforeFlip + 1);
  });

  it("handleElevationChange(true) starts a watcher when none exists", async () => {
    // Simulate: a previous start failed (mode 'none', no watcher), then
    // the user focuses this worktree via setActiveWorktree. The watcher
    // must be re-attempted, not silently skipped.
    mockWatcherStartResult = false;
    const host = makeHost({ isElevated: false });
    const ctrl = new WatcherController(host as WatcherControllerHost);
    ctrl.start();
    await settle();
    expect(ctrl.hasWatcher).toBe(false);
    expect(ctrl.currentMode).toBe("none");
    const startsBeforeFlip = watcherStartCallCount;

    mockWatcherStartResult = true;
    host.isElevated = true;
    const rotated = ctrl.handleElevationChange(true);
    await settle();

    expect(rotated).toBe(true);
    expect(watcherStartCallCount).toBe(startsBeforeFlip + 1);
    expect(ctrl.hasWatcher).toBe(true);
    expect(ctrl.currentMode).toBe("recursive");
  });

  it("stop() cancels a pending cooldown drain timer", async () => {
    mockWatcherStartResult = true;
    vi.setSystemTime(2_000);
    const host = makeHost({ lastGitStatusCompletedAt: 1_500 });
    const ctrl = new WatcherController(host as WatcherControllerHost);
    ctrl.start();
    await settle();

    (capturedWatcherOptions?.onChange as () => void)();
    ctrl.stop(true);

    await vi.advanceTimersByTimeAsync(1_000);
    // Drain timer cleared on stop — no flush fires after teardown.
    expect(host.onTriggerUpdate).not.toHaveBeenCalled();
  });

  describe("resetRetryBudget", () => {
    it("resets exhausted budget so subsequent failure schedules a retry", async () => {
      mockRecursiveStartResult = false;
      mockGitOnlyStartResult = true;
      const host = makeHost({ isElevated: true });
      const ctrl = new WatcherController(host as WatcherControllerHost);

      ctrl.start();

      await settle();
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(31_000);
      }
      const startsAtExhaustion = watcherStartCallCount;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(watcherStartCallCount).toBe(startsAtExhaustion);

      const result = ctrl.resetRetryBudget();
      expect(result).toBe(true);

      // update() tears down git-only and re-attempts recursive. Recursive
      // fails → git-only installed + scheduleRetry() with fresh counter.
      ctrl.update();
      await settle();
      await vi.advanceTimersByTimeAsync(31_000);
      expect(watcherStartCallCount).toBeGreaterThan(startsAtExhaustion);
    });

    it("no-ops when watcherRetryCount is zero (does not consume cap)", async () => {
      const host = makeHost({ isElevated: true });
      const ctrl = new WatcherController(host as WatcherControllerHost);
      const result = ctrl.resetRetryBudget();
      expect(result).toBe(false);

      // Should be able to reset after actual exhaustion.
      mockRecursiveStartResult = false;
      mockGitOnlyStartResult = true;
      ctrl.start();
      await settle();
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(31_000);
      }
      expect(ctrl.resetRetryBudget()).toBe(true);
    });

    it("capped at MAX_RESETS_PER_SESSION (3)", async () => {
      mockRecursiveStartResult = false;
      mockGitOnlyStartResult = true;
      const host = makeHost({ isElevated: true });
      const ctrl = new WatcherController(host as WatcherControllerHost);

      ctrl.start();

      await settle();
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(31_000);
      }

      // 3 resets allowed; update() re-arms after each reset so retries
      // can burn through the fresh budget.
      for (let r = 0; r < 3; r++) {
        expect(ctrl.resetRetryBudget()).toBe(true);
        ctrl.update();
        await settle();
        for (let i = 0; i < 6; i++) {
          await vi.advanceTimersByTimeAsync(31_000);
        }
      }
      // 4th reset denied.
      expect(ctrl.resetRetryBudget()).toBe(false);
    });

    it("clears a pending retry timer", async () => {
      mockRecursiveStartResult = false;
      mockGitOnlyStartResult = true;
      const host = makeHost({ isElevated: true });
      const ctrl = new WatcherController(host as WatcherControllerHost);

      ctrl.start();

      await settle();
      // Let one retry fire so a new timer for retry 2 is pending.
      await vi.advanceTimersByTimeAsync(31_000);
      const startsAfterOneRetry = watcherStartCallCount;

      const result = ctrl.resetRetryBudget();
      expect(result).toBe(true);

      // The pending timer was cleared — advancing 30s should NOT fire a retry
      // since the budget just reset (count=0) and nothing scheduled a new one.
      await vi.advanceTimersByTimeAsync(31_000);
      expect(watcherStartCallCount).toBe(startsAfterOneRetry);
    });

    it("stop(true) resets both the retry budget and the session cap", async () => {
      mockRecursiveStartResult = false;
      mockGitOnlyStartResult = true;
      const host = makeHost({ isElevated: true });
      const ctrl = new WatcherController(host as WatcherControllerHost);

      ctrl.start();

      await settle();
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(31_000);
      }
      // Consume all 3 resets.
      for (let r = 0; r < 3; r++) {
        expect(ctrl.resetRetryBudget()).toBe(true);
        ctrl.update();
        await settle();
        for (let i = 0; i < 6; i++) {
          await vi.advanceTimersByTimeAsync(31_000);
        }
      }
      expect(ctrl.resetRetryBudget()).toBe(false);

      // Full teardown resets the session cap.
      ctrl.stop(true);
      // After stop(true), budget starts fresh. Re-arm and exhaust.
      ctrl.start();
      await settle();
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(31_000);
      }
      expect(ctrl.resetRetryBudget()).toBe(true);
    });

    it("stop(false) preserves both the retry count and the session cap", async () => {
      mockRecursiveStartResult = false;
      mockGitOnlyStartResult = true;
      const host = makeHost({ isElevated: true });
      const ctrl = new WatcherController(host as WatcherControllerHost);

      ctrl.start();

      await settle();
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(31_000);
      }
      expect(ctrl.resetRetryBudget()).toBe(true);
      ctrl.update();
      await settle();
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(31_000);
      }
      // 2nd reset — should succeed (2 of 3 consumed).
      expect(ctrl.resetRetryBudget()).toBe(true);

      // stop(false) should NOT restore the 2 already-consumed resets.
      ctrl.stop(false);
      ctrl.start();
      await settle();
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(31_000);
      }
      const result = ctrl.resetRetryBudget();
      // After 2 resets consumed, the 3rd (last) should succeed.
      expect(result).toBe(true);
    });
  });
  describe("dark-watcher recovery (#12042)", () => {
    // Mode "none" is the only mode whose poll cadence falls back to the
    // adaptive profile interval, so a git-only arm that fails leaves the
    // monitor polling git several times a second. These cases pin that the
    // controller digs itself out without an external reconcile.

    it("re-arms after a git-only arm failure with no external ensureState call", async () => {
      mockWatcherStartResult = false;
      const host = makeHost({ isElevated: false });
      const ctrl = new WatcherController(host as WatcherControllerHost);

      ctrl.start();
      await settle();
      expect(ctrl.currentMode).toBe("none");
      const armsAfterFailure = watcherStartCallCount;

      // The fs error clears; nothing external touches the controller.
      mockWatcherStartResult = true;
      await vi.advanceTimersByTimeAsync(31_000);
      await settle();

      expect(watcherStartCallCount).toBeGreaterThan(armsAfterFailure);
      expect(ctrl.currentMode).toBe("git-only");
    });

    it("stops re-arming once the retry budget is spent, however long it idles", async () => {
      mockWatcherStartResult = false;
      const host = makeHost({ isElevated: false });
      const ctrl = new WatcherController(host as WatcherControllerHost);

      ctrl.start();
      await settle();
      const armsAfterFirstFailure = watcherStartCallCount;

      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(31_000);
        await settle();
      }
      const armsAfterExhaustion = watcherStartCallCount;
      // Retries genuinely happened (otherwise "it stopped" is vacuous)...
      expect(armsAfterExhaustion).toBeGreaterThan(armsAfterFirstFailure);
      // ...and they were charged to the shared budget, not a private counter:
      // resetRetryBudget only reports true for a non-zero count.
      expect(ctrl.resetRetryBudget()).toBe(true);

      // Hours of idling must not resurrect the loop — the whole point is that a
      // genuinely broken path stops paying for retries. (Measured before the
      // reset above hands it a fresh budget: re-read the count now.)
      const armsBeforeIdle = watcherStartCallCount;
      await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
      await settle();
      expect(watcherStartCallCount).toBe(armsBeforeIdle);
    });

    it("does not spend a retry when something else armed the watcher first", async () => {
      // The budget exists for genuine failures. A retry that fires to find the
      // topology reconcile already armed a watcher has nothing to attempt, and
      // consuming an attempt for it would starve the next real failure.
      mockWatcherStartResult = false;
      const host = makeHost({ isElevated: false });
      const ctrl = new WatcherController(host as WatcherControllerHost);

      ctrl.start();
      await settle();

      // External recovery lands before the backoff elapses.
      mockWatcherStartResult = true;
      ctrl.ensureState();
      await settle();
      expect(ctrl.currentMode).toBe("git-only");

      await vi.advanceTimersByTimeAsync(31_000);
      await settle();

      expect(ctrl.resetRetryBudget()).toBe(false);
    });

    it("re-derives the target tier when elevation flips during the backoff", async () => {
      mockWatcherStartResult = false;
      const host = makeHost({ isElevated: false });
      const ctrl = new WatcherController(host as WatcherControllerHost);

      ctrl.start();
      await settle();
      expect(ctrl.currentMode).toBe("none");

      // The worktree gains focus while the re-arm is pending, and by the time
      // it fires the recursive watcher is available again.
      host.isElevated = true;
      mockWatcherStartResult = true;
      await vi.advanceTimersByTimeAsync(31_000);
      await settle();

      expect(ctrl.currentMode).toBe("recursive");
    });

    it("does not stack a second retry loop when the git-only fallback also fails", async () => {
      // Recursive fails, and its git-only fallback fails too: two independent
      // failure paths both reach scheduleRetry. Counting arms can't distinguish
      // one loop from two (start()'s idempotency guard hides the duplicate), so
      // assert on the timer itself — the controller must own exactly one.
      mockWatcherStartResult = false;
      const host = makeHost({ isElevated: true });
      const ctrl = new WatcherController(host as WatcherControllerHost);

      ctrl.start();
      await settle();
      expect(vi.getTimerCount()).toBe(1);

      // And still exactly one after the retry fires and fails again.
      await vi.advanceTimersByTimeAsync(31_000);
      await settle();
      expect(vi.getTimerCount()).toBe(1);
    });

    it("arms exactly once per tick on the dark path", async () => {
      mockWatcherStartResult = false;
      const host = makeHost({ isElevated: false });
      const ctrl = new WatcherController(host as WatcherControllerHost);

      ctrl.start();
      await settle();
      expect(vi.getTimerCount()).toBe(1);
      const armsBeforeTick = watcherStartCallCount;

      await vi.advanceTimersByTimeAsync(31_000);
      await settle();

      expect(watcherStartCallCount - armsBeforeTick).toBe(1);
      expect(vi.getTimerCount()).toBe(1);
    });

    it("does not re-arm after the controller is stopped mid-backoff", async () => {
      mockWatcherStartResult = false;
      const host = makeHost({ isElevated: false });
      const ctrl = new WatcherController(host as WatcherControllerHost);

      ctrl.start();
      await settle();
      const armsAtStop = watcherStartCallCount;
      // Precondition: there IS a backoff to interrupt.
      expect(vi.getTimerCount()).toBe(1);

      ctrl.stop();
      mockWatcherStartResult = true;
      await vi.advanceTimersByTimeAsync(120_000);
      await settle();

      expect(watcherStartCallCount).toBe(armsAtStop);
      expect(ctrl.currentMode).toBe("none");
    });

    it("does not signal recovery for a cold start that never reached recursive", async () => {
      // wasDegraded must stay false: the host never surfaced a degraded
      // indicator, so there is nothing to clear.
      mockWatcherStartResult = false;
      const host = makeHost({ isElevated: false });
      const ctrl = new WatcherController(host as WatcherControllerHost);

      ctrl.start();
      await settle();

      host.isElevated = true;
      mockWatcherStartResult = true;
      await vi.advanceTimersByTimeAsync(31_000);
      await settle();

      expect(ctrl.currentMode).toBe("recursive");
      expect(host.onWatcherRecovered).not.toHaveBeenCalled();
    });
  });
});
