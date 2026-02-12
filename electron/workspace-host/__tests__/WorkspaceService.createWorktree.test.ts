import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import type { WorkspaceService } from "../WorkspaceService.js";
import type { MonitorState } from "../types.js";
import type { WorktreeChanges } from "../../types/index.js";

// Mocks need to be hoisted or defined in vi.mock
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
    return {
      read: vi.fn().mockResolvedValue({}),
    };
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
  access: vi.fn().mockResolvedValue(undefined),
}));

describe("WorkspaceService.createWorktree", () => {
  let service: WorkspaceService;
  let waitForPathExists: any;
  let mockSendEvent: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    const fsModule = await import("../../utils/fs.js");
    waitForPathExists = vi.mocked(fsModule.waitForPathExists);

    mockSendEvent = vi.fn();

    const WorkspaceServiceModule = await import("../WorkspaceService.js");
    service = new WorkspaceServiceModule.WorkspaceService(mockSendEvent);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should call waitForPathExists after git worktree add", async () => {
    const requestId = "test-request-123";
    const options = {
      baseBranch: "main",
      newBranch: "feature/test",
      path: "/test/worktree",
    };

    service["listWorktreesFromGit"] = vi.fn().mockResolvedValue([
      {
        path: "/test/worktree",
        branch: "feature/test",
        head: "abc123",
        isDetached: false,
        isMainWorktree: false,
      },
    ]);

    await service.createWorktree(requestId, "/test/root", options);

    expect(mockSimpleGit.raw).toHaveBeenCalledWith([
      "worktree",
      "add",
      "-b",
      "feature/test",
      "/test/worktree",
      "main",
    ]);

    expect(waitForPathExists).toHaveBeenCalledWith("/test/worktree", {
      timeoutMs: 5000,
      initialRetryDelayMs: 50,
      maxRetryDelayMs: 800,
    });

    const gitCallOrder = mockSimpleGit.raw.mock.invocationCallOrder[0];
    const waitCallOrder = waitForPathExists.mock.invocationCallOrder[0];
    expect(gitCallOrder).toBeLessThan(waitCallOrder);

    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "create-worktree-result",
        requestId: "test-request-123",
        success: true,
        worktreeId: "/test/worktree",
      })
    );
  });

  it("should call waitForPathExists for useExistingBranch flow", async () => {
    const requestId = "test-request-456";
    const options = {
      baseBranch: "main",
      newBranch: "existing-branch",
      path: "/test/worktree2",
      useExistingBranch: true,
    };

    service["listWorktreesFromGit"] = vi.fn().mockResolvedValue([
      {
        path: "/test/worktree2",
        branch: "existing-branch",
        head: "def456",
        isDetached: false,
        isMainWorktree: false,
      },
    ]);

    await service.createWorktree(requestId, "/test/root", options);

    expect(mockSimpleGit.raw).toHaveBeenCalledWith([
      "worktree",
      "add",
      "/test/worktree2",
      "existing-branch",
    ]);
    expect(waitForPathExists).toHaveBeenCalledWith("/test/worktree2", expect.any(Object));
  });

  it("should call waitForPathExists for fromRemote flow", async () => {
    const requestId = "test-request-789";
    const options = {
      baseBranch: "origin/main",
      newBranch: "feature/remote",
      path: "/test/worktree3",
      fromRemote: true,
    };

    service["listWorktreesFromGit"] = vi.fn().mockResolvedValue([
      {
        path: "/test/worktree3",
        branch: "feature/remote",
        head: "ghi789",
        isDetached: false,
        isMainWorktree: false,
      },
    ]);

    await service.createWorktree(requestId, "/test/root", options);

    expect(mockSimpleGit.raw).toHaveBeenCalledWith([
      "worktree",
      "add",
      "-b",
      "feature/remote",
      "--track",
      "/test/worktree3",
      "origin/main",
    ]);
    expect(waitForPathExists).toHaveBeenCalledWith("/test/worktree3", expect.any(Object));
  });

  it("should propagate waitForPathExists timeout error", async () => {
    const requestId = "test-request-timeout";
    const options = {
      baseBranch: "main",
      newBranch: "feature/timeout",
      path: "/test/worktree-timeout",
    };

    waitForPathExists.mockRejectedValueOnce(
      new Error("Timeout waiting for path to exist: /test/worktree-timeout (waited 5000ms)")
    );

    await service.createWorktree(requestId, "/test/root", options);

    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "create-worktree-result",
        requestId: "test-request-timeout",
        success: false,
        error: expect.stringContaining("Timeout waiting for path to exist"),
      })
    );
  });

  it("should handle delayed directory creation", async () => {
    const requestId = "test-request-delayed";
    const options = {
      baseBranch: "main",
      newBranch: "feature/delayed",
      path: "/test/worktree-delayed",
    };

    vi.useFakeTimers();

    let resolveWait: (() => void) | undefined;
    const waitPromise = new Promise<void>((resolve) => {
      resolveWait = resolve;
    });
    waitForPathExists.mockReturnValue(waitPromise);

    service["listWorktreesFromGit"] = vi.fn().mockResolvedValue([
      {
        path: "/test/worktree-delayed",
        branch: "feature/delayed",
        head: "jkl012",
        isDetached: false,
        isMainWorktree: false,
      },
    ]);

    const createPromise = service.createWorktree(requestId, "/test/root", options);

    await vi.runAllTimersAsync();
    expect(mockSimpleGit.raw).toHaveBeenCalled();
    expect(waitForPathExists).toHaveBeenCalledTimes(1);

    resolveWait!();
    await createPromise;

    vi.useRealTimers();
  });

  it("should not proceed to ensureNoteFile if waitForPathExists fails", async () => {
    const requestId = "test-request-fail";
    const options = {
      baseBranch: "main",
      newBranch: "feature/fail",
      path: "/test/worktree-fail",
    };

    waitForPathExists.mockRejectedValueOnce(new Error("Path does not exist"));

    const fsPromisesModule = await import("fs/promises");
    const statSpy = vi.mocked(fsPromisesModule.stat);
    const mkdirSpy = vi.mocked(fsPromisesModule.mkdir);
    const writeFileSpy = vi.mocked(fsPromisesModule.writeFile);
    statSpy.mockClear();
    mkdirSpy.mockClear();
    writeFileSpy.mockClear();

    const listWorktreesSpy = vi.spyOn(service as any, "listWorktreesFromGit");
    listWorktreesSpy.mockClear();

    await service.createWorktree(requestId, "/test/root", options);

    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
      })
    );

    expect(statSpy).not.toHaveBeenCalled();
    expect(mkdirSpy).not.toHaveBeenCalled();
    expect(writeFileSpy).not.toHaveBeenCalled();

    expect(listWorktreesSpy).not.toHaveBeenCalled();
  });
});

describe("WorkspaceService.loadProject performance behavior", () => {
  let service: WorkspaceService;
  let mockSendEvent: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSendEvent = vi.fn();
    const WorkspaceServiceModule = await import("../WorkspaceService.js");
    service = new WorkspaceServiceModule.WorkspaceService(
      mockSendEvent as unknown as (
        event: import("../../../shared/types/workspace-host.js").WorkspaceHostEvent
      ) => void
    );
  });

  it("returns load-project success without waiting for PR init and full refresh", async () => {
    const rawWorktrees = [
      {
        path: "/test/worktree",
        branch: "main",
        head: "abc123",
        isDetached: false,
        isMainWorktree: true,
        bare: false,
      },
    ];

    let resolvePr!: () => void;
    let resolveRefresh!: () => void;
    const prPromise = new Promise<void>((resolve) => {
      resolvePr = resolve;
    });
    const refreshPromise = new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    });

    service["listWorktreesFromGit"] = vi.fn().mockResolvedValue(rawWorktrees);
    service["syncMonitors"] = vi.fn().mockResolvedValue(undefined);
    service["initializePRService"] = vi.fn().mockReturnValue(prPromise);
    service["refreshAll"] = vi.fn().mockReturnValue(refreshPromise);

    await service.loadProject("req-1", "/test/root");

    expect(mockSendEvent).toHaveBeenCalledWith({
      type: "load-project-result",
      requestId: "req-1",
      success: true,
    });
    expect(service["initializePRService"]).toHaveBeenCalledTimes(1);
    expect(service["refreshAll"]).toHaveBeenCalledTimes(1);

    resolvePr();
    resolveRefresh();
    await Promise.resolve();
  });

  it("uses cached worktree list between repeated reads for the same project root", async () => {
    const porcelainOutput = [
      "worktree /repo/main",
      "HEAD 0123456789abcdef",
      "branch refs/heads/main",
      "",
    ].join("\n");

    mockSimpleGit.raw.mockResolvedValue(porcelainOutput);
    service["projectRootPath"] = "/repo";
    service["git"] = mockSimpleGit as unknown as import("simple-git").SimpleGit;

    const first = await service["listWorktreesFromGit"]();
    const second = await service["listWorktreesFromGit"]();

    expect(first).toEqual(second);
    expect(mockSimpleGit.raw).toHaveBeenCalledTimes(1);
  });

  it("bypasses cache when forceRefresh is requested", async () => {
    const porcelainOutput = [
      "worktree /repo/main",
      "HEAD 0123456789abcdef",
      "branch refs/heads/main",
      "",
    ].join("\n");

    mockSimpleGit.raw.mockResolvedValue(porcelainOutput);
    service["projectRootPath"] = "/repo";
    service["git"] = mockSimpleGit as unknown as import("simple-git").SimpleGit;

    await service["listWorktreesFromGit"]();
    await service["listWorktreesFromGit"]({ forceRefresh: true });

    expect(mockSimpleGit.raw).toHaveBeenCalledTimes(2);
  });
});

describe("WorkspaceService git watcher refresh behavior", () => {
  let service: WorkspaceService;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    const WorkspaceServiceModule = await import("../WorkspaceService.js");
    service = new WorkspaceServiceModule.WorkspaceService(vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createMonitorState(): MonitorState {
    const changes = [
      {
        path: "/test/worktree/file.ts",
        status: "modified" as const,
        insertions: 2,
        deletions: 1,
      },
    ];

    return {
      id: "/test/worktree",
      path: "/test/worktree",
      name: "feature/test",
      branch: "feature/test",
      isCurrent: true,
      isMainWorktree: false,
      gitDir: "/test/worktree/.git",
      worktreeId: "/test/worktree",
      summary: "Working",
      modifiedCount: 1,
      changes,
      mood: "stable",
      worktreeChanges: {
        head: "abc123",
        isDirty: true,
        stagedFileCount: 1,
        unstagedFileCount: 0,
        untrackedFileCount: 0,
        conflictedFileCount: 0,
        changedFileCount: 1,
        changes,
      },
      lastActivityTimestamp: null,
      createdAt: Date.now(),
      pollingTimer: null,
      resumeTimer: null,
      pollingInterval: 2000,
      isRunning: true,
      isUpdating: false,
      pollingEnabled: true,
      hasInitialStatus: true,
      previousStateHash: "seed",
      pollingStrategy: {
        updateConfig: vi.fn(),
        setBaseInterval: vi.fn(),
        isCircuitBreakerTripped: vi.fn().mockReturnValue(false),
        calculateNextInterval: vi.fn().mockReturnValue(2000),
        recordSuccess: vi.fn(),
        recordFailure: vi.fn(),
      },
      noteReader: { read: vi.fn().mockResolvedValue(null) },
      gitWatcher: null,
      gitWatchDebounceTimer: null,
      gitWatchRefreshPending: false,
      gitWatchEnabled: true,
    } as unknown as MonitorState;
  }

  it("does not drop git watch refreshes when debounce fires during an in-flight update", async () => {
    const gitModule = await import("../../utils/git.js");
    const getWorktreeChangesWithStatsMock = vi.mocked(gitModule.getWorktreeChangesWithStats);
    const monitor = createMonitorState();
    service["gitWatchDebounceMs"] = 50;

    const firstResult: WorktreeChanges = {
      worktreeId: monitor.id,
      rootPath: monitor.path,
      changedFileCount: 1,
      changes: monitor.changes ?? [],
      lastCommitMessage: "feat: update",
    };

    let resolveFirstUpdate!: (value: typeof firstResult) => void;
    const firstUpdateResult = new Promise<typeof firstResult>((resolve) => {
      resolveFirstUpdate = resolve;
    });

    getWorktreeChangesWithStatsMock.mockReset();
    getWorktreeChangesWithStatsMock.mockImplementationOnce(() => firstUpdateResult);
    getWorktreeChangesWithStatsMock.mockResolvedValue(firstResult);

    const inFlightUpdate = service["updateGitStatus"](monitor, true);
    expect(monitor.isUpdating).toBe(true);

    service["handleGitFileChange"](monitor);
    await vi.advanceTimersByTimeAsync(60);

    expect(monitor.gitWatchRefreshPending).toBe(true);
    expect(getWorktreeChangesWithStatsMock).toHaveBeenCalledTimes(1);

    resolveFirstUpdate(firstResult);
    await inFlightUpdate;
    await Promise.resolve();
    await Promise.resolve();

    expect(getWorktreeChangesWithStatsMock).toHaveBeenCalledTimes(2);
    expect(monitor.gitWatchRefreshPending).toBe(false);
  });
});
