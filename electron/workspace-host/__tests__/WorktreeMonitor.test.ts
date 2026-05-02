import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Worktree } from "../../../shared/types/worktree.js";
import { WorktreeRemovedError } from "../../utils/errorTypes.js";

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
}));

vi.mock("../../utils/gitUtils.js", () => ({
  getGitDir: vi.fn().mockReturnValue(null),
  clearGitDirCache: vi.fn(),
}));

const mockIsRepoOperationInProgress = vi.fn().mockReturnValue(false);
vi.mock("../../utils/gitRepoOperationState.js", () => ({
  isRepoOperationInProgress: (...args: unknown[]) => mockIsRepoOperationInProgress(...args),
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
        return result;
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

describe("WorktreeMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
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
    mockIsRepoOperationInProgress.mockReturnValue(false);
    vi.mocked(getGitDir).mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls onRemoved and stops polling when WorktreeRemovedError is thrown", async () => {
    mockGetWorktreeChangesWithStats.mockRejectedValue(new WorktreeRemovedError("/test/worktree"));

    const callbacks = makeCallbacks();
    const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");

    await monitor.start();

    expect(callbacks.onRemoved).toHaveBeenCalledWith("/test/worktree");
    expect(callbacks.onUpdate).not.toHaveBeenCalled();

    mockGetWorktreeChangesWithStats.mockClear();
    await vi.advanceTimersByTimeAsync(TEST_CONFIG.pollIntervalMax * 2);
    expect(mockGetWorktreeChangesWithStats).not.toHaveBeenCalled();
  });

  it("calls onUpdate on successful git status", async () => {
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

    expect(callbacks.onUpdate).toHaveBeenCalled();
    expect(callbacks.onRemoved).not.toHaveBeenCalled();

    monitor.stop();
  });

  it("does not call onRemoved for non-removal errors", async () => {
    mockGetWorktreeChangesWithStats.mockRejectedValue(new Error("network timeout"));

    const callbacks = makeCallbacks();
    const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");

    await expect(monitor.start()).rejects.toThrow("network timeout");

    expect(callbacks.onRemoved).not.toHaveBeenCalled();

    monitor.stop();
  });

  it("includes createdAt and lifecycleStatus in snapshot", () => {
    const callbacks = makeCallbacks();
    const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
    monitor.setCreatedAt(1234567890);
    monitor.setLifecycleStatus({
      phase: "setup",
      state: "running",
      totalCommands: 1,
      startedAt: 1234567890,
    });

    const snapshot = monitor.getSnapshot();
    expect(snapshot.createdAt).toBe(1234567890);
    expect(snapshot.lifecycleStatus).toEqual(
      expect.objectContaining({ phase: "setup", state: "running" })
    );
  });

  it("includes prTitle and issueTitle in snapshot after setPRInfo", () => {
    const callbacks = makeCallbacks();
    const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
    monitor.setPRInfo({
      prNumber: 42,
      prUrl: "https://github.com/test/pr/42",
      prState: "open",
      prTitle: "Fix bug",
      issueTitle: "Bug report",
    });

    const snapshot = monitor.getSnapshot();
    expect(snapshot.prNumber).toBe(42);
    expect(snapshot.prTitle).toBe("Fix bug");
    expect(snapshot.issueTitle).toBe("Bug report");
  });

  it("clearPRInfo removes PR fields", () => {
    const callbacks = makeCallbacks();
    const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
    monitor.setPRInfo({ prNumber: 42, prUrl: "url", prState: "open", prTitle: "Title" });
    monitor.clearPRInfo();

    const snapshot = monitor.getSnapshot();
    expect(snapshot.prNumber).toBeUndefined();
    expect(snapshot.prTitle).toBeUndefined();
  });

  it("hasInitialStatus is false before start", () => {
    const callbacks = makeCallbacks();
    const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
    expect(monitor.hasInitialStatus).toBe(false);
  });

  it("hasInitialStatus is true after successful updateGitStatus", async () => {
    mockGetWorktreeChangesWithStats.mockResolvedValue({
      worktreeId: "/test/worktree",
      rootPath: "/test",
      changes: [],
      changedFileCount: 0,
      lastUpdated: Date.now(),
    });

    const callbacks = makeCallbacks();
    const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
    await monitor.start();

    expect(monitor.hasInitialStatus).toBe(true);

    monitor.stop();
  });

  it("isMainWorktree is settable", () => {
    const callbacks = makeCallbacks();
    const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
    expect(monitor.isMainWorktree).toBe(false);
    monitor.isMainWorktree = true;
    expect(monitor.isMainWorktree).toBe(true);
  });

  describe("ahead/behind upstream tracking", () => {
    const cleanChangesWith = (overrides: {
      ahead?: number;
      behind?: number;
      tracking?: string | null;
    }) => ({
      worktreeId: "/test/worktree",
      rootPath: "/test",
      changes: [],
      changedFileCount: 0,
      lastUpdated: Date.now(),
      ...overrides,
    });

    it("includes aheadCount and behindCount in snapshot when upstream is configured", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValue(
        cleanChangesWith({ tracking: "origin/main", ahead: 3, behind: 1 })
      );

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
      await monitor.start();

      const snapshot = monitor.getSnapshot();
      expect(snapshot.aheadCount).toBe(3);
      expect(snapshot.behindCount).toBe(1);

      monitor.stop();
    });

    it("leaves counts undefined when no upstream is configured", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValue(cleanChangesWith({ tracking: null }));

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
      await monitor.start();

      const snapshot = monitor.getSnapshot();
      expect(snapshot.aheadCount).toBeUndefined();
      expect(snapshot.behindCount).toBeUndefined();

      monitor.stop();
    });

    it("never spawns rev-list — counts come from the existing git status call", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValue(
        cleanChangesWith({ tracking: "origin/main", ahead: 2, behind: 0 })
      );

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
      await monitor.start();
      await monitor.updateGitStatus(false);

      expect(mockGitRaw).not.toHaveBeenCalledWith(expect.arrayContaining(["rev-list"]));

      monitor.stop();
    });

    it("reports zero counts when branch is in sync with upstream", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValue(
        cleanChangesWith({ tracking: "origin/main", ahead: 0, behind: 0 })
      );

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
      await monitor.start();

      const snapshot = monitor.getSnapshot();
      expect(snapshot.aheadCount).toBe(0);
      expect(snapshot.behindCount).toBe(0);

      monitor.stop();
    });

    it("clears stale counts when upstream is removed between polls", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValueOnce(
        cleanChangesWith({ tracking: "origin/main", ahead: 2, behind: 1 })
      );
      mockGetWorktreeChangesWithStats.mockResolvedValueOnce(cleanChangesWith({ tracking: null }));

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
      await monitor.start();
      expect(monitor.getSnapshot().aheadCount).toBe(2);
      expect(monitor.getSnapshot().behindCount).toBe(1);

      await monitor.refresh();

      expect(monitor.getSnapshot().aheadCount).toBeUndefined();
      expect(monitor.getSnapshot().behindCount).toBeUndefined();

      monitor.stop();
    });

    it("treats empty-string tracking as no upstream", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValue(
        cleanChangesWith({ tracking: "", ahead: 0, behind: 0 })
      );

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
      await monitor.start();

      const snapshot = monitor.getSnapshot();
      expect(snapshot.aheadCount).toBeUndefined();
      expect(snapshot.behindCount).toBeUndefined();

      monitor.stop();
    });
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
        worktreeMinDebounceMs: 150,
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

    it("isCurrent flip true→false downgrades watcher to git-only immediately", async () => {
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

      expect(capturedWatcherOptionsHistory.length).toBe(startsBeforeFlip + 1);
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

  describe("poll queue concurrency", () => {
    let PQueue: typeof import("p-queue").default;

    beforeEach(async () => {
      PQueue = (await import("p-queue")).default;
    });

    it("deduplicates rapid poll calls — only one executePoll per cycle", async () => {
      let resolveGit!: () => void;
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

      // Resolve the single git call
      resolveGit();
      await p1;
      await p2;

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

    it("defaults to 120s polling for background worktree", async () => {
      const backgroundWorktree: Worktree = { ...TEST_WORKTREE, isCurrent: false };
      const callbacks = makeCallbacks({ onResourceStatusPoll: vi.fn() });
      const monitor = new WorktreeMonitor(backgroundWorktree, TEST_CONFIG, callbacks, "main");

      monitor.startWithoutGitStatus();
      monitor.setHasResourceConfig(true);
      monitor.setHasStatusCommand(true);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(callbacks.onResourceStatusPoll).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(90_000);
      expect(callbacks.onResourceStatusPoll).toHaveBeenCalledWith("/test/worktree");
      expect(callbacks.onResourceStatusPoll).toHaveBeenCalledTimes(1);

      monitor.stop();
    });

    it("switches from 120s to 30s when isCurrent becomes true", async () => {
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
        wslGitEligible: true,
        wslGitOptIn: false,
      };
      const monitor = new WorktreeMonitor(wsl, TEST_CONFIG, makeCallbacks(), "main");
      await monitor.start();

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
          wslGitEligible: true,
          wslGitOptIn: true,
        };
        const monitor = new WorktreeMonitor(wsl, TEST_CONFIG, makeCallbacks(), "main");
        await monitor.start();

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

    it("setWslOptIn re-emits snapshot with updated fields when value changes", async () => {
      const original = process.platform;
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      try {
        const wsl: Worktree = {
          ...TEST_WORKTREE,
          path: "\\\\wsl$\\Ubuntu\\home\\user\\repo",
          isWslPath: true,
          wslDistro: "Ubuntu",
          wslGitEligible: true,
          wslGitOptIn: false,
        };
        const callbacks = makeCallbacks();
        const monitor = new WorktreeMonitor(wsl, TEST_CONFIG, callbacks, "main");
        await monitor.start();

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

      mockGetWorktreeChangesWithStats.mockClear();
      // 10s gap > 3x base interval (6s) but < 30s floor.
      (monitor as unknown as { lastGitStatusCompletedAt: number }).lastGitStatusCompletedAt =
        Date.now() - 10_000;

      await vi.advanceTimersByTimeAsync(5000);

      const moods = getMoodSequence(callbacks);
      expect(moods).not.toContain("stale");

      monitor.stop();
    });

    it("does not mark stale when elapsed exceeds 30s floor but is below 3x interval", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValue(CLEAN_CHANGES);

      const callbacks = makeCallbacks();
      // Use the watcher fallback path: base interval = 30s, threshold = 90s.
      const watcherConfig: WorktreeMonitorConfig = {
        ...TEST_CONFIG,
        gitWatchEnabled: true,
      };
      mockWatcherStartResult = true;
      const monitor = new WorktreeMonitor(TEST_WORKTREE, watcherConfig, callbacks, "main");
      await monitor.start();

      mockGetWorktreeChangesWithStats.mockClear();
      // 60s gap > 30s floor but < 3 * 30s base = 90s threshold.
      (monitor as unknown as { lastGitStatusCompletedAt: number }).lastGitStatusCompletedAt =
        Date.now() - 60_000;

      await vi.advanceTimersByTimeAsync(35_000);

      const moods = getMoodSequence(callbacks);
      expect(moods).not.toContain("stale");

      monitor.stop();
    });

    it("stale mood reverts after the forced refresh completes", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValue(CLEAN_CHANGES);

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
      await monitor.start();

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
    });

    it("does not run heartbeat check after stop()", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValue(CLEAN_CHANGES);

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
      await monitor.start();

      (monitor as unknown as { lastGitStatusCompletedAt: number }).lastGitStatusCompletedAt =
        Date.now() - 60_000;

      monitor.stop();
      mockGetWorktreeChangesWithStats.mockClear();

      await vi.advanceTimersByTimeAsync(120_000);

      const moods = getMoodSequence(callbacks);
      expect(moods).not.toContain("stale");
      expect(mockGetWorktreeChangesWithStats).not.toHaveBeenCalled();
    });

    it("watcher fallback interval (30s) requires 90s+ gap to trigger stale", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValue(CLEAN_CHANGES);
      mockWatcherStartResult = true;

      const watcherConfig: WorktreeMonitorConfig = {
        ...TEST_CONFIG,
        gitWatchEnabled: true,
      };

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, watcherConfig, callbacks, "main");
      await monitor.start();

      // 100s gap exceeds the 90s threshold for the 30s watcher fallback interval.
      (monitor as unknown as { lastGitStatusCompletedAt: number }).lastGitStatusCompletedAt =
        Date.now() - 100_000;

      await vi.advanceTimersByTimeAsync(35_000);

      const moods = getMoodSequence(callbacks);
      expect(moods).toContain("stale");

      monitor.stop();
    });

    it("does not emit stale while a refresh is already in flight", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValue(CLEAN_CHANGES);

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
      await monitor.start();

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
    });

    it("retains 'error' mood when the forced refresh fails", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValueOnce(CLEAN_CHANGES);

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
      await monitor.start();

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
      vi.mocked(getGitDir).mockReturnValue("/test/worktree/.git");
      mockIsRepoOperationInProgress.mockReturnValue(true);

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");

      await monitor.start();

      expect(mockIsRepoOperationInProgress).toHaveBeenCalledWith("/test/worktree/.git");
      expect(mockGetWorktreeChangesWithStats).not.toHaveBeenCalled();

      monitor.stop();
    });

    it("runs git status normally once the operation finishes", async () => {
      vi.mocked(getGitDir).mockReturnValue("/test/worktree/.git");
      mockIsRepoOperationInProgress.mockReturnValue(true);
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
      expect(mockGetWorktreeChangesWithStats).not.toHaveBeenCalled();

      // Simulate the rebase/merge finishing — sentinels disappear, then a
      // subsequent updateGitStatus call exercises the normal flow.
      mockIsRepoOperationInProgress.mockReturnValue(false);
      await monitor.updateGitStatus(true);

      expect(mockGetWorktreeChangesWithStats).toHaveBeenCalledTimes(1);
      expect(callbacks.onUpdate).toHaveBeenCalled();

      monitor.stop();
    });

    it("emits an initial snapshot when start() is skipped mid-operation", async () => {
      vi.mocked(getGitDir).mockReturnValue("/test/worktree/.git");
      mockIsRepoOperationInProgress.mockReturnValue(true);

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");

      await monitor.start();

      // The renderer must still receive a snapshot so the worktree is
      // visible — otherwise it stays invisible until the operation ends.
      expect(callbacks.onUpdate).toHaveBeenCalledTimes(1);
      expect(monitor.hasInitialStatus).toBe(true);
      expect(mockGetWorktreeChangesWithStats).not.toHaveBeenCalled();

      monitor.stop();
    });

    it("does not call isRepoOperationInProgress when getGitDir returns null", async () => {
      vi.mocked(getGitDir).mockReturnValue(null);
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

      expect(mockIsRepoOperationInProgress).not.toHaveBeenCalled();
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
      expect(onScheduleFetch).toHaveBeenCalledWith(TEST_WORKTREE.id, false, false);

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
      expect(onScheduleFetch).toHaveBeenCalledWith(TEST_WORKTREE.id, false, true);

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
  });
});
