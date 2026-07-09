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

  describe("poll queue concurrency", () => {
    let PQueue: typeof import("p-queue").default;

    beforeEach(async () => {
      PQueue = (await import("p-queue")).default;
    });

    it("deduplicates rapid poll calls — only one executePoll per cycle", async () => {
      let resolveGit: (() => void) | undefined;
      mockGetWorktreeChangesWithStats.mockImplementation(
        () =>
          new Promise<{
            worktreeId: string;
            rootPath: string;
            changes: never[];
            changedFileCount: number;
            lastUpdated: number;
          }>((resolve) => {
            resolveGit = () =>
              resolve({
                worktreeId: "/test/worktree",
                rootPath: "/test",
                changes: [],
                changedFileCount: 0,
                lastUpdated: Date.now(),
              });
          })
      );

      const queue = new PQueue({ concurrency: 1 });
      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main", queue);
      monitor.startWithoutGitStatus();

      // Fire two rapid polls — second should be deduplicated
      const p1 = (monitor as unknown as { poll: () => Promise<void> }).poll();
      const p2 = (monitor as unknown as { poll: () => Promise<void> }).poll();

      // The poll path resolves the git dir asynchronously before reaching
      // getWorktreeChangesWithStats — flush microtasks until the mock arms.
      for (let i = 0; i < 50 && resolveGit === undefined; i++) {
        await Promise.resolve();
      }
      // Resolve the single git call
      resolveGit!();
      await p1;
      await p2;

      expect(mockGetWorktreeChangesWithStats).toHaveBeenCalledTimes(1);
      monitor.stop();
    });

    it("single-flights forced refreshes across the async git-dir resolution", async () => {
      // Both forced refreshes arrive while the FIRST getGitDir is still
      // pending (later calls inside the status pass resolve immediately). The
      // second refresh must be rejected by the single-flight claim —
      // forceRefresh bypasses getWorktreeChangesWithStats' in-flight cache,
      // so without the early claim both would run duplicate status passes.
      let resolveFirstGitDir: ((value: string | null) => void) | undefined;
      vi.mocked(getGitDir).mockImplementationOnce(
        () =>
          new Promise<string | null>((resolve) => {
            resolveFirstGitDir = resolve;
          })
      );
      vi.mocked(getGitDir).mockResolvedValue(null);
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
      monitor.startWithoutGitStatus();

      const first = monitor.updateGitStatus(true);
      const second = monitor.updateGitStatus(true);
      expect(resolveFirstGitDir).toBeDefined();
      resolveFirstGitDir?.(null);
      await Promise.all([first, second]);

      expect(mockGetWorktreeChangesWithStats).toHaveBeenCalledTimes(1);
      monitor.stop();
    });

    it("stop() aborts a queued poll via AbortController", async () => {
      let resolveBlocker!: () => void;
      const blockerPromise = new Promise<void>((r) => {
        resolveBlocker = r;
      });

      const queue = new PQueue({ concurrency: 1 });
      const callbacks = makeCallbacks();

      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });

      // Block the queue with a long-running task so the monitor's poll is pending
      const blockerDone = queue.add(() => blockerPromise);

      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main", queue);
      monitor.startWithoutGitStatus();

      // Enqueue a poll — it will wait behind the blocker
      const pollPromise = (monitor as unknown as { poll: () => Promise<void> }).poll();

      // Stop the monitor — should abort the queued poll
      monitor.stop();

      // Release the blocker
      resolveBlocker();
      await blockerDone;
      await pollPromise;

      // The aborted poll should never have executed updateGitStatus
      expect(mockGetWorktreeChangesWithStats).not.toHaveBeenCalled();
    });

    it("active worktree polls with higher priority than background", async () => {
      const addSpy = vi.fn().mockResolvedValue(undefined);
      const fakeQueue = { add: addSpy } as unknown as import("p-queue").default;

      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });

      // Background monitor (isCurrent: false)
      const bgCallbacks = makeCallbacks();
      const bgMonitor = new WorktreeMonitor(
        TEST_WORKTREE,
        TEST_CONFIG,
        bgCallbacks,
        "main",
        fakeQueue
      );
      bgMonitor.startWithoutGitStatus();
      await (bgMonitor as unknown as { poll: () => Promise<void> }).poll();

      expect(addSpy).toHaveBeenCalledTimes(1);
      expect(addSpy.mock.calls[0][1]).toMatchObject({ priority: 0 });

      addSpy.mockClear();

      // Active monitor (isCurrent: true)
      const activeWorktree = {
        ...TEST_WORKTREE,
        id: "/test/active",
        path: "/test/active",
        isCurrent: true,
      };
      const activeCallbacks = makeCallbacks();
      const activeMonitor = new WorktreeMonitor(
        activeWorktree,
        TEST_CONFIG,
        activeCallbacks,
        "main",
        fakeQueue
      );
      activeMonitor.startWithoutGitStatus();
      await (activeMonitor as unknown as { poll: () => Promise<void> }).poll();

      expect(addSpy).toHaveBeenCalledTimes(1);
      expect(addSpy.mock.calls[0][1]).toMatchObject({ priority: 1 });

      bgMonitor.stop();
      activeMonitor.stop();
    });

    it("monitor can restart after stop with fresh AbortController", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });

      const queue = new PQueue({ concurrency: 1 });
      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main", queue);

      // Start, poll, stop
      monitor.startWithoutGitStatus();
      await (monitor as unknown as { poll: () => Promise<void> }).poll();
      expect(mockGetWorktreeChangesWithStats).toHaveBeenCalledTimes(1);
      monitor.stop();

      mockGetWorktreeChangesWithStats.mockClear();

      // Restart — should get a fresh AbortController and poll successfully
      monitor.startWithoutGitStatus();
      await (monitor as unknown as { poll: () => Promise<void> }).poll();
      expect(mockGetWorktreeChangesWithStats).toHaveBeenCalledTimes(1);
      monitor.stop();
    });
  });

  describe("adaptive resource polling", () => {
    it("defaults to 30s polling when hasResourceConfig and hasStatusCommand are set on active worktree", async () => {
      const activeWorktree: Worktree = { ...TEST_WORKTREE, isCurrent: true };
      const callbacks = makeCallbacks({ onResourceStatusPoll: vi.fn() });
      const monitor = new WorktreeMonitor(activeWorktree, TEST_CONFIG, callbacks, "main");

      monitor.startWithoutGitStatus();
      monitor.setHasResourceConfig(true);
      monitor.setHasStatusCommand(true);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(callbacks.onResourceStatusPoll).toHaveBeenCalledWith("/test/worktree");
      expect(callbacks.onResourceStatusPoll).toHaveBeenCalledTimes(1);

      monitor.stop();
    });

    it("defaults to 300s polling for background worktree", async () => {
      const backgroundWorktree: Worktree = { ...TEST_WORKTREE, isCurrent: false };
      const callbacks = makeCallbacks({ onResourceStatusPoll: vi.fn() });
      const monitor = new WorktreeMonitor(backgroundWorktree, TEST_CONFIG, callbacks, "main");

      monitor.startWithoutGitStatus();
      monitor.setHasResourceConfig(true);
      monitor.setHasStatusCommand(true);

      await vi.advanceTimersByTimeAsync(270_000);
      expect(callbacks.onResourceStatusPoll).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(30_000);
      expect(callbacks.onResourceStatusPoll).toHaveBeenCalledWith("/test/worktree");
      expect(callbacks.onResourceStatusPoll).toHaveBeenCalledTimes(1);

      monitor.stop();
    });

    it("switches from 300s to 30s when isCurrent becomes true", async () => {
      const backgroundWorktree: Worktree = { ...TEST_WORKTREE, isCurrent: false };
      const callbacks = makeCallbacks({ onResourceStatusPoll: vi.fn() });
      const monitor = new WorktreeMonitor(backgroundWorktree, TEST_CONFIG, callbacks, "main");

      monitor.startWithoutGitStatus();
      monitor.setHasResourceConfig(true);
      monitor.setHasStatusCommand(true);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(callbacks.onResourceStatusPoll).not.toHaveBeenCalled();

      monitor.isCurrent = true;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(callbacks.onResourceStatusPoll).toHaveBeenCalledWith("/test/worktree");
      expect(callbacks.onResourceStatusPoll).toHaveBeenCalledTimes(1);

      monitor.stop();
    });

    it("does not poll when hasStatusCommand is false", async () => {
      const callbacks = makeCallbacks({ onResourceStatusPoll: vi.fn() });
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");

      monitor.startWithoutGitStatus();
      monitor.setHasResourceConfig(true);
      monitor.setHasStatusCommand(false);

      await vi.advanceTimersByTimeAsync(120_000);
      expect(callbacks.onResourceStatusPoll).not.toHaveBeenCalled();

      monitor.stop();
    });

    it("explicit setResourcePollInterval overrides defaults", async () => {
      const activeWorktree: Worktree = { ...TEST_WORKTREE, isCurrent: true };
      const callbacks = makeCallbacks({ onResourceStatusPoll: vi.fn() });
      const monitor = new WorktreeMonitor(activeWorktree, TEST_CONFIG, callbacks, "main");

      monitor.startWithoutGitStatus();
      monitor.setHasResourceConfig(true);
      monitor.setHasStatusCommand(true);
      monitor.setResourcePollInterval(60_000);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(callbacks.onResourceStatusPoll).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(30_000);
      expect(callbacks.onResourceStatusPoll).toHaveBeenCalledWith("/test/worktree");
      expect(callbacks.onResourceStatusPoll).toHaveBeenCalledTimes(1);

      monitor.stop();
    });

    it("resumePolling restarts resource poll timer after pausePolling", async () => {
      const activeWorktree: Worktree = { ...TEST_WORKTREE, isCurrent: true };
      const callbacks = makeCallbacks({ onResourceStatusPoll: vi.fn() });
      const monitor = new WorktreeMonitor(activeWorktree, TEST_CONFIG, callbacks, "main");

      monitor.startWithoutGitStatus();
      monitor.setHasResourceConfig(true);
      monitor.setHasStatusCommand(true);

      // Pause and resume
      monitor.pausePolling();
      monitor.resumePolling();

      await vi.advanceTimersByTimeAsync(30_000);
      expect(callbacks.onResourceStatusPoll).toHaveBeenCalledWith("/test/worktree");
      expect(callbacks.onResourceStatusPoll).toHaveBeenCalledTimes(1);

      monitor.stop();
    });

    it("isCurrent change does not override explicit interval", async () => {
      const backgroundWorktree: Worktree = { ...TEST_WORKTREE, isCurrent: false };
      const callbacks = makeCallbacks({ onResourceStatusPoll: vi.fn() });
      const monitor = new WorktreeMonitor(backgroundWorktree, TEST_CONFIG, callbacks, "main");

      monitor.startWithoutGitStatus();
      monitor.setHasResourceConfig(true);
      monitor.setHasStatusCommand(true);
      monitor.setResourcePollInterval(60_000);

      monitor.isCurrent = true;

      await vi.advanceTimersByTimeAsync(60_000);
      expect(callbacks.onResourceStatusPoll).toHaveBeenCalledWith("/test/worktree");
      expect(callbacks.onResourceStatusPoll).toHaveBeenCalledTimes(1);

      monitor.stop();
    });

    it("explicit interval matching a default constant survives focus flip", async () => {
      // Regression: the focus-flip auto-adapt previously checked whether the
      // current interval equaled either default, which collided with explicit
      // user values that happened to match. After the new background default
      // landed at 300s, `statusInterval: 300` was a plausible production
      // value that would silently flip to 30s on focus change.
      const backgroundWorktree: Worktree = { ...TEST_WORKTREE, isCurrent: false };
      const callbacks = makeCallbacks({ onResourceStatusPoll: vi.fn() });
      const monitor = new WorktreeMonitor(backgroundWorktree, TEST_CONFIG, callbacks, "main");

      monitor.startWithoutGitStatus();
      monitor.setHasResourceConfig(true);
      monitor.setHasStatusCommand(true);
      // Explicit value that exactly matches RESOURCE_POLL_DEFAULT_BACKGROUND_MS.
      monitor.setResourcePollInterval(300_000);

      monitor.isCurrent = true;

      // If the focus-flip incorrectly reverted to the active default (30s),
      // the callback would fire after 30s. With the explicit-flag guard it
      // must wait the full 300s.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(callbacks.onResourceStatusPoll).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(240_000);
      expect(callbacks.onResourceStatusPoll).toHaveBeenCalledWith("/test/worktree");
      expect(callbacks.onResourceStatusPoll).toHaveBeenCalledTimes(1);

      monitor.stop();
    });
  });

  describe("snapshot capability flags", () => {
    it("includes hasStatusCommand and hasProvisionCommand in snapshot when set", () => {
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, makeCallbacks(), "main");
      monitor.setHasResourceConfig(true);
      monitor.setHasStatusCommand(true);
      monitor.setHasProvisionCommand(true);

      const snapshot = monitor.getSnapshot();
      expect(snapshot.hasStatusCommand).toBe(true);
      expect(snapshot.hasProvisionCommand).toBe(true);
    });

    it("omits hasStatusCommand and hasProvisionCommand from snapshot when not set", () => {
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, makeCallbacks(), "main");

      const snapshot = monitor.getSnapshot();
      expect(snapshot.hasStatusCommand).toBeUndefined();
      expect(snapshot.hasProvisionCommand).toBeUndefined();
    });

    it("includes all five command capability flags when set", () => {
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, makeCallbacks(), "main");
      monitor.setHasResourceConfig(true);
      monitor.setHasStatusCommand(true);
      monitor.setHasProvisionCommand(true);
      monitor.setHasPauseCommand(true);
      monitor.setHasResumeCommand(true);
      monitor.setHasTeardownCommand(true);

      const snapshot = monitor.getSnapshot();
      expect(snapshot.hasStatusCommand).toBe(true);
      expect(snapshot.hasProvisionCommand).toBe(true);
      expect(snapshot.hasPauseCommand).toBe(true);
      expect(snapshot.hasResumeCommand).toBe(true);
      expect(snapshot.hasTeardownCommand).toBe(true);
    });
  });

  describe("resource poll timer — await-before-rearm", () => {
    it("does not re-arm until the poll callback resolves", async () => {
      let resolveCallback!: () => void;
      const pollPromise = new Promise<void>((r) => {
        resolveCallback = r;
      });
      let callCount = 0;

      const callbacks = makeCallbacks({
        onResourceStatusPoll: vi.fn(() => {
          callCount++;
          return pollPromise;
        }),
      });

      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
      monitor.startWithoutGitStatus();
      monitor.setHasResourceConfig(true);
      monitor.setHasStatusCommand(true);
      monitor.setResourcePollInterval(5000);

      // Fire the first timer
      await vi.advanceTimersByTimeAsync(5000);
      expect(callCount).toBe(1);

      // Advance past another interval — should NOT fire again because callback hasn't resolved
      await vi.advanceTimersByTimeAsync(5000);
      expect(callCount).toBe(1);

      // Resolve the first callback — timer should re-arm
      resolveCallback();
      await vi.advanceTimersByTimeAsync(1);

      // Now advance past the re-armed interval
      await vi.advanceTimersByTimeAsync(5000);
      expect(callCount).toBe(2);

      monitor.stop();
    });

    it("stop() during awaited callback prevents re-arm", async () => {
      let resolveCallback!: () => void;
      const pollPromise = new Promise<void>((r) => {
        resolveCallback = r;
      });
      let callCount = 0;

      const callbacks = makeCallbacks({
        onResourceStatusPoll: vi.fn(() => {
          callCount++;
          return pollPromise;
        }),
      });

      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
      monitor.startWithoutGitStatus();
      monitor.setHasResourceConfig(true);
      monitor.setHasStatusCommand(true);
      monitor.setResourcePollInterval(5000);

      // Fire the timer
      await vi.advanceTimersByTimeAsync(5000);
      expect(callCount).toBe(1);

      // Stop the monitor while the callback is in-flight
      monitor.stop();

      // Resolve the callback — should NOT re-arm because _isRunning is false
      resolveCallback();
      await vi.advanceTimersByTimeAsync(1);

      // Advance well past the interval — no second call
      await vi.advanceTimersByTimeAsync(10000);
      expect(callCount).toBe(1);
    });

    it("poll re-arms correctly when callback resolves quickly", async () => {
      let callCount = 0;

      const callbacks = makeCallbacks({
        onResourceStatusPoll: vi.fn(() => {
          callCount++;
          return Promise.resolve();
        }),
      });

      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
      monitor.startWithoutGitStatus();
      monitor.setHasResourceConfig(true);
      monitor.setHasStatusCommand(true);
      monitor.setResourcePollInterval(5000);

      // Fire first poll
      await vi.advanceTimersByTimeAsync(5000);
      expect(callCount).toBe(1);

      // Fire second poll (re-armed after first resolved)
      await vi.advanceTimersByTimeAsync(5000);
      expect(callCount).toBe(2);

      // Fire third poll
      await vi.advanceTimersByTimeAsync(5000);
      expect(callCount).toBe(3);

      monitor.stop();
    });
  });
});
