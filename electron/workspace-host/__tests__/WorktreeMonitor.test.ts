import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Worktree } from "../../../shared/types/worktree.js";
import { WorktreeRemovedError } from "../../utils/errorTypes.js";

const mockGetWorktreeChangesWithStats = vi.fn();
const mockInvalidateGitStatusCache = vi.fn();

vi.mock("../../utils/git.js", () => ({
  getWorktreeChangesWithStats: (...args: unknown[]) => mockGetWorktreeChangesWithStats(...args),
  invalidateGitStatusCache: (...args: unknown[]) => mockInvalidateGitStatusCache(...args),
}));

vi.mock("simple-git", () => ({
  simpleGit: vi.fn(() => ({ raw: vi.fn() })),
}));

vi.mock("../../services/worktree/mood.js", () => ({
  categorizeWorktree: vi.fn().mockReturnValue("stable"),
}));

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
});
