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
  getRepoOperationState: async (...args: unknown[]) => mockGetRepoOperationStateSync(...args),
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
  });

  describe("WSL git routing", () => {
    beforeEach(() => {
      mockCreateHardenedGit.mockClear();
      mockCreateWslHardenedGit.mockClear();
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        changes: [],
        changedFileCount: 0,
        totalInsertions: 0,
        totalDeletions: 0,
        latestFileMtime: null,
        lastUpdated: Date.now(),
      });
    });

    it("does not pass wsl invocation when not opted in", async () => {
      const wsl: Worktree = {
        ...TEST_WORKTREE,
        path: "\\\\wsl$\\Ubuntu\\home\\user\\repo",
        isWslPath: true,
        wslDistro: "Ubuntu",
        wslPosixPath: "/home/user/repo",
        wslGitEligible: "eligible",
        wslGitOptIn: false,
      };
      const monitor = new WorktreeMonitor(wsl, TEST_CONFIG, makeCallbacks(), "main");
      await monitor.start();
      await flushInitialStatus();

      const lastCall =
        mockGetWorktreeChangesWithStats.mock.calls[
          mockGetWorktreeChangesWithStats.mock.calls.length - 1
        ];
      expect(lastCall[1]?.wsl).toBeUndefined();

      monitor.stop();
    });

    it("passes wsl invocation when eligible + opted in (Windows only)", async () => {
      const original = process.platform;
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      try {
        const wsl: Worktree = {
          ...TEST_WORKTREE,
          path: "\\\\wsl$\\Ubuntu\\home\\user\\repo",
          isWslPath: true,
          wslDistro: "Ubuntu",
          wslPosixPath: "/home/user/repo",
          wslGitEligible: "eligible",
          wslGitOptIn: true,
        };
        const monitor = new WorktreeMonitor(wsl, TEST_CONFIG, makeCallbacks(), "main");
        await monitor.start();
        await flushInitialStatus();

        const lastCall =
          mockGetWorktreeChangesWithStats.mock.calls[
            mockGetWorktreeChangesWithStats.mock.calls.length - 1
          ];
        expect(lastCall[1]?.wsl).toEqual({
          distro: "Ubuntu",
          uncPath: "\\\\wsl$\\Ubuntu\\home\\user\\repo",
          posixPath: "/home/user/repo",
        });

        // Snapshot must carry the upstream-provided wslPosixPath verbatim —
        // if the field round-trips through getSnapshot, renderer-side
        // consumers can rely on it without re-parsing the UNC.
        const snapshot = monitor.getSnapshot();
        expect(snapshot.wslPosixPath).toBe("/home/user/repo");

        monitor.stop();
      } finally {
        Object.defineProperty(process, "platform", { value: original, configurable: true });
      }
    });

    it("silently disables WSL git routing when wslPosixPath is missing upstream", async () => {
      // Regression guard: with the regex hoisted upstream, a WorktreeMonitor
      // constructed without `wslPosixPath` (e.g. bypassing enrichWorktreeWithWsl)
      // must short-circuit WSL routing rather than route to a fabricated
      // distro-root path.
      const original = process.platform;
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      try {
        const wsl: Worktree = {
          ...TEST_WORKTREE,
          path: "\\\\wsl$\\Ubuntu\\home\\user\\repo",
          isWslPath: true,
          wslDistro: "Ubuntu",
          wslGitEligible: "eligible",
          wslGitOptIn: true,
        };
        const monitor = new WorktreeMonitor(wsl, TEST_CONFIG, makeCallbacks(), "main");
        await monitor.start();
        await flushInitialStatus();

        const lastCall =
          mockGetWorktreeChangesWithStats.mock.calls[
            mockGetWorktreeChangesWithStats.mock.calls.length - 1
          ];
        expect(lastCall[1]?.wsl).toBeUndefined();

        monitor.stop();
      } finally {
        Object.defineProperty(process, "platform", { value: original, configurable: true });
      }
    });

    it("setWslOptIn re-emits snapshot with updated fields when value changes", async () => {
      const original = process.platform;
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      try {
        const wsl: Worktree = {
          ...TEST_WORKTREE,
          path: "\\\\wsl$\\Ubuntu\\home\\user\\repo",
          isWslPath: true,
          wslDistro: "Ubuntu",
          wslPosixPath: "/home/user/repo",
          wslGitEligible: "eligible",
          wslGitOptIn: false,
        };
        const callbacks = makeCallbacks();
        const monitor = new WorktreeMonitor(wsl, TEST_CONFIG, callbacks, "main");
        await monitor.start();
        await flushInitialStatus();

        const updateCallsBefore = (callbacks.onUpdate as ReturnType<typeof vi.fn>).mock.calls
          .length;
        monitor.setWslOptIn(true, true);
        const updateCallsAfter = (callbacks.onUpdate as ReturnType<typeof vi.fn>).mock.calls.length;
        expect(updateCallsAfter).toBeGreaterThan(updateCallsBefore);

        const snapshot = monitor.getSnapshot();
        expect(snapshot.wslGitOptIn).toBe(true);
        expect(snapshot.wslGitDismissed).toBe(true);
        expect(snapshot.isWslPath).toBe(true);

        monitor.stop();
      } finally {
        Object.defineProperty(process, "platform", { value: original, configurable: true });
      }
    });

    it("serializes ineligible as 'ineligible', not absent (#9924)", async () => {
      // The old `this._wslGitEligible || undefined` coercion dropped `false` to
      // absent, making "ineligible" indistinguishable from "unprobed" on the
      // renderer. The three-state field must round-trip 'ineligible' verbatim.
      const wsl: Worktree = {
        ...TEST_WORKTREE,
        path: "\\\\wsl$\\Debian\\home\\user\\repo",
        isWslPath: true,
        wslDistro: "Debian",
        wslPosixPath: "/home/user/repo",
        wslGitEligible: "ineligible",
      };
      const monitor = new WorktreeMonitor(wsl, TEST_CONFIG, makeCallbacks(), "main");
      await monitor.start();
      await flushInitialStatus();

      expect(monitor.getSnapshot().wslGitEligible).toBe("ineligible");

      monitor.stop();
    });

    it("defaults eligibility to 'unprobed' when the field is absent (#9924)", async () => {
      const wsl: Worktree = {
        ...TEST_WORKTREE,
        path: "\\\\wsl$\\Ubuntu\\home\\user\\repo",
        isWslPath: true,
        wslDistro: "Ubuntu",
        wslPosixPath: "/home/user/repo",
      };
      const monitor = new WorktreeMonitor(wsl, TEST_CONFIG, makeCallbacks(), "main");
      await monitor.start();
      await flushInitialStatus();

      expect(monitor.getSnapshot().wslGitEligible).toBe("unprobed");

      monitor.stop();
    });

    it("setWslEligible flips git routing at runtime without restart (#9924)", async () => {
      const original = process.platform;
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      try {
        const wsl: Worktree = {
          ...TEST_WORKTREE,
          path: "\\\\wsl$\\Ubuntu\\home\\user\\repo",
          isWslPath: true,
          wslDistro: "Ubuntu",
          wslPosixPath: "/home/user/repo",
          // Start ineligible + opted in: no WSL routing yet.
          wslGitEligible: "ineligible",
          wslGitOptIn: true,
        };
        const callbacks = makeCallbacks();
        const monitor = new WorktreeMonitor(wsl, TEST_CONFIG, callbacks, "main");
        await monitor.start();
        await flushInitialStatus();

        // Becoming the default distro mid-session flips eligibility → routing on.
        const updateCallsBefore = (callbacks.onUpdate as ReturnType<typeof vi.fn>).mock.calls
          .length;
        monitor.setWslEligible("eligible");
        const updateCallsAfter = (callbacks.onUpdate as ReturnType<typeof vi.fn>).mock.calls.length;
        expect(updateCallsAfter).toBeGreaterThan(updateCallsBefore);
        expect(monitor.getSnapshot().wslGitEligible).toBe("eligible");

        mockGetWorktreeChangesWithStats.mockClear();
        await monitor.refresh();

        const lastCall =
          mockGetWorktreeChangesWithStats.mock.calls[
            mockGetWorktreeChangesWithStats.mock.calls.length - 1
          ];
        expect(lastCall[1]?.wsl).toEqual({
          distro: "Ubuntu",
          uncPath: "\\\\wsl$\\Ubuntu\\home\\user\\repo",
          posixPath: "/home/user/repo",
        });

        monitor.stop();
      } finally {
        Object.defineProperty(process, "platform", { value: original, configurable: true });
      }
    });

    it("setWslEligible is a no-op when the value is unchanged (#9924)", async () => {
      const wsl: Worktree = {
        ...TEST_WORKTREE,
        path: "\\\\wsl$\\Ubuntu\\home\\user\\repo",
        isWslPath: true,
        wslDistro: "Ubuntu",
        wslPosixPath: "/home/user/repo",
        wslGitEligible: "ineligible",
      };
      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(wsl, TEST_CONFIG, callbacks, "main");
      await monitor.start();
      await flushInitialStatus();

      const before = (callbacks.onUpdate as ReturnType<typeof vi.fn>).mock.calls.length;
      monitor.setWslEligible("ineligible");
      const after = (callbacks.onUpdate as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(after).toBe(before);

      monitor.stop();
    });
  });

  describe("heartbeat gap detection", () => {
    const CLEAN_CHANGES = {
      worktreeId: "/test/worktree",
      rootPath: "/test",
      changes: [],
      changedFileCount: 0,
      lastUpdated: 0,
    };

    function getMoodSequence(callbacks: WorktreeMonitorCallbacks): Array<string | undefined> {
      const fn = callbacks.onUpdate as ReturnType<typeof vi.fn>;
      return fn.mock.calls.map((call) => (call[0] as { mood?: string }).mood);
    }

    it("emits stale and force-refreshes when gap exceeds multiplier and floor", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValue(CLEAN_CHANGES);

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
      await monitor.start();
      await flushInitialStatus();

      mockGetWorktreeChangesWithStats.mockClear();
      // Simulate that the last poll completion happened 60s ago in wall time —
      // the OS effectively suspended the process between then and now.
      (monitor as unknown as { lastGitStatusCompletedAt: number }).lastGitStatusCompletedAt =
        Date.now() - 60_000;
      mockInvalidateGitStatusCache.mockClear();

      // Fire the next pending poll timer (base interval 2000ms).
      await vi.advanceTimersByTimeAsync(5000);

      const moods = getMoodSequence(callbacks);
      expect(moods).toContain("stale");
      // Force refresh ran (forceRefresh=true invalidates the cache before fetching).
      expect(mockInvalidateGitStatusCache).toHaveBeenCalled();
      expect(mockGetWorktreeChangesWithStats).toHaveBeenCalled();

      monitor.stop();
    });

    it("does not mark stale before any git status has completed", async () => {
      // Set the watcher to start successfully so that start() is a no-op for git
      // status (startWithoutGitStatus path also leaves lastGitStatusCompletedAt = 0).
      mockGetWorktreeChangesWithStats.mockResolvedValue(CLEAN_CHANGES);

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
      monitor.startWithoutGitStatus();

      // Advance well past the gap floor without ever completing a poll.
      await vi.advanceTimersByTimeAsync(120_000);

      const moods = getMoodSequence(callbacks);
      expect(moods).not.toContain("stale");

      monitor.stop();
    });

    it("does not mark stale when elapsed exceeds 3x interval but is below 30s floor", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValue(CLEAN_CHANGES);

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
      await monitor.start();
      await flushInitialStatus();

      mockGetWorktreeChangesWithStats.mockClear();
      // 10s gap > 3x base interval (6s) but < 30s floor.
      (monitor as unknown as { lastGitStatusCompletedAt: number }).lastGitStatusCompletedAt =
        Date.now() - 10_000;

      await vi.advanceTimersByTimeAsync(5000);

      const moods = getMoodSequence(callbacks);
      expect(moods).not.toContain("stale");

      monitor.stop();
    });

    it("does not mark stale when elapsed exceeds 30s floor but is below 360s ceiling", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValue(CLEAN_CHANGES);

      const callbacks = makeCallbacks();
      // Watcher fallback path: base interval = 300s, raw threshold = 900s,
      // capped to 360s by HEARTBEAT_GAP_CEILING_MS.
      const watcherConfig: WorktreeMonitorConfig = {
        ...TEST_CONFIG,
        gitWatchEnabled: true,
      };
      mockWatcherStartResult = true;
      const monitor = new WorktreeMonitor(TEST_WORKTREE, watcherConfig, callbacks, "main");
      await monitor.start();
      await flushInitialStatus();

      mockGetWorktreeChangesWithStats.mockClear();
      // Advance most of the way to the heartbeat fire (timer is at +300s).
      await vi.advanceTimersByTimeAsync(245_000);
      // Simulate a watcher-driven update landing at T+245s — lastCompleted is now recent.
      (monitor as unknown as { lastGitStatusCompletedAt: number }).lastGitStatusCompletedAt =
        Date.now();
      // Advance another 60s to fire the heartbeat at T+305s.
      // elapsed at fire = 55s: above 30s floor, below 360s ceiling — must not mark stale.
      await vi.advanceTimersByTimeAsync(60_000);

      const moods = getMoodSequence(callbacks);
      expect(moods).not.toContain("stale");

      monitor.stop();
    });

    // Skipped on Windows: vi fake-timer microtask draining differs from
    // POSIX hosts here — the forced-refresh microtask chain doesn't fully
    // settle within `advanceTimersByTimeAsync(0)`, leaving the mood at "stale"
    // even after the refresh resolves. Linux/macOS still cover the logic.
    it.skipIf(process.platform === "win32")(
      "stale mood reverts after the forced refresh completes",
      async () => {
        mockGetWorktreeChangesWithStats.mockResolvedValue(CLEAN_CHANGES);

        const callbacks = makeCallbacks();
        const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
        await monitor.start();
        await flushInitialStatus();

        (monitor as unknown as { lastGitStatusCompletedAt: number }).lastGitStatusCompletedAt =
          Date.now() - 60_000;

        await vi.advanceTimersByTimeAsync(5000);
        // Drain any microtasks the forced refresh kicked off.
        await vi.advanceTimersByTimeAsync(0);

        const moods = getMoodSequence(callbacks);
        const staleIndex = moods.indexOf("stale");
        expect(staleIndex).toBeGreaterThanOrEqual(0);
        // After the forced refresh, categorizeWorktree() returns "stable" (mocked),
        // so the final mood should be back to the real value.
        const finalMood = moods[moods.length - 1];
        expect(finalMood).not.toBe("stale");

        monitor.stop();
      }
    );

    // Skipped on Windows: same vi fake-timer race as above — a poll
    // microtask scheduled before stop() can still resolve into a git call
    // after the timers are cleared on Windows hosts. Linux/macOS still
    // exercise the stop()-cancels-heartbeat path.
    it.skipIf(process.platform === "win32")(
      "does not run heartbeat check after stop()",
      async () => {
        mockGetWorktreeChangesWithStats.mockResolvedValue(CLEAN_CHANGES);

        const callbacks = makeCallbacks();
        const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
        await monitor.start();
        await flushInitialStatus();

        (monitor as unknown as { lastGitStatusCompletedAt: number }).lastGitStatusCompletedAt =
          Date.now() - 60_000;

        monitor.stop();
        mockGetWorktreeChangesWithStats.mockClear();

        await vi.advanceTimersByTimeAsync(120_000);

        const moods = getMoodSequence(callbacks);
        expect(moods).not.toContain("stale");
        expect(mockGetWorktreeChangesWithStats).not.toHaveBeenCalled();
      }
    );

    it("watcher fallback interval (300s) triggers stale when gap exceeds 360s ceiling", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValue(CLEAN_CHANGES);
      mockWatcherStartResult = true;

      const watcherConfig: WorktreeMonitorConfig = {
        ...TEST_CONFIG,
        gitWatchEnabled: true,
      };

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, watcherConfig, callbacks, "main");
      await monitor.start();
      await flushInitialStatus();

      // 100s past offset on lastCompleted plus the 300s timer fire gives an
      // elapsed of ~400s at fire — above the 360s ceiling. Raw threshold
      // (3 * 300s = 900s) is clamped to 360s so suspend/wake detection stays
      // bounded regardless of base interval.
      (monitor as unknown as { lastGitStatusCompletedAt: number }).lastGitStatusCompletedAt =
        Date.now() - 100_000;

      await vi.advanceTimersByTimeAsync(305_000);

      const moods = getMoodSequence(callbacks);
      expect(moods).toContain("stale");

      monitor.stop();
    });

    it("watcher fallback interval (300s) does not trigger stale on a quiet repo", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValue(CLEAN_CHANGES);
      mockWatcherStartResult = true;

      const watcherConfig: WorktreeMonitorConfig = {
        ...TEST_CONFIG,
        gitWatchEnabled: true,
      };

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, watcherConfig, callbacks, "main");
      await monitor.start();
      await flushInitialStatus();

      // After the initial poll, lastCompleted is set and the heartbeat timer
      // is scheduled for +300s. Advance to fire it without mutating
      // lastCompleted (no watcher events, no manual override). Elapsed at
      // fire is the base interval (~300s) — below the 360s ceiling, so the
      // safety net must NOT flicker stale on every cycle.
      await vi.advanceTimersByTimeAsync(305_000);

      const moods = getMoodSequence(callbacks);
      expect(moods).not.toContain("stale");

      monitor.stop();
    });

    // Skipped on Windows: vi fake-timer microtask race lets a queued poll
    // resolve into a git call before the in-flight gate (`_isUpdating`)
    // takes effect on Windows hosts. Linux/macOS still cover the gate.
    it.skipIf(process.platform === "win32")(
      "does not emit stale while a refresh is already in flight",
      async () => {
        mockGetWorktreeChangesWithStats.mockResolvedValue(CLEAN_CHANGES);

        const callbacks = makeCallbacks();
        const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
        await monitor.start();
        await flushInitialStatus();

        mockGetWorktreeChangesWithStats.mockClear();
        // Simulate an in-flight refresh AND an aged completion timestamp.
        (monitor as unknown as { _isUpdating: boolean })._isUpdating = true;
        (monitor as unknown as { lastGitStatusCompletedAt: number }).lastGitStatusCompletedAt =
          Date.now() - 60_000;

        await vi.advanceTimersByTimeAsync(5000);

        const moods = getMoodSequence(callbacks);
        expect(moods).not.toContain("stale");
        // Force-refresh path is gated behind the gap check, so it must not have
        // kicked off a duplicate git call either.
        expect(mockGetWorktreeChangesWithStats).not.toHaveBeenCalled();

        // Restore so stop() doesn't trip an in-flight assertion in teardown.
        (monitor as unknown as { _isUpdating: boolean })._isUpdating = false;
        monitor.stop();
      }
    );

    it("retains 'error' mood when the forced refresh fails", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValueOnce(CLEAN_CHANGES);

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
      await monitor.start();
      await flushInitialStatus();

      mockGetWorktreeChangesWithStats.mockReset();
      mockGetWorktreeChangesWithStats.mockRejectedValue(new Error("git stalled"));
      (monitor as unknown as { lastGitStatusCompletedAt: number }).lastGitStatusCompletedAt =
        Date.now() - 60_000;

      await vi.advanceTimersByTimeAsync(5000);
      // Drain microtasks queued by the failing refresh.
      await vi.advanceTimersByTimeAsync(0);

      const moods = getMoodSequence(callbacks);
      expect(moods).toContain("stale");
      // updateGitStatus's catch path emits "error" before throwing; the gap
      // helper swallows the throw so the monitor stays alive.
      expect(moods).toContain("error");
      // Monitor is still running and a follow-up timer is pending.
      expect((monitor as unknown as { _isRunning: boolean })._isRunning).toBe(true);

      monitor.stop();
    });

    it("forced refresh produces real categorized mood, not 'stale'", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValue(CLEAN_CHANGES);
      // After the gap-driven refresh runs, categorize as something non-trivial.
      mockCategorizeWorktree.mockReturnValue("dirty");

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
      await monitor.start();
      await flushInitialStatus();

      (monitor as unknown as { lastGitStatusCompletedAt: number }).lastGitStatusCompletedAt =
        Date.now() - 60_000;

      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(0);

      const moods = getMoodSequence(callbacks);
      expect(moods).toContain("stale");
      expect(moods[moods.length - 1]).toBe("dirty");

      mockCategorizeWorktree.mockReturnValue("stable");
      monitor.stop();
    });
  });

  describe("git operation skip (rebase / merge / cherry-pick)", () => {
    it("skips getWorktreeChangesWithStats while a git operation is in progress", async () => {
      vi.mocked(getGitDir).mockResolvedValue("/test/worktree/.git");
      mockGetRepoOperationStateSync.mockReturnValue("REBASING");

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");

      await monitor.start();
      await flushInitialStatus();

      expect(mockGetRepoOperationStateSync).toHaveBeenCalledWith("/test/worktree/.git");
      expect(mockGetWorktreeChangesWithStats).not.toHaveBeenCalled();

      monitor.stop();
    });

    it("runs git status normally once the operation finishes", async () => {
      vi.mocked(getGitDir).mockResolvedValue("/test/worktree/.git");
      mockGetRepoOperationStateSync.mockReturnValue("MERGING");
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        totalInsertions: 0,
        totalDeletions: 0,
        insertions: 0,
        deletions: 0,
        latestFileMtime: 0,
        lastUpdated: Date.now(),
      });

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");

      await monitor.start();
      await flushInitialStatus();
      expect(mockGetWorktreeChangesWithStats).not.toHaveBeenCalled();

      // Simulate the rebase/merge finishing — sentinels disappear, then a
      // subsequent updateGitStatus call exercises the normal flow.
      mockGetRepoOperationStateSync.mockReturnValue(undefined);
      await monitor.updateGitStatus(true);

      expect(mockGetWorktreeChangesWithStats).toHaveBeenCalledTimes(1);
      expect(callbacks.onUpdate).toHaveBeenCalled();

      monitor.stop();
    });

    it("emits an initial snapshot when start() is skipped mid-operation", async () => {
      vi.mocked(getGitDir).mockResolvedValue("/test/worktree/.git");
      mockGetRepoOperationStateSync.mockReturnValue("REBASING");

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");

      await monitor.start();
      await flushInitialStatus();

      // The renderer must still receive a snapshot so the worktree is
      // visible — otherwise it stays invisible until the operation ends.
      expect(callbacks.onUpdate).toHaveBeenCalledTimes(1);
      expect(monitor.hasInitialStatus).toBe(true);
      expect(mockGetWorktreeChangesWithStats).not.toHaveBeenCalled();

      monitor.stop();
    });

    it("forced refresh during a blocking operation stamps freshness and re-emits (#10715)", async () => {
      vi.mocked(getGitDir).mockResolvedValue("/test/worktree/.git");
      mockGetRepoOperationStateSync.mockReturnValue("REVERTING");

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");

      await monitor.start();
      await flushInitialStatus();
      // Initial snapshot emitted once; the git status fork itself was skipped.
      expect(callbacks.onUpdate).toHaveBeenCalledTimes(1);
      expect(mockGetWorktreeChangesWithStats).not.toHaveBeenCalled();

      vi.mocked(callbacks.onUpdate).mockClear();
      // The user clicks Refresh on the stale card → forced refresh. The op is
      // still in progress so git status stays skipped, but the renderer must
      // receive a fresh snapshot whose freshness timestamp has advanced —
      // otherwise the Refresh button is a permanent no-op (the bug).
      await monitor.updateGitStatus(true);

      expect(mockGetWorktreeChangesWithStats).not.toHaveBeenCalled();
      expect(callbacks.onUpdate).toHaveBeenCalledTimes(1);
      const snapshot = vi.mocked(callbacks.onUpdate).mock.calls.at(-1)?.[0];
      expect(snapshot?.lastGitStatusCheckedAt).toBeGreaterThan(0);

      monitor.stop();
    });

    it("background poll during a blocking operation stamps silently without re-emitting", async () => {
      vi.mocked(getGitDir).mockResolvedValue("/test/worktree/.git");
      mockGetRepoOperationStateSync.mockReturnValue("REBASING");

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");

      await monitor.start();
      await flushInitialStatus();
      expect(callbacks.onUpdate).toHaveBeenCalledTimes(1);

      vi.mocked(callbacks.onUpdate).mockClear();
      // A non-forced (background) poll advances the freshness stamp but must not
      // emit a redundant snapshot — only the user-driven forced refresh does.
      await monitor.updateGitStatus(false);
      expect(callbacks.onUpdate).not.toHaveBeenCalled();

      monitor.stop();
    });

    it("does not check operation sentinels when getGitDir returns null", async () => {
      vi.mocked(getGitDir).mockResolvedValue(null);
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        totalInsertions: 0,
        totalDeletions: 0,
        insertions: 0,
        deletions: 0,
        latestFileMtime: 0,
        lastUpdated: Date.now(),
      });

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");

      await monitor.start();
      await flushInitialStatus();

      expect(mockGetRepoOperationStateSync).not.toHaveBeenCalled();
      expect(mockGetWorktreeChangesWithStats).toHaveBeenCalled();

      monitor.stop();
    });
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

    it("forwards the cadence run's freshness window to onScheduleFetch", async () => {
      const onScheduleFetch = vi.fn().mockResolvedValue(undefined);
      const callbacks = makeCallbacks({ onScheduleFetch });
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");

      await monitor.start();
      await vi.advanceTimersByTimeAsync(6_000);
      onScheduleFetch.mockClear();
      // Past the longest background cadence delay.
      await vi.advanceTimersByTimeAsync(6.5 * 60_000);

      expect(onScheduleFetch).toHaveBeenCalledTimes(1);
      const [id, isCurrent, force, prune, maxAgeMs] = onScheduleFetch.mock.calls[0]!;
      expect([id, isCurrent, force, prune]).toEqual([TEST_WORKTREE.id, false, false, undefined]);
      expect(typeof maxAgeMs).toBe("number");

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
