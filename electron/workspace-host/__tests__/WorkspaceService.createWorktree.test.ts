import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import type { WorkspaceService } from "../WorkspaceService.js";

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
