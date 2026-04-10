import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Worktree } from "../../../shared/types/worktree.js";
import { WorktreeRemovedError } from "../../utils/errorTypes.js";

const mockGetWorktreeChangesWithStats = vi.fn();
const mockInvalidateGitStatusCache = vi.fn();
const mockGitRaw = vi.fn();

vi.mock("../../utils/hardenedGit.js", () => ({
  createHardenedGit: vi.fn(() => ({
    raw: (...args: unknown[]) => mockGitRaw(...args),
    log: vi.fn().mockResolvedValue({ latest: null }),
  })),
  validateCwd: vi.fn(),
}));

vi.mock("../../utils/git.js", () => ({
  getWorktreeChangesWithStats: (...args: unknown[]) => mockGetWorktreeChangesWithStats(...args),
  invalidateGitStatusCache: (...args: unknown[]) => mockInvalidateGitStatusCache(...args),
}));

vi.mock("simple-git", () => ({
  simpleGit: vi.fn(() => ({ raw: vi.fn(), log: vi.fn().mockResolvedValue({ latest: null }) })),
}));

vi.mock("../../services/worktree/mood.js", () => ({
  categorizeWorktree: vi.fn().mockReturnValue("stable"),
}));

vi.mock("../../services/issueExtractor.js", () => ({
  extractIssueNumberSync: vi.fn().mockReturnValue(null),
  extractIssueNumber: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../utils/gitUtils.js", () => ({
  getGitDir: vi.fn().mockReturnValue(null),
  clearGitDirCache: vi.fn(),
}));

let mockWatcherStartResult = false;
let capturedOnWatcherFailed: (() => void) | undefined;

vi.mock("../../utils/gitFileWatcher.js", () => {
  return {
    GitFileWatcher: class {
      constructor(opts: { onWatcherFailed?: () => void }) {
        capturedOnWatcherFailed = opts.onWatcherFailed;
      }
      start() {
        return mockWatcherStartResult;
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
    mockWatcherStartResult = false;
    capturedOnWatcherFailed = undefined;
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
    const CLEAN_CHANGES = {
      worktreeId: "/test/worktree",
      rootPath: "/test",
      changes: [],
      changedFileCount: 0,
      lastUpdated: Date.now(),
    };

    it("includes aheadCount and behindCount in snapshot when upstream is configured", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValue(CLEAN_CHANGES);
      mockGitRaw.mockResolvedValue("3\t1\n");

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
      await monitor.start();

      const snapshot = monitor.getSnapshot();
      expect(snapshot.aheadCount).toBe(3);
      expect(snapshot.behindCount).toBe(1);

      monitor.stop();
    });

    it("leaves counts undefined when no upstream is configured", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValue(CLEAN_CHANGES);
      mockGitRaw.mockRejectedValue(
        new Error("fatal: no upstream configured for branch 'test-branch'")
      );

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
      await monitor.start();

      const snapshot = monitor.getSnapshot();
      expect(snapshot.aheadCount).toBeUndefined();
      expect(snapshot.behindCount).toBeUndefined();

      monitor.stop();
    });

    it("leaves counts undefined on detached HEAD (no branch)", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValue(CLEAN_CHANGES);
      mockGitRaw.mockResolvedValue("0\t0\n");

      const detachedWorktree: Worktree = {
        ...TEST_WORKTREE,
        branch: undefined,
      };

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(detachedWorktree, TEST_CONFIG, callbacks, "main");
      await monitor.start();

      const snapshot = monitor.getSnapshot();
      expect(snapshot.aheadCount).toBeUndefined();
      expect(snapshot.behindCount).toBeUndefined();
      expect(mockGitRaw).not.toHaveBeenCalledWith(expect.arrayContaining(["rev-list"]));

      monitor.stop();
    });

    it("reports zero counts when branch is in sync with upstream", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValue(CLEAN_CHANGES);
      mockGitRaw.mockResolvedValue("0\t0\n");

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
      await monitor.start();

      const snapshot = monitor.getSnapshot();
      expect(snapshot.aheadCount).toBe(0);
      expect(snapshot.behindCount).toBe(0);

      monitor.stop();
    });
  });

  describe("watcher retry", () => {
    const WATCH_CONFIG: WorktreeMonitorConfig = {
      ...TEST_CONFIG,
      gitWatchEnabled: true,
    };

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
      const monitor = new WorktreeMonitor(TEST_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();

      expect(monitor.hasWatcher).toBe(true);
      monitor.stop();
    });

    it("watcher start failure schedules retry", async () => {
      mockWatcherStartResult = false;
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

      expect(monitor.hasWatcher).toBe(false);

      // After retry interval, watcher should attempt again
      mockWatcherStartResult = true;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(monitor.hasWatcher).toBe(true);

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
      const monitor = new WorktreeMonitor(TEST_WORKTREE, WATCH_CONFIG, callbacks, "main");
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
      const monitor = new WorktreeMonitor(TEST_WORKTREE, WATCH_CONFIG, callbacks, "main");
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

    it("runtime watcher failure triggers retry", async () => {
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

      expect(monitor.hasWatcher).toBe(true);

      // Simulate runtime watcher failure
      capturedOnWatcherFailed?.();
      expect(monitor.hasWatcher).toBe(false);

      // After retry interval, watcher should restart
      await vi.advanceTimersByTimeAsync(30_000);
      expect(monitor.hasWatcher).toBe(true);

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
});
