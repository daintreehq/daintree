import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Worktree } from "../../../shared/types/worktree.js";

const mockGetWorktreeChangesWithStats = vi.fn();
const mockInvalidateGitStatusCache = vi.fn();
const mockGitRaw = vi.fn();

const { mockCreateHardenedGit, mockCreateWslHardenedGit } = vi.hoisted(() => ({
  mockCreateHardenedGit: vi.fn(),
  mockCreateWslHardenedGit: vi.fn(),
}));

mockCreateHardenedGit.mockImplementation(() => ({
  raw: (...args: unknown[]) => mockGitRaw(...args),
  log: vi.fn().mockResolvedValue({ latest: null }),
}));
mockCreateWslHardenedGit.mockImplementation(() => ({
  raw: (...args: unknown[]) => mockGitRaw(...args),
  log: vi.fn().mockResolvedValue({ latest: null }),
}));

vi.mock("../../utils/hardenedGit.js", () => ({
  createHardenedGit: mockCreateHardenedGit,
  createWslHardenedGit: mockCreateWslHardenedGit,
  validateCwd: vi.fn(),
}));

vi.mock("../../utils/git.js", () => ({
  getWorktreeChangesWithStats: (...args: unknown[]) => mockGetWorktreeChangesWithStats(...args),
  invalidateGitStatusCache: (...args: unknown[]) => mockInvalidateGitStatusCache(...args),
}));

vi.mock("fs/promises", () => ({
  access: vi.fn().mockRejectedValue(new Error("ENOENT")),
  readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
  stat: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
}));

vi.mock("simple-git", () => ({
  simpleGit: vi.fn(() => ({ raw: vi.fn(), log: vi.fn().mockResolvedValue({ latest: null }) })),
}));

const { mockCategorizeWorktree } = vi.hoisted(() => ({
  mockCategorizeWorktree: vi.fn().mockReturnValue("stable"),
}));

vi.mock("../../services/worktree/mood.js", () => ({
  categorizeWorktree: mockCategorizeWorktree,
}));

vi.mock("../../services/issueExtractor.js", () => ({
  extractIssueNumberSync: vi.fn().mockReturnValue(null),
  extractIssueNumber: vi.fn().mockResolvedValue(null),
  deriveIssueTitleFromBranch: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../utils/gitUtils.js", () => ({
  getGitDir: vi.fn().mockReturnValue(null),
  clearGitDirCache: vi.fn(),
  clearGitCommonDirCache: vi.fn(),
}));

const mockGetRepoOperationStateSync = vi.fn().mockReturnValue(undefined);
vi.mock("../../utils/gitRepoOperationState.js", () => ({
  isRepoOperationInProgress: vi.fn().mockReturnValue(false),
  getRepoOperationStateSync: (...args: unknown[]) => mockGetRepoOperationStateSync(...args),
  OPERATION_SENTINEL_NAMES: [
    "MERGE_HEAD",
    "rebase-merge",
    "rebase-apply",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
  ],
}));

let mockWatcherStartResult = false;
/** Optional per-mode override. When set, takes precedence over `mockWatcherStartResult`
 *  for that mode, so a test can model "recursive fails, git-only succeeds". */
let mockRecursiveStartResult: boolean | undefined;
let mockGitOnlyStartResult: boolean | undefined;
/** When true, the stub's `start()` synchronously invokes `onWatcherFailed`
 *  before returning — mirroring the real startup-ENOSPC catch path. Only
 *  fires for recursive (`watchWorktree: true`) starts, matching the real
 *  watcher's behaviour where per-file `.git/` watchers never trigger the
 *  failure callback. */
let mockWatcherStartFiresFailure = false;
const capturedWatcherOptionsHistory: Record<string, unknown>[] = [];
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
        capturedWatcherOptionsHistory.push(opts);
      }
      start() {
        watcherStartCallCount++;
        const result = this.watchWorktree
          ? (mockRecursiveStartResult ?? mockWatcherStartResult)
          : (mockGitOnlyStartResult ?? mockWatcherStartResult);
        // Only the recursive arm reports failures via `onWatcherFailed`.
        if (this.watchWorktree && mockWatcherStartFiresFailure && !result) {
          this.onWatcherFailed?.();
        }
        return Promise.resolve(result);
      }
      dispose() {}
    },
  };
});

vi.mock("../../services/worktree/index.js", () => ({
  AdaptivePollingStrategy: vi.fn(function () {
    return {
      getCurrentInterval: vi.fn().mockReturnValue(2000),
      updateInterval: vi.fn(),
      reportActivity: vi.fn(),
      updateConfig: vi.fn(),
      isCircuitBreakerTripped: vi.fn().mockReturnValue(false),
      reset: vi.fn(),
      setBaseInterval: vi.fn(),
      calculateNextInterval: vi.fn().mockReturnValue(2000),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
      recordNoChange: vi.fn(),
      recordStateChange: vi.fn(),
    };
  }),
  NoteFileReader: vi.fn(function () {
    return { read: vi.fn().mockResolvedValue({}) };
  }),
}));

import { WorktreeMonitor } from "../WorktreeMonitor.js";
import type { WorktreeMonitorConfig, WorktreeMonitorCallbacks } from "../WorktreeMonitor.js";
import { getGitDir } from "../../utils/gitUtils.js";
import { stat, readFile } from "fs/promises";

const TEST_WORKTREE: Worktree = {
  id: "/test/worktree",
  path: "/test/worktree",
  name: "test-branch",
  branch: "test-branch",
  isCurrent: false,
  isMainWorktree: false,
};

const TEST_CONFIG: WorktreeMonitorConfig = {
  basePollingInterval: 2000,
  adaptiveBackoff: false,
  pollIntervalMax: 10000,
  circuitBreakerThreshold: 5,
  gitWatchEnabled: false,
};

function makeCallbacks(overrides?: Partial<WorktreeMonitorCallbacks>): WorktreeMonitorCallbacks {
  return {
    onUpdate: vi.fn(),
    onRemoved: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

// Matches STATUS_INITIAL_DELAY_MIN_MS in WorktreeMonitor.ts. Background
// monitors defer their initial updateGitStatus through a 2-5s jitter timer,
// so tests must advance fake timers past the lower bound before asserting
// on onUpdate / hasInitialStatus. Math.random() is mocked to 0 in
// beforeEach, pinning the jitter to the minimum (2000ms). Advance by
// exactly the minimum so the follow-on poll (scheduled at +2000ms from
// when the initial fires) doesn't also fire and inflate call counts.
const STATUS_INITIAL_DELAY_MIN_MS = 2_000;

async function flushInitialStatus(): Promise<void> {
  await vi.advanceTimersByTimeAsync(STATUS_INITIAL_DELAY_MIN_MS);
}

describe("WorktreeMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.clearAllMocks();
    mockCategorizeWorktree.mockReturnValue("stable");
    mockWatcherStartResult = false;
    mockRecursiveStartResult = undefined;
    mockGitOnlyStartResult = undefined;
    mockWatcherStartFiresFailure = false;
    watcherStartCallCount = 0;
    capturedWatcherOptionsHistory.length = 0;
    mockGetRepoOperationStateSync.mockReturnValue(undefined);
    vi.mocked(getGitDir).mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("background fetch scheduling", () => {
    const CLEAN_CHANGES = {
      worktreeId: "/test/worktree",
      rootPath: "/test",
      changes: [],
      changedFileCount: 0,
      lastUpdated: Date.now(),
    };

    beforeEach(() => {
      mockGetWorktreeChangesWithStats.mockResolvedValue(CLEAN_CHANGES);
      mockGitRaw.mockResolvedValue("0\t0\n");
    });

    it("invokes onScheduleFetch after the initial-delay window once running", async () => {
      const onScheduleFetch = vi.fn().mockResolvedValue(undefined);
      const callbacks = makeCallbacks({ onScheduleFetch });
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");

      await monitor.start();
      expect(onScheduleFetch).not.toHaveBeenCalled();

      // Advance past the initial-delay max (5s) so the timer fires.
      await vi.advanceTimersByTimeAsync(6_000);
      expect(onScheduleFetch).toHaveBeenCalledTimes(1);
      expect(onScheduleFetch).toHaveBeenCalledWith(TEST_WORKTREE.id, false, false, undefined);

      monitor.stop();
    });

    it("clears the fetch timer in stop()", async () => {
      const onScheduleFetch = vi.fn().mockResolvedValue(undefined);
      const callbacks = makeCallbacks({ onScheduleFetch });
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");

      await monitor.start();
      monitor.stop();

      // Advance well past the longest possible fetch interval.
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
      expect(onScheduleFetch).not.toHaveBeenCalled();
    });

    it("triggerFetchNow() calls the callback with force=true", async () => {
      const onScheduleFetch = vi.fn().mockResolvedValue(undefined);
      const callbacks = makeCallbacks({ onScheduleFetch });
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");

      await monitor.start();
      onScheduleFetch.mockClear();

      await monitor.triggerFetchNow();
      expect(onScheduleFetch).toHaveBeenCalledWith(TEST_WORKTREE.id, false, true, undefined);

      monitor.stop();
    });

    it("does not schedule fetches when onScheduleFetch is not provided", async () => {
      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");

      await monitor.start();
      // No callback registered — there should be no errors and no scheduling.
      await vi.advanceTimersByTimeAsync(60_000);

      monitor.stop();
    });

    it("triggerFetchNow() defers behind a pending fetch and runs after it lands", async () => {
      let resolveFirst: (() => void) | undefined;
      const invocations: Array<{ force: boolean }> = [];
      const onScheduleFetch = vi
        .fn()
        .mockImplementation((_id: string, _isCurrent: boolean, force: boolean) => {
          invocations.push({ force });
          if (invocations.length === 1) {
            return new Promise<void>((res) => {
              resolveFirst = res;
            });
          }
          return Promise.resolve();
        });

      const callbacks = makeCallbacks({ onScheduleFetch });
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");

      await monitor.start();
      // Let the initial-delay timer fire so the first (non-force) fetch starts.
      await vi.advanceTimersByTimeAsync(6_000);
      expect(invocations).toEqual([{ force: false }]);
      expect(resolveFirst).toBeDefined();

      // Issue a force request while the first is pending. It must not be lost.
      const triggered = monitor.triggerFetchNow();

      for (let i = 0; i < 5; i++) await Promise.resolve();
      // Still only 1 invocation — the force request is deferred.
      expect(invocations).toHaveLength(1);

      // Resolve the first; the deferred force should fire next.
      resolveFirst?.();
      await triggered;
      for (let i = 0; i < 10; i++) await Promise.resolve();

      expect(invocations).toEqual([{ force: false }, { force: true }]);

      monitor.stop();
    });

    it("flips isFetchInFlight true while a fetch is pending and false after", async () => {
      let resolveFetch: (() => void) | undefined;
      const onScheduleFetch = vi.fn().mockImplementation(() => {
        return new Promise<void>((res) => {
          resolveFetch = res;
        });
      });

      const onUpdate = vi.fn();
      const callbacks = makeCallbacks({ onScheduleFetch, onUpdate });
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");

      await monitor.start();
      onUpdate.mockClear();

      // Fire the initial-delay timer.
      await vi.advanceTimersByTimeAsync(6_000);
      // Drain microtasks so the runFetch's start-emit lands.
      for (let i = 0; i < 5; i++) await Promise.resolve();

      // While in-flight, the snapshot should report isFetchInFlight=true.
      const startSnapshot = monitor.getSnapshot();
      expect(startSnapshot.isFetchInFlight).toBe(true);

      // Resolve the fetch and confirm it flips back to false.
      resolveFetch?.();
      for (let i = 0; i < 10; i++) await Promise.resolve();
      const endSnapshot = monitor.getSnapshot();
      expect(endSnapshot.isFetchInFlight).toBeFalsy();

      monitor.stop();
    });

    it("setFetchState mirrors lastFetchedAt and fetchAuthFailed into the snapshot", async () => {
      const onUpdate = vi.fn();
      const callbacks = makeCallbacks({ onUpdate });
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
      await monitor.start();
      await flushInitialStatus();

      onUpdate.mockClear();
      monitor.setFetchState(1700000000000, false);
      const afterFirst = monitor.getSnapshot();
      expect(afterFirst.lastFetchedAt).toBe(1700000000000);
      expect(afterFirst.fetchAuthFailed).toBeFalsy();
      expect(onUpdate).toHaveBeenCalled();

      onUpdate.mockClear();
      monitor.setFetchState(1700000060000, true);
      const afterAuthFail = monitor.getSnapshot();
      expect(afterAuthFail.lastFetchedAt).toBe(1700000060000);
      expect(afterAuthFail.fetchAuthFailed).toBe(true);
      expect(onUpdate).toHaveBeenCalled();

      // Idempotent — repeating the same values should not re-emit.
      onUpdate.mockClear();
      monitor.setFetchState(1700000060000, true);
      expect(onUpdate).not.toHaveBeenCalled();

      monitor.stop();
    });

    it("setMatchedForgeProviderId mirrors into the snapshot and is idempotent", async () => {
      const onUpdate = vi.fn();
      const callbacks = makeCallbacks({ onUpdate });
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
      await monitor.start();
      await flushInitialStatus();

      // Default is null (undefined-on-the-wire) until set.
      expect(monitor.getSnapshot().matchedForgeProviderId).toBeUndefined();

      onUpdate.mockClear();
      monitor.setMatchedForgeProviderId("daintree.github.github");
      expect(monitor.getSnapshot().matchedForgeProviderId).toBe("daintree.github.github");
      expect(onUpdate).toHaveBeenCalled();

      onUpdate.mockClear();
      monitor.setMatchedForgeProviderId("daintree.github.github");
      expect(onUpdate).not.toHaveBeenCalled();

      monitor.stop();
    });

    it("setMatchedForgeProviderId / setFetchState do not emit after stop()", async () => {
      const onUpdate = vi.fn();
      const callbacks = makeCallbacks({ onUpdate });
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
      await monitor.start();
      monitor.stop();

      onUpdate.mockClear();
      // Late-resolving probe / coordinator fan-out must not re-add a ghost
      // card to the renderer after the monitor has been torn down.
      monitor.setMatchedForgeProviderId("daintree.github.github");
      monitor.setFetchState(1700000000000, false, false);
      monitor.setFetchState(1700000000000, true, false);

      expect(onUpdate).not.toHaveBeenCalled();
    });

    it("setFetchState surfaces fetchNetworkFailed in the snapshot", async () => {
      const onUpdate = vi.fn();
      const callbacks = makeCallbacks({ onUpdate });
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
      await monitor.start();
      await flushInitialStatus();

      onUpdate.mockClear();
      monitor.setFetchState(1700000000000, false, true);
      const snap = monitor.getSnapshot();
      expect(snap.fetchNetworkFailed).toBe(true);
      expect(snap.fetchAuthFailed).toBeFalsy();
      expect(onUpdate).toHaveBeenCalled();

      // Idempotent on no-change.
      onUpdate.mockClear();
      monitor.setFetchState(1700000000000, false, true);
      expect(onUpdate).not.toHaveBeenCalled();

      monitor.stop();
    });
  });

  describe("startup jitter", () => {
    const CLEAN_CHANGES = {
      worktreeId: "/test/worktree",
      rootPath: "/test",
      changes: [],
      changedFileCount: 0,
      lastUpdated: Date.now(),
    };

    it("defers initial git status for background monitors", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValue(CLEAN_CHANGES);
      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");

      await monitor.start();
      // start() returns once the jitter timer is armed; updateGitStatus
      // has not yet been called.
      expect(mockGetWorktreeChangesWithStats).not.toHaveBeenCalled();
      expect(monitor.hasInitialStatus).toBe(false);

      await flushInitialStatus();
      expect(mockGetWorktreeChangesWithStats).toHaveBeenCalledTimes(1);
      expect(monitor.hasInitialStatus).toBe(true);

      monitor.stop();
    });

    it("runs initial git status synchronously for current monitors", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValue(CLEAN_CHANGES);
      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(
        { ...TEST_WORKTREE, isCurrent: true },
        TEST_CONFIG,
        callbacks,
        "main"
      );

      await monitor.start();
      // Foreground path runs synchronously — the snapshot is already there
      // when start() resolves.
      expect(mockGetWorktreeChangesWithStats).toHaveBeenCalledTimes(1);
      expect(monitor.hasInitialStatus).toBe(true);

      monitor.stop();
    });

    it("stop() before the jitter window suppresses the deferred poll", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValue(CLEAN_CHANGES);
      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");

      await monitor.start();
      monitor.stop();
      await flushInitialStatus();
      // Advance well past any potential follow-on poll too.
      await vi.advanceTimersByTimeAsync(60_000);

      expect(mockGetWorktreeChangesWithStats).not.toHaveBeenCalled();
      expect(callbacks.onUpdate).not.toHaveBeenCalled();
    });
  });

  describe("stat pre-check", () => {
    const CLEAN_CHANGES = {
      worktreeId: "/test/worktree",
      rootPath: "/test",
      changes: [],
      changedFileCount: 0,
      lastUpdated: Date.now(),
    };

    beforeEach(() => {
      vi.mocked(getGitDir).mockResolvedValue("/test/worktree/.git");
      // No commondir file → commondir defaults to gitDir for the test worktree
      vi.mocked(readFile).mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
      mockGetWorktreeChangesWithStats.mockResolvedValue(CLEAN_CHANGES);
    });

    function makeStatResult(mtimeMs: number): Awaited<ReturnType<typeof stat>> {
      return { mtimeMs } as unknown as Awaited<ReturnType<typeof stat>>;
    }

    it("skips the simple-git fork when stat mtimes are unchanged", async () => {
      vi.mocked(stat).mockResolvedValue(makeStatResult(1_000));
      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");

      // First run builds the baseline.
      await monitor.start();
      await flushInitialStatus();
      expect(mockGetWorktreeChangesWithStats).toHaveBeenCalledTimes(1);

      // Second non-forced run: stats match baseline → no git fork.
      await monitor.updateGitStatus(false);
      expect(mockGetWorktreeChangesWithStats).toHaveBeenCalledTimes(1);

      monitor.stop();
    });

    it("falls through to the full check when index mtime moved", async () => {
      vi.mocked(stat).mockResolvedValue(makeStatResult(1_000));
      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");

      await monitor.start();
      await flushInitialStatus();
      expect(mockGetWorktreeChangesWithStats).toHaveBeenCalledTimes(1);

      // Advance the mtime — the next non-forced poll must run the full check.
      vi.mocked(stat).mockResolvedValue(makeStatResult(2_000));
      await monitor.updateGitStatus(false);
      expect(mockGetWorktreeChangesWithStats).toHaveBeenCalledTimes(2);

      monitor.stop();
    });

    it("falls through when a watcher event fired after the baseline was captured", async () => {
      vi.mocked(stat).mockResolvedValue(makeStatResult(1_000));
      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");

      await monitor.start();
      await flushInitialStatus();
      expect(mockGetWorktreeChangesWithStats).toHaveBeenCalledTimes(1);

      // Simulate a watcher event arriving after the baseline timestamp.
      const baselineAt = (monitor as unknown as { lastStatBaselineAt: number }).lastStatBaselineAt;
      (monitor as unknown as { lastWatcherEventAt: number }).lastWatcherEventAt = baselineAt + 1;

      await monitor.updateGitStatus(false);
      expect(mockGetWorktreeChangesWithStats).toHaveBeenCalledTimes(2);

      monitor.stop();
    });

    it("a failed git check does not let the next non-forced poll skip", async () => {
      vi.mocked(stat).mockResolvedValue(makeStatResult(1_000));
      mockGetWorktreeChangesWithStats.mockReset();
      mockGetWorktreeChangesWithStats.mockRejectedValueOnce(new Error("git stalled"));
      mockGetWorktreeChangesWithStats.mockResolvedValue(CLEAN_CHANGES);

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");

      // Initial deferred poll throws inside the timer callback; the .catch in
      // start() swallows it but mood=error has already been emitted.
      await monitor.start();
      await flushInitialStatus();
      expect(mockGetWorktreeChangesWithStats).toHaveBeenCalledTimes(1);
      expect(monitor.getSnapshot().mood).toBe("error");

      // Next non-forced poll: stats haven't moved, but the previous error
      // cleared the baseline so the stat pre-check can't short-circuit.
      await monitor.updateGitStatus(false);
      expect(mockGetWorktreeChangesWithStats).toHaveBeenCalledTimes(2);

      monitor.stop();
    });

    it("forces a real check once the full-status budget expires without recursive coverage", async () => {
      vi.mocked(stat).mockResolvedValue(makeStatResult(1_000));
      const callbacks = makeCallbacks();
      // TEST_CONFIG has gitWatchEnabled: false — no watcher covers the
      // working tree, the exact mode where the four statted .git files can
      // never reflect an agent's unstaged edits.
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");

      await monitor.start();
      await flushInitialStatus();
      expect(mockGetWorktreeChangesWithStats).toHaveBeenCalledTimes(1);

      // Within the budget the skip still applies…
      await monitor.updateGitStatus(false);
      expect(mockGetWorktreeChangesWithStats).toHaveBeenCalledTimes(1);

      // …but once the last FULL pass ages past the ceiling, a matching
      // baseline no longer suppresses the real git check.
      (monitor as unknown as { lastFullStatusAt: number }).lastFullStatusAt = Date.now() - 120_001;
      await monitor.updateGitStatus(false);
      expect(mockGetWorktreeChangesWithStats).toHaveBeenCalledTimes(2);

      // The full pass reset the budget — the next poll skips again.
      await monitor.updateGitStatus(false);
      expect(mockGetWorktreeChangesWithStats).toHaveBeenCalledTimes(2);

      monitor.stop();
    });

    it("an expired full-status budget does not bypass the skip under recursive coverage", async () => {
      vi.mocked(stat).mockResolvedValue(makeStatResult(1_000));
      mockWatcherStartResult = true;
      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(
        { ...TEST_WORKTREE, isCurrent: true },
        { ...TEST_CONFIG, gitWatchEnabled: true },
        callbacks,
        "main"
      );

      // Active monitors run the initial status synchronously in start().
      await monitor.start();
      expect(mockGetWorktreeChangesWithStats).toHaveBeenCalledTimes(1);

      (monitor as unknown as { lastFullStatusAt: number }).lastFullStatusAt = Date.now() - 120_001;
      await monitor.updateGitStatus(false);
      // The recursive watcher observes every working-tree write and forces
      // its own refreshes, so the stat skip stays trustworthy indefinitely.
      expect(mockGetWorktreeChangesWithStats).toHaveBeenCalledTimes(1);

      monitor.stop();
    });
  });

  describe("poll watchdog (sidebar-freeze guard)", () => {
    // Drive a single poll() in isolation: set _isRunning directly instead of
    // start() so the deferred initial-status timer can't fire its own
    // scheduleNextPoll during the watchdog advance and mask the path under test.
    function makeRunningMonitor(): WorktreeMonitor {
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, makeCallbacks(), "main");
      (monitor as unknown as { _isRunning: boolean })._isRunning = true;
      return monitor;
    }

    it("reschedules the loop when a git status pass hangs instead of wedging forever", async () => {
      // Simulate a hung git/fs call inside updateGitStatus — the exact failure
      // that previously pinned the poll loop (and, via the shared pollQueue
      // slot, the whole sidebar) permanently with no recovery.
      mockGetWorktreeChangesWithStats.mockReturnValue(new Promise<never>(() => {}));

      const monitor = makeRunningMonitor();
      const scheduleSpy = vi
        .spyOn(monitor as unknown as { scheduleNextPoll: () => void }, "scheduleNextPoll")
        .mockImplementation(() => {});

      const pollPromise = (monitor as unknown as { poll: () => Promise<void> }).poll();
      await Promise.resolve();

      // The poll actually entered updateGitStatus and is hanging on the git call
      // (it did NOT early-return on a stale _isUpdating guard).
      expect(mockGetWorktreeChangesWithStats).toHaveBeenCalledTimes(1);

      // Before the watchdog fires the loop is legitimately in-flight.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(scheduleSpy).not.toHaveBeenCalled();

      // Past the watchdog ceiling (40s): the hung pass is abandoned and the
      // loop reschedules exactly once rather than dying.
      await vi.advanceTimersByTimeAsync(45_000);
      await pollPromise;

      expect(scheduleSpy).toHaveBeenCalledTimes(1);

      monitor.stop();
    });

    it("releases the in-flight promise after a watchdog timeout so the next poll can run", async () => {
      mockGetWorktreeChangesWithStats.mockReturnValue(new Promise<never>(() => {}));

      const monitor = makeRunningMonitor();
      vi.spyOn(
        monitor as unknown as { scheduleNextPoll: () => void },
        "scheduleNextPoll"
      ).mockImplementation(() => {});

      const pollPromise = (monitor as unknown as { poll: () => Promise<void> }).poll();
      await vi.advanceTimersByTimeAsync(45_000);
      await pollPromise;

      // _pendingPollPromise must be released so a subsequent poll isn't blocked
      // by the abandoned one.
      expect(
        (monitor as unknown as { _pendingPollPromise: Promise<void> | null })._pendingPollPromise
      ).toBeNull();

      monitor.stop();
    });
  });
});
