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
let capturedOnWatcherFailed: (() => void) | undefined;
let capturedOnInotifyLimitReached: (() => void) | undefined;
let capturedOnEmfileLimitReached: (() => void) | undefined;
let capturedWatcherOptions: Record<string, unknown> | undefined;
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
        capturedOnWatcherFailed = opts.onWatcherFailed;
        capturedOnInotifyLimitReached = opts.onInotifyLimitReached;
        capturedOnEmfileLimitReached = opts.onEmfileLimitReached;
        capturedWatcherOptions = opts;
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
import { clearGitDirCache, getGitDir } from "../../utils/gitUtils.js";

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
    capturedOnWatcherFailed = undefined;
    capturedOnInotifyLimitReached = undefined;
    capturedOnEmfileLimitReached = undefined;
    capturedWatcherOptions = undefined;
    capturedWatcherOptionsHistory.length = 0;
    mockGetRepoOperationStateSync.mockReturnValue(undefined);
    vi.mocked(getGitDir).mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("watcher retry", () => {
    const WATCH_CONFIG: WorktreeMonitorConfig = {
      ...TEST_CONFIG,
      gitWatchEnabled: true,
    };

    // Active worktree — gets the recursive watcher under the focus-tier rules.
    const ACTIVE_WORKTREE: Worktree = { ...TEST_WORKTREE, isCurrent: true };

    it("watcher start success reports hasWatcher true", async () => {
      mockWatcherStartResult = true;
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(ACTIVE_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();

      expect(monitor.hasWatcher).toBe(true);
      monitor.stop();
    });

    it("constructs GitFileWatcher with adaptive worktree debounce options", async () => {
      mockWatcherStartResult = true;
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(ACTIVE_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();

      expect(capturedWatcherOptions).toBeDefined();
      expect(capturedWatcherOptions).toMatchObject({
        watchWorktree: true,
        worktreeMinDebounceMs: 250,
        worktreeMaxDebounceMs: 800,
        worktreeMaxWaitMs: 1500,
      });
      expect(capturedWatcherOptions).not.toHaveProperty("worktreeDebounceMs");

      monitor.stop();
    });

    it("background worktree starts with watchWorktree: false (focus-tier)", async () => {
      mockWatcherStartResult = true;
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();

      expect(capturedWatcherOptions).toMatchObject({ watchWorktree: false });
      expect(monitor.hasWatcher).toBe(true);

      monitor.stop();
    });

    it("isCurrent flip false→true upgrades watcher to recursive immediately", async () => {
      mockWatcherStartResult = true;
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();

      expect(capturedWatcherOptions).toMatchObject({ watchWorktree: false });
      const startsBeforeFlip = capturedWatcherOptionsHistory.length;

      monitor.isCurrent = true;

      // The setter rebuilt the watcher; latest call is the recursive arm.
      expect(capturedWatcherOptionsHistory.length).toBe(startsBeforeFlip + 1);
      expect(capturedWatcherOptionsHistory.at(-1)).toMatchObject({ watchWorktree: true });

      monitor.stop();
    });

    it("isCurrent flip true→false defers downgrade by the settle delay", async () => {
      mockWatcherStartResult = true;
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(ACTIVE_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();

      expect(capturedWatcherOptions).toMatchObject({ watchWorktree: true });
      const startsBeforeFlip = capturedWatcherOptionsHistory.length;

      monitor.isCurrent = false;

      // No synchronous downgrade — the recursive watcher is preserved while
      // the settle timer runs.
      expect(capturedWatcherOptionsHistory.length).toBe(startsBeforeFlip);

      // After the 3s settle delay the controller rebuilds in git-only mode.
      await vi.advanceTimersByTimeAsync(3_000);
      expect(capturedWatcherOptionsHistory.length).toBe(startsBeforeFlip + 1);
      expect(capturedWatcherOptionsHistory.at(-1)).toMatchObject({ watchWorktree: false });

      monitor.stop();
    });

    it("rapid isCurrent toggle cancels the deferred downgrade", async () => {
      mockWatcherStartResult = true;
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(ACTIVE_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();

      const startsBeforeFlip = capturedWatcherOptionsHistory.length;

      monitor.isCurrent = false;
      // Re-focus before the settle timer fires.
      await vi.advanceTimersByTimeAsync(1_000);
      monitor.isCurrent = true;

      // Let the original settle window elapse — no rebuild happened.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(capturedWatcherOptionsHistory.length).toBe(startsBeforeFlip);
      expect(capturedWatcherOptionsHistory.at(-1)).toMatchObject({ watchWorktree: true });

      monitor.stop();
    });

    it("agentActive flip false→true upgrades a background watcher to recursive and forces a refresh", async () => {
      mockWatcherStartResult = true;
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();
      await flushInitialStatus();

      expect(capturedWatcherOptions).toMatchObject({ watchWorktree: false });
      const startsBeforeFlip = capturedWatcherOptionsHistory.length;
      const statusCallsBefore = mockGetWorktreeChangesWithStats.mock.calls.length;

      monitor.agentActive = true;

      // Immediate upgrade — an agent's edits must stream without waiting.
      expect(capturedWatcherOptionsHistory.length).toBe(startsBeforeFlip + 1);
      expect(capturedWatcherOptionsHistory.at(-1)).toMatchObject({ watchWorktree: true });

      // Activation also forces a status refresh so the card baselines now.
      await vi.advanceTimersByTimeAsync(0);
      expect(mockGetWorktreeChangesWithStats.mock.calls.length).toBe(statusCallsBefore + 1);

      monitor.stop();
    });

    it("losing focus while an agent works keeps the recursive watcher (elevation held)", async () => {
      mockWatcherStartResult = true;
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(ACTIVE_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();
      monitor.agentActive = true;
      await vi.advanceTimersByTimeAsync(0);

      const startsBeforeFlip = capturedWatcherOptionsHistory.length;
      monitor.isCurrent = false;
      await vi.advanceTimersByTimeAsync(5_000);

      // No rebuild: the working agent holds the elevation.
      expect(capturedWatcherOptionsHistory.length).toBe(startsBeforeFlip);
      expect(capturedWatcherOptionsHistory.at(-1)).toMatchObject({ watchWorktree: true });

      monitor.stop();
    });

    it("agentActive set before start arms recursive and runs the initial status synchronously", async () => {
      mockWatcherStartResult = true;
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, WATCH_CONFIG, callbacks, "main");
      // WorkspaceService.addNewWorktreeMonitor applies the retained
      // agent-activity set before start() — e.g. a worktree the agent itself
      // just created.
      monitor.agentActive = true;
      await monitor.start();

      expect(capturedWatcherOptions).toMatchObject({ watchWorktree: true });
      // Elevated start skips the 2-5s background jitter.
      expect(mockGetWorktreeChangesWithStats).toHaveBeenCalledTimes(1);

      const startsBeforeFlip = capturedWatcherOptionsHistory.length;
      monitor.agentActive = false;

      // Downgrade settles behind the same delay as focus loss.
      expect(capturedWatcherOptionsHistory.length).toBe(startsBeforeFlip);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(capturedWatcherOptionsHistory.at(-1)).toMatchObject({ watchWorktree: false });

      monitor.stop();
    });

    it("watcher start failure schedules retry on active worktree", async () => {
      mockWatcherStartResult = false;
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(ACTIVE_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();

      expect(monitor.hasWatcher).toBe(false);

      // After retry interval, watcher should attempt again
      mockWatcherStartResult = true;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(monitor.hasWatcher).toBe(true);

      monitor.stop();
    });

    it("background worktree does not retry recursive arm — focus flip re-arms instead", async () => {
      // Background worktrees skip the recursive watcher entirely. The retry
      // loop is reserved for active worktrees so a sea of background tabs
      // can't keep poking inotify after ENOSPC.
      mockRecursiveStartResult = false;
      mockGitOnlyStartResult = true;
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();

      // Background → git-only mode; no recursive attempt.
      expect(monitor.hasWatcher).toBe(true);
      const startsAfterBackgroundStart = watcherStartCallCount;

      mockRecursiveStartResult = true;
      await vi.advanceTimersByTimeAsync(30_000);
      // No retry queued for background — start count is unchanged.
      expect(watcherStartCallCount).toBe(startsAfterBackgroundStart);

      monitor.stop();
    });

    it("retry timer is cleared on stop()", async () => {
      mockWatcherStartResult = false;
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(ACTIVE_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();

      monitor.stop();

      // After retry interval, watcher should NOT have started
      mockWatcherStartResult = true;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(monitor.hasWatcher).toBe(false);
    });

    it("max retries exhausted leaves monitor without watcher", async () => {
      mockWatcherStartResult = false;
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(ACTIVE_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();

      // Exhaust all 5 retries
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(30_000);
      }

      expect(monitor.hasWatcher).toBe(false);

      // One more interval should NOT trigger another retry
      mockWatcherStartResult = true;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(monitor.hasWatcher).toBe(false);

      monitor.stop();
    });

    it("runtime watcher failure preserves .git/ watchers via git-only fallback", async () => {
      // The recursive watcher fails at runtime — the per-file .git/
      // watchers must survive as a degraded watcher rather than going dark.
      mockRecursiveStartResult = true;
      mockGitOnlyStartResult = true;
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(ACTIVE_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();

      expect(monitor.hasWatcher).toBe(true);
      expect(capturedWatcherOptionsHistory.at(-1)).toMatchObject({ watchWorktree: true });
      const startsAfterInitialStart = watcherStartCallCount;

      // Simulate runtime watcher failure
      capturedOnWatcherFailed?.();

      // Watcher remains — git-only is now active. Last constructor call set
      // watchWorktree:false.
      expect(monitor.hasWatcher).toBe(true);
      expect(capturedWatcherOptionsHistory.at(-1)).toMatchObject({ watchWorktree: false });
      expect(watcherStartCallCount).toBe(startsAfterInitialStart + 1);

      // After retry interval, the recursive watcher attempts to re-arm.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(capturedWatcherOptionsHistory.at(-1)).toMatchObject({ watchWorktree: true });
      expect(monitor.hasWatcher).toBe(true);

      monitor.stop();
    });

    it("forwards inotify-limit signal to callbacks with the worktree id", async () => {
      mockWatcherStartResult = true;
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });

      const onInotifyLimitReached = vi.fn();
      const callbacks = makeCallbacks({ onInotifyLimitReached });
      const monitor = new WorktreeMonitor(ACTIVE_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();

      expect(capturedOnInotifyLimitReached).toBeDefined();
      capturedOnInotifyLimitReached?.();
      expect(onInotifyLimitReached).toHaveBeenCalledWith(ACTIVE_WORKTREE.id);
      expect(onInotifyLimitReached).toHaveBeenCalledTimes(1);

      monitor.stop();
    });

    it("forwards emfile-limit signal to callbacks with the worktree id", async () => {
      mockWatcherStartResult = true;
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });

      const onEmfileLimitReached = vi.fn();
      const callbacks = makeCallbacks({ onEmfileLimitReached });
      const monitor = new WorktreeMonitor(ACTIVE_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();

      expect(capturedOnEmfileLimitReached).toBeDefined();
      capturedOnEmfileLimitReached?.();
      expect(onEmfileLimitReached).toHaveBeenCalledWith(ACTIVE_WORKTREE.id);
      expect(onEmfileLimitReached).toHaveBeenCalledTimes(1);

      monitor.stop();
    });

    it("startup ENOSPC degrades to git-only and schedules a single retry", async () => {
      // Regression guard for the startup-ENOSPC retry fix combined with the
      // git-only preservation behaviour. The recursive arm fires
      // onWatcherFailed synchronously and returns false. WorktreeMonitor's
      // handleWatcherFailed installs git-only inline, then the else branch of
      // startWatcher must NOT install a duplicate git-only or schedule a
      // duplicate retry.
      mockRecursiveStartResult = false;
      mockGitOnlyStartResult = true;
      mockWatcherStartFiresFailure = true;
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(ACTIVE_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();

      // Initial recursive start failed → exactly one git-only fallback was
      // installed (not two), and a watcher is active.
      expect(monitor.hasWatcher).toBe(true);
      expect(capturedWatcherOptionsHistory.length).toBe(2);
      expect(capturedWatcherOptionsHistory[0]).toMatchObject({ watchWorktree: true });
      expect(capturedWatcherOptionsHistory[1]).toMatchObject({ watchWorktree: false });
      expect(watcherStartCallCount).toBe(2);

      // Flip to success for the retry attempt.
      mockWatcherStartFiresFailure = false;
      mockRecursiveStartResult = true;
      await vi.advanceTimersByTimeAsync(30_000);

      // One retry, not two: recursive re-armed, git-only swapped out.
      expect(watcherStartCallCount).toBe(3);
      expect(capturedWatcherOptionsHistory.at(-1)).toMatchObject({ watchWorktree: true });
      expect(monitor.hasWatcher).toBe(true);

      monitor.stop();
    });

    it("refresh() resets watcher retry budget so subsequent failures can schedule retries", async () => {
      mockRecursiveStartResult = false;
      mockGitOnlyStartResult = true;
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(ACTIVE_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();

      // Exhaust all 5 retries.
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(30_000);
      }
      const startsAtExhaustion = watcherStartCallCount;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(watcherStartCallCount).toBe(startsAtExhaustion);

      // refresh() resets budget and calls update() which fires
      // stop(false) + start("recursive") [fails] + start("git-only") [succeeds].
      await monitor.refresh();
      expect(watcherStartCallCount).toBe(startsAtExhaustion + 2);
      expect(clearGitDirCache).toHaveBeenCalledWith(ACTIVE_WORKTREE.path);

      // Recursive still fails — should schedule a retry with fresh budget.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(watcherStartCallCount).toBe(startsAtExhaustion + 4);

      monitor.stop();
    });

    it("refresh() does not attempt re-arm when budget was not exhausted", async () => {
      mockRecursiveStartResult = true;
      mockGitOnlyStartResult = true;
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(ACTIVE_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();

      expect(monitor.hasWatcher).toBe(true);
      const startsBeforeRefresh = watcherStartCallCount;

      // refresh() when budget is zero no-ops — no extra watcher churn.
      await monitor.refresh();
      expect(watcherStartCallCount).toBe(startsBeforeRefresh);
      expect(clearGitDirCache).not.toHaveBeenCalled();

      monitor.stop();
    });

    it("ensureWatcherState during recursive backoff preserves retry budget", async () => {
      // Regression guard: ensureWatcherState() / focus rotation must not
      // reset the recursive-retry counter while a retry is already pending.
      // Otherwise an external workspace refresh during ENOSPC backoff grants
      // the failing recursive arm a fresh 5-attempt budget on the same
      // constrained kernel, hammering inotify.
      mockRecursiveStartResult = false;
      mockGitOnlyStartResult = true;
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(ACTIVE_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();

      // Recursive failed, git-only fallback installed, retry timer pending.
      expect(monitor.hasWatcher).toBe(true);
      expect(capturedWatcherOptionsHistory.at(-1)).toMatchObject({ watchWorktree: false });

      // External refresh — must not reset the retry budget.
      monitor.ensureWatcherState();

      // Burn through the budget. With a preserved counter, only the
      // remaining retries fire; reset would extend the loop.
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(30_000);
      }

      expect(monitor.hasWatcher).toBe(true);
      expect(capturedWatcherOptionsHistory.at(-1)).toMatchObject({ watchWorktree: false });

      // One more interval — budget exhausted, no further retry.
      const startsBeforeIdle = watcherStartCallCount;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(watcherStartCallCount).toBe(startsBeforeIdle);

      monitor.stop();
    });
  });

  describe("git-watch budget gate (#9538)", () => {
    const WATCH_CONFIG: WorktreeMonitorConfig = {
      ...TEST_CONFIG,
      gitWatchEnabled: true,
    };

    beforeEach(() => {
      mockWatcherStartResult = true;
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });
    });

    it("revoking the budget stops the watcher; granting re-arms it", async () => {
      const monitor = new WorktreeMonitor(TEST_WORKTREE, WATCH_CONFIG, makeCallbacks(), "main");
      await monitor.start();
      expect(monitor.hasWatcher).toBe(true);
      expect(monitor.gitWatchBudgetGranted).toBe(true);

      monitor.setGitWatchBudgetAllowed(false);
      expect(monitor.hasWatcher).toBe(false);
      expect(monitor.gitWatchBudgetGranted).toBe(false);

      monitor.setGitWatchBudgetAllowed(true);
      expect(monitor.hasWatcher).toBe(true);
      expect(monitor.gitWatchBudgetGranted).toBe(true);

      monitor.stop();
    });

    it("is idempotent — re-applying the same value does not churn the watcher", async () => {
      const monitor = new WorktreeMonitor(TEST_WORKTREE, WATCH_CONFIG, makeCallbacks(), "main");
      await monitor.start();
      const startsAfterArm = watcherStartCallCount;

      // Same value: no ensureState/start work.
      monitor.setGitWatchBudgetAllowed(true);
      expect(watcherStartCallCount).toBe(startsAfterArm);
      expect(monitor.hasWatcher).toBe(true);

      monitor.stop();
    });

    it("granting budget never arms a watcher when git watching is disabled", async () => {
      const monitor = new WorktreeMonitor(
        TEST_WORKTREE,
        { ...TEST_CONFIG, gitWatchEnabled: false },
        makeCallbacks(),
        "main"
      );
      await monitor.start();
      expect(monitor.hasWatcher).toBe(false);

      // The combined gate is AND, not OR: budget alone must not arm a watcher
      // the user disabled.
      monitor.setGitWatchBudgetAllowed(false);
      monitor.setGitWatchBudgetAllowed(true);
      expect(watcherStartCallCount).toBe(0);
      expect(monitor.hasWatcher).toBe(false);

      monitor.stop();
    });

    it("ensureWatcherState does not re-arm an evicted watcher", async () => {
      const monitor = new WorktreeMonitor(TEST_WORKTREE, WATCH_CONFIG, makeCallbacks(), "main");
      await monitor.start();
      monitor.setGitWatchBudgetAllowed(false);
      expect(monitor.hasWatcher).toBe(false);

      // Mirrors the syncMonitors reconcile that would otherwise re-arm.
      monitor.ensureWatcherState();
      expect(monitor.hasWatcher).toBe(false);

      monitor.stop();
    });
  });

  describe("working-tree-changed signal (#11330)", () => {
    const WATCH_CONFIG: WorktreeMonitorConfig = {
      ...TEST_CONFIG,
      gitWatchEnabled: true,
    };
    // Active worktree → recursive watcher, and start() resolves the initial
    // git status synchronously so _hasInitialStatus is already true on return.
    const ACTIVE_WORKTREE: Worktree = { ...TEST_WORKTREE, isCurrent: true };

    beforeEach(() => {
      mockWatcherStartResult = true;
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });
    });

    it("a recursive-watcher flush emits a stamped snapshot without a git-status change", async () => {
      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(ACTIVE_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();

      expect(monitor.hasInitialStatus).toBe(true);
      // No raw-fs write yet, so the initial snapshot carries no stamp.
      expect(
        vi.mocked(callbacks.onUpdate).mock.calls.at(-1)?.[0]?.workingTreeChangedAt
      ).toBeUndefined();

      const statusCallsBefore = mockGetWorktreeChangesWithStats.mock.calls.length;
      const emitsBefore = vi.mocked(callbacks.onUpdate).mock.calls.length;

      const fireWorktreeFilesChanged = capturedWatcherOptions?.onWorktreeFilesChanged as
        | ((affectedDirs: readonly string[] | null) => void)
        | undefined;
      expect(fireWorktreeFilesChanged).toBeDefined();
      fireWorktreeFilesChanged?.(null);

      // Emitted off the write alone — a fresh snapshot, no extra git status run.
      expect(vi.mocked(callbacks.onUpdate).mock.calls.length).toBe(emitsBefore + 1);
      expect(mockGetWorktreeChangesWithStats.mock.calls.length).toBe(statusCallsBefore);
      expect(
        vi.mocked(callbacks.onUpdate).mock.calls.at(-1)?.[0]?.workingTreeChangedAt
      ).toBeGreaterThan(0);

      monitor.stop();
    });

    it("stamps a strictly increasing workingTreeChangedAt across successive flushes", async () => {
      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(ACTIVE_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();

      const fireWorktreeFilesChanged = capturedWatcherOptions?.onWorktreeFilesChanged as (
        affectedDirs: readonly string[] | null
      ) => void;

      // Two flushes with no timer advance between them: the monotonic guard
      // (Math.max(now, prev + 1)) must still move the stamp forward even when
      // Date.now() is unchanged.
      fireWorktreeFilesChanged(null);
      const first = vi.mocked(callbacks.onUpdate).mock.calls.at(-1)?.[0]?.workingTreeChangedAt;
      fireWorktreeFilesChanged(null);
      const second = vi.mocked(callbacks.onUpdate).mock.calls.at(-1)?.[0]?.workingTreeChangedAt;

      expect(first).toBeGreaterThan(0);
      expect(second).toBeGreaterThan(first ?? 0);

      monitor.stop();
    });

    it("a flush before initial status stamps but does not emit; the first snapshot carries it", async () => {
      // Background worktree defers its initial git status behind the 2-5s
      // jitter, so _hasInitialStatus is still false right after start() — the
      // only clean way to exercise the pre-initial-status branch. Driving the
      // captured callback directly stands in for the recursive flush.
      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();

      expect(monitor.hasInitialStatus).toBe(false);
      expect(callbacks.onUpdate).not.toHaveBeenCalled();

      const fireWorktreeFilesChanged = capturedWatcherOptions?.onWorktreeFilesChanged as (
        affectedDirs: readonly string[] | null
      ) => void;
      fireWorktreeFilesChanged(["src"]);

      // Stamped internally, but no incomplete snapshot emitted for it.
      expect(callbacks.onUpdate).not.toHaveBeenCalled();

      // Once the deferred initial status lands, its first snapshot carries the
      // retained stamp.
      await flushInitialStatus();
      expect(monitor.hasInitialStatus).toBe(true);
      expect(callbacks.onUpdate).toHaveBeenCalled();
      expect(
        vi.mocked(callbacks.onUpdate).mock.calls[0]?.[0]?.workingTreeChangedAt
      ).toBeGreaterThan(0);
      // But NOT the directories that burst named. A second flush before the
      // first status would have overwritten them, and nothing would ever
      // re-read the difference — so a retained stamp reports "unknown" rather
      // than a set it cannot prove is complete (#12244).
      expect(
        vi.mocked(callbacks.onUpdate).mock.calls[0]?.[0]?.workingTreeChangedDirs
      ).toBeNull();

      monitor.stop();
    });

    it("carries the burst's directories on the snapshot the flush emits", async () => {
      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(ACTIVE_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();

      const fireWorktreeFilesChanged = capturedWatcherOptions?.onWorktreeFilesChanged as (
        affectedDirs: readonly string[] | null
      ) => void;

      fireWorktreeFilesChanged(["src/panels", ""]);
      const emitted = vi.mocked(callbacks.onUpdate).mock.calls.at(-1)?.[0];
      expect(emitted?.workingTreeChangedDirs).toEqual(["src/panels", ""]);
      expect(emitted?.workingTreeChangedAt).toBeGreaterThan(0);

      // An unclassifiable burst replaces them rather than leaving the previous
      // burst's directories standing against a newer stamp.
      fireWorktreeFilesChanged(null);
      const next = vi.mocked(callbacks.onUpdate).mock.calls.at(-1)?.[0];
      expect(next?.workingTreeChangedDirs).toBeNull();
      expect(next?.workingTreeChangedAt).toBeGreaterThan(emitted?.workingTreeChangedAt ?? 0);

      monitor.stop();
    });
  });
});
