import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import type { WorkspaceService } from "../WorkspaceService.js";
import type { MonitorState } from "../types.js";

const mockSimpleGit = {
  raw: vi.fn().mockResolvedValue(undefined),
  branch: vi.fn().mockResolvedValue({ current: "main" }),
};

vi.mock("simple-git", () => ({
  simpleGit: vi.fn(() => mockSimpleGit),
}));

vi.mock("../../utils/fs.js", () => ({
  waitForPathExists: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../utils/git.js", () => ({
  invalidateGitStatusCache: vi.fn(),
  getWorktreeChangesWithStats: vi.fn().mockResolvedValue({
    head: "abc123",
    isDirty: false,
    stagedFileCount: 0,
    unstagedFileCount: 0,
    untrackedFileCount: 0,
    conflictedFileCount: 0,
    changedFileCount: 0,
    changes: [],
  }),
}));

vi.mock("../../utils/gitUtils.js", () => ({
  getGitDir: vi.fn().mockReturnValue("/test/worktree/.git"),
  clearGitDirCache: vi.fn(),
}));

vi.mock("../../services/worktree/mood.js", () => ({
  categorizeWorktree: vi.fn().mockReturnValue("stable"),
}));

vi.mock("../../services/issueExtractor.js", () => ({
  extractIssueNumberSync: vi.fn().mockReturnValue(null),
  extractIssueNumber: vi.fn().mockResolvedValue(null),
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

vi.mock("../../services/github/GitHubAuth.js", () => ({
  GitHubAuth: vi.fn().mockImplementation(() => ({
    getToken: vi.fn().mockResolvedValue(null),
  })),
}));

vi.mock("../../services/PullRequestService.js", () => ({
  pullRequestService: {
    start: vi.fn(),
    stop: vi.fn(),
    getStatus: vi.fn().mockReturnValue({ state: "idle" }),
  },
}));

const mockEvents = new EventEmitter();
vi.mock("../../services/events.js", () => ({
  events: mockEvents,
}));

vi.mock("fs/promises", () => ({
  stat: vi.fn().mockRejectedValue(new Error("ENOENT")),
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockRejectedValue(new Error("ENOENT")),
  readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
  cp: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

// Mock existsSync from fs — must preserve realpathSync
const mockExistsSync = vi.fn().mockReturnValue(true);
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: mockExistsSync,
    realpathSync: actual.realpathSync,
  };
});

describe("WorkspaceService external worktree removal", () => {
  let service: WorkspaceService;
  let mockSendEvent: ReturnType<typeof vi.fn>;

  function createMonitorState(overrides: Partial<MonitorState> = {}): MonitorState {
    return {
      id: "/test/worktree",
      path: "/test/worktree",
      name: "feature/test",
      branch: "feature/test",
      isCurrent: false,
      isMainWorktree: false,
      gitDir: "/test/worktree/.git",
      worktreeId: "/test/worktree",
      summary: "Working",
      modifiedCount: 0,
      changes: [],
      mood: "stable",
      worktreeChanges: {
        worktreeId: "/test/worktree",
        rootPath: "/test/worktree",
        changedFileCount: 0,
        changes: [],
      },
      lastActivityTimestamp: null,
      createdAt: Date.now(),
      pollingTimer: null,
      resumeTimer: null,
      pollingInterval: 10000,
      isRunning: true,
      isUpdating: false,
      pollingEnabled: true,
      hasInitialStatus: true,
      previousStateHash: "seed",
      projectScopeId: "test-scope",
      pollingStrategy: {
        updateConfig: vi.fn(),
        setBaseInterval: vi.fn(),
        isCircuitBreakerTripped: vi.fn().mockReturnValue(false),
        calculateNextInterval: vi.fn().mockReturnValue(10000),
        recordSuccess: vi.fn(),
        recordFailure: vi.fn(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      noteReader: { read: vi.fn().mockResolvedValue(null) } as any,
      gitWatcher: null,
      gitWatchDebounceTimer: null,
      gitWatchRefreshPending: false,
      gitWatchEnabled: false,
      lastGitStatusCompletedAt: 0,
      ...overrides,
    } as MonitorState;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSendEvent = vi.fn();
    mockExistsSync.mockReturnValue(true);

    const WorkspaceServiceModule = await import("../WorkspaceService.js");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service = new WorkspaceServiceModule.WorkspaceService(mockSendEvent as any);

    service["projectRootPath"] = "/test/root";
    service["projectScopeId"] = "test-scope";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service["git"] = mockSimpleGit as any;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("poll() circuit breaker + external deletion", () => {
    it("detects externally deleted worktree when circuit breaker is tripped", async () => {
      const monitor = createMonitorState({
        isRunning: true,
        pollingStrategy: {
          updateConfig: vi.fn(),
          setBaseInterval: vi.fn(),
          isCircuitBreakerTripped: vi.fn().mockReturnValue(true),
          calculateNextInterval: vi.fn().mockReturnValue(10000),
          recordSuccess: vi.fn(),
          recordFailure: vi.fn(),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      });
      service["monitors"].set("/test/worktree", monitor);

      // Directory no longer exists
      mockExistsSync.mockReturnValue(false);

      // Call poll directly (private method access)
      await service["poll"](monitor, false);

      // Should have checked the correct path
      expect(mockExistsSync).toHaveBeenCalledWith("/test/worktree");
      // Should have called handleExternalWorktreeRemoval → sendEvent
      expect(mockSendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "worktree-removed",
          worktreeId: "/test/worktree",
        })
      );
      // Monitor should be removed
      expect(service["monitors"].has("/test/worktree")).toBe(false);
    });

    it("does not remove worktree when circuit breaker is tripped but path exists", async () => {
      const monitor = createMonitorState({
        isRunning: true,
        pollingStrategy: {
          updateConfig: vi.fn(),
          setBaseInterval: vi.fn(),
          isCircuitBreakerTripped: vi.fn().mockReturnValue(true),
          calculateNextInterval: vi.fn().mockReturnValue(10000),
          recordSuccess: vi.fn(),
          recordFailure: vi.fn(),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      });
      service["monitors"].set("/test/worktree", monitor);

      // Directory still exists
      mockExistsSync.mockReturnValue(true);

      await service["poll"](monitor, false);

      // Should have checked the correct path
      expect(mockExistsSync).toHaveBeenCalledWith("/test/worktree");
      // Should NOT have sent worktree-removed
      expect(mockSendEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "worktree-removed" })
      );
      // Monitor should still be in the map
      expect(service["monitors"].has("/test/worktree")).toBe(true);
    });

    it("does not remove main worktree even when circuit breaker tripped and path is gone", async () => {
      const monitor = createMonitorState({
        isRunning: true,
        isMainWorktree: true,
        pollingStrategy: {
          updateConfig: vi.fn(),
          setBaseInterval: vi.fn(),
          isCircuitBreakerTripped: vi.fn().mockReturnValue(true),
          calculateNextInterval: vi.fn().mockReturnValue(10000),
          recordSuccess: vi.fn(),
          recordFailure: vi.fn(),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      });
      service["monitors"].set("/test/worktree", monitor);

      mockExistsSync.mockReturnValue(false);

      await service["poll"](monitor, false);

      // Main worktree should NOT be removed
      expect(service["monitors"].has("/test/worktree")).toBe(true);
      expect(mockSendEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "worktree-removed" })
      );
    });
  });

  describe("handleExternalWorktreeRemoval() scope guard", () => {
    it("emits removal event even when monitor scope differs from service scope", () => {
      const monitor = createMonitorState({
        projectScopeId: "old-scope",
      });
      service["monitors"].set("/test/worktree", monitor);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      service["handleExternalWorktreeRemoval"](monitor);

      // Event should still be sent despite scope mismatch
      expect(mockSendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "worktree-removed",
          worktreeId: "/test/worktree",
          projectScopeId: "test-scope",
        })
      );
      // Warning should be logged
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Scope ID mismatch"));
      // Monitor should be cleaned up
      expect(service["monitors"].has("/test/worktree")).toBe(false);

      warnSpy.mockRestore();
    });

    it("does not emit removal event when service projectScopeId is null", () => {
      service["projectScopeId"] = null;
      const monitor = createMonitorState({ projectScopeId: null });
      service["monitors"].set("/test/worktree", monitor);

      service["handleExternalWorktreeRemoval"](monitor);

      expect(mockSendEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "worktree-removed" })
      );
      // Monitor should still be cleaned up
      expect(service["monitors"].has("/test/worktree")).toBe(false);
    });
  });
});
