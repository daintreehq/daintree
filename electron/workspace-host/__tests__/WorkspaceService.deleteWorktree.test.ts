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

vi.mock("../../services/events.js", () => ({
  events: new EventEmitter(),
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

describe("WorkspaceService.deleteWorktree", () => {
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
      isRunning: false,
      isUpdating: false,
      pollingEnabled: true,
      hasInitialStatus: true,
      previousStateHash: "seed",
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

    const WorkspaceServiceModule = await import("../WorkspaceService.js");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service = new WorkspaceServiceModule.WorkspaceService(mockSendEvent as any);

    // Set up minimal project state
    service["projectRootPath"] = "/test/root";
    service["projectScopeId"] = "test-scope";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service["git"] = mockSimpleGit as any;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends delete-worktree-result success after removing monitor", async () => {
    const monitor = createMonitorState();
    service["monitors"].set("/test/worktree", monitor);

    await service.deleteWorktree("req-1", "/test/worktree");

    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "delete-worktree-result",
        requestId: "req-1",
        success: true,
      })
    );
    expect(service["monitors"].has("/test/worktree")).toBe(false);
  });

  it("sends error result for unknown worktreeId", async () => {
    await service.deleteWorktree("req-2", "/nonexistent/worktree");

    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "delete-worktree-result",
        success: false,
        error: expect.stringContaining("not found"),
      })
    );
  });

  it("blocks deletion of main worktree", async () => {
    const mainMonitor = createMonitorState({ isMainWorktree: true });
    service["monitors"].set("/test/worktree", mainMonitor);

    await service.deleteWorktree("req-3", "/test/worktree");

    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "delete-worktree-result",
        success: false,
        error: expect.stringContaining("main worktree"),
      })
    );
  });

  it("runs teardown before git worktree remove when config exists", async () => {
    const teardownConfig = { teardown: ["docker compose down"] };
    const fsModule = await import("fs/promises");
    const mockAccess = vi.mocked(fsModule.access);
    const mockReadFile = vi.mocked(fsModule.readFile);

    // Make the main repo config exist
    mockAccess.mockImplementation(async (p: unknown) => {
      if ((p as string).endsWith("/test/root/.canopy/config.json")) return undefined;
      throw new Error("ENOENT");
    });
    mockReadFile.mockResolvedValue(JSON.stringify(teardownConfig));

    const childProcessModule = await import("child_process");
    const mockSpawn = vi.mocked(childProcessModule.spawn);

    // Record a global call log so we can compare cross-module ordering
    const globalCallLog: string[] = [];

    mockSpawn.mockImplementation(() => {
      globalCallLog.push("spawn");
      const child = {
        pid: 99,
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
          if (event === "close") setTimeout(() => cb(0), 0);
        }),
        kill: vi.fn(),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return child as any;
    });

    mockSimpleGit.raw.mockImplementation(async (args: string[]) => {
      globalCallLog.push(`git:${args.join(" ")}`);
    });

    const monitor = createMonitorState();
    service["monitors"].set("/test/worktree", monitor);

    await service.deleteWorktree("req-4", "/test/worktree");

    const spawnPos = globalCallLog.indexOf("spawn");
    const gitRemovePos = globalCallLog.findIndex((e) => e.includes("worktree remove"));

    // Both must have happened
    expect(spawnPos).toBeGreaterThanOrEqual(0);
    expect(gitRemovePos).toBeGreaterThanOrEqual(0);
    // Teardown (spawn) must precede git worktree remove
    expect(spawnPos).toBeLessThan(gitRemovePos);
  });

  it("proceeds with deletion even when teardown fails", async () => {
    const teardownConfig = { teardown: ["failing-teardown-cmd"] };
    const fsModule = await import("fs/promises");
    const mockAccess = vi.mocked(fsModule.access);
    const mockReadFile = vi.mocked(fsModule.readFile);

    mockAccess.mockImplementation(async (p: unknown) => {
      if ((p as string).endsWith("/test/root/.canopy/config.json")) return undefined;
      throw new Error("ENOENT");
    });
    mockReadFile.mockResolvedValue(JSON.stringify(teardownConfig));

    const childProcessModule = await import("child_process");
    const mockSpawn = vi.mocked(childProcessModule.spawn);
    mockSpawn.mockImplementation(() => {
      const child = {
        pid: 99,
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
          if (event === "close") setTimeout(() => cb(1), 0); // non-zero exit
        }),
        kill: vi.fn(),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return child as any;
    });

    const monitor = createMonitorState();
    service["monitors"].set("/test/worktree", monitor);

    await service.deleteWorktree("req-5", "/test/worktree");

    // Deletion succeeded despite teardown failure
    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "delete-worktree-result",
        success: true,
      })
    );
    expect(service["monitors"].has("/test/worktree")).toBe(false);
  });

  it("skips teardown when no config file exists", async () => {
    const fsModule = await import("fs/promises");
    vi.mocked(fsModule.access).mockRejectedValue(new Error("ENOENT"));

    const childProcessModule = await import("child_process");
    const mockSpawn = vi.mocked(childProcessModule.spawn);

    const monitor = createMonitorState();
    service["monitors"].set("/test/worktree", monitor);

    await service.deleteWorktree("req-6", "/test/worktree");

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "delete-worktree-result", success: true })
    );
  });
});
