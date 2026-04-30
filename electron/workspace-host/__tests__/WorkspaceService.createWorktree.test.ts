import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import type { WorkspaceService } from "../WorkspaceService.js";

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

vi.mock("../../utils/hardenedGit.js", () => ({
  createHardenedGit: vi.fn(() => mockSimpleGit),
  validateCwd: vi.fn(),
  getGitLocaleEnv: vi.fn().mockReturnValue({}),
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
    initialize: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    reset: vi.fn(),
    refresh: vi.fn(),
    getStatus: vi.fn().mockReturnValue({
      state: "idle",
      isPolling: false,
      candidateCount: 0,
      resolvedCount: 0,
      isEnabled: true,
    }),
  },
}));

vi.mock("../../services/events.js", () => ({
  events: new EventEmitter(),
}));

vi.mock("../../utils/gitFileWatcher.js", () => {
  return {
    GitFileWatcher: class {
      start() {
        return false;
      }
      dispose() {}
    },
  };
});

vi.mock("fs/promises", () => ({
  stat: vi.fn().mockRejectedValue(new Error("ENOENT")),
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
  cp: vi.fn().mockResolvedValue(undefined),
}));

function flushAsyncTail(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

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

  it("passes --no-track on issue-mode git add and emits success with the direct-built worktree id", async () => {
    const requestId = "test-request-123";
    const options = {
      baseBranch: "main",
      newBranch: "feature/test",
      path: "/test/worktree",
    };

    const listSpy = vi.spyOn(service["listService"], "list");

    await service.createWorktree(requestId, "/test/root", options);

    expect(mockSimpleGit.raw).toHaveBeenCalledWith([
      "worktree",
      "add",
      "-b",
      "feature/test",
      "--no-track",
      "/test/worktree",
      "main",
    ]);

    expect(waitForPathExists).toHaveBeenCalledWith("/test/worktree", {
      timeoutMs: 500,
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

    // Opt 3: the O(N²) `git worktree list --porcelain` call on the success
    // path is gone — the Worktree object is built directly from inputs.
    await flushAsyncTail();
    expect(listSpy).not.toHaveBeenCalled();
  });

  it("preserves issue-mode-only --no-track: useExistingBranch argv is unchanged", async () => {
    const requestId = "test-request-456";
    const options = {
      baseBranch: "main",
      newBranch: "existing-branch",
      path: "/test/worktree2",
      useExistingBranch: true,
    };

    await service.createWorktree(requestId, "/test/root", options);

    expect(mockSimpleGit.raw).toHaveBeenCalledWith([
      "worktree",
      "add",
      "/test/worktree2",
      "existing-branch",
    ]);
    expect(waitForPathExists).toHaveBeenCalledWith(
      "/test/worktree2",
      expect.objectContaining({ timeoutMs: 500 })
    );
  });

  it("preserves --track (not --no-track) for fromRemote so @{u} resolves for ahead/behind counts", async () => {
    const requestId = "test-request-789";
    const options = {
      baseBranch: "origin/main",
      newBranch: "feature/remote",
      path: "/test/worktree3",
      fromRemote: true,
    };

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
    expect(waitForPathExists).toHaveBeenCalledWith(
      "/test/worktree3",
      expect.objectContaining({ timeoutMs: 500 })
    );
  });

  it("propagates waitForPathExists timeout error and reports 500ms budget", async () => {
    const requestId = "test-request-timeout";
    const options = {
      baseBranch: "main",
      newBranch: "feature/timeout",
      path: "/test/worktree-timeout",
    };

    waitForPathExists.mockRejectedValueOnce(
      new Error("Timeout waiting for path to exist: /test/worktree-timeout (waited 500ms)")
    );

    await service.createWorktree(requestId, "/test/root", options);

    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "create-worktree-result",
        requestId: "test-request-timeout",
        success: false,
        error: expect.stringContaining("waited 500ms"),
      })
    );
  });

  it("handles delayed directory creation", async () => {
    const requestId = "test-request-delayed";
    const options = {
      baseBranch: "main",
      newBranch: "feature/delayed",
      path: "/test/worktree-delayed",
    };

    let resolveWait: (() => void) | undefined;
    const waitPromise = new Promise<void>((resolve) => {
      resolveWait = resolve;
    });
    waitForPathExists.mockReturnValue(waitPromise);

    const createPromise = service.createWorktree(requestId, "/test/root", options);

    await Promise.resolve();
    expect(mockSimpleGit.raw).toHaveBeenCalled();
    expect(waitForPathExists).toHaveBeenCalledTimes(1);

    const createResultCalls = mockSendEvent.mock.calls.filter(
      ([event]: [{ type: string }]) => event?.type === "create-worktree-result"
    );
    // Result event must NOT fire while waitForPathExists is unresolved — that
    // guard preserves the contract that the directory exists before callers
    // use it.
    expect(createResultCalls).toHaveLength(0);

    resolveWait!();
    await createPromise;

    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "create-worktree-result",
        success: true,
      })
    );
  });

  it("skips monitor registration and tail work when waitForPathExists fails", async () => {
    const requestId = "test-request-fail";
    const options = {
      baseBranch: "main",
      newBranch: "feature/fail",
      path: "/test/worktree-fail",
    };

    waitForPathExists.mockRejectedValueOnce(new Error("Path does not exist"));

    const invalidateSpy = vi.spyOn(service["listService"], "invalidateCache");
    const listSpy = vi.spyOn(service["listService"], "list");
    const copySpy = vi.spyOn(service["lifecycleService"], "copyDaintreeDir");

    await service.createWorktree(requestId, "/test/root", options);
    await flushAsyncTail();

    expect(mockSendEvent).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    expect(service["monitors"].has("/test/worktree-fail")).toBe(false);
    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(listSpy).not.toHaveBeenCalled();
    expect(copySpy).not.toHaveBeenCalled();
  });

  it("emits create-worktree-result before the fire-and-forget tail resolves", async () => {
    const requestId = "test-request-tail-order";
    const options = {
      baseBranch: "main",
      newBranch: "feature/tail-order",
      path: "/test/worktree-tail-order",
    };

    let resolveCopy: (() => void) | undefined;
    const copyPromise = new Promise<void>((resolve) => {
      resolveCopy = resolve;
    });
    const copySpy = vi
      .spyOn(service["lifecycleService"], "copyDaintreeDir")
      .mockImplementation(() => copyPromise);

    await service.createWorktree(requestId, "/test/root", options);

    // Event fires after synchronous monitor registration but before the tail
    // (copyDaintreeDir) resolves.
    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "create-worktree-result",
        requestId: "test-request-tail-order",
        success: true,
      })
    );

    // copyDaintreeDir is running in the tail — not resolved yet.
    await flushAsyncTail();
    expect(copySpy).toHaveBeenCalled();

    resolveCopy!();
    await flushAsyncTail();
  });

  it("logs async tail failure without firing a second create-worktree-result event", async () => {
    const requestId = "test-request-tail-fail";
    const options = {
      baseBranch: "main",
      newBranch: "feature/tail-fail",
      path: "/test/worktree-tail-fail",
    };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(service["lifecycleService"], "copyDaintreeDir").mockRejectedValueOnce(
      new Error("copyDaintreeDir exploded")
    );

    await service.createWorktree(requestId, "/test/root", options);
    await flushAsyncTail();

    // Exactly one create-worktree-result event, and it's the success event —
    // tail failure is logged but never reaches the renderer as a second
    // create-worktree-result. (worktree-update events from monitor
    // registration are a different event type and don't count.)
    const createResultCalls = mockSendEvent.mock.calls.filter(
      ([event]: [{ type: string }]) => event?.type === "create-worktree-result"
    );
    expect(createResultCalls).toHaveLength(1);
    expect(createResultCalls[0][0]).toEqual(
      expect.objectContaining({
        type: "create-worktree-result",
        success: true,
      })
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("createWorktree async tail failed"),
      expect.any(Error)
    );

    warnSpy.mockRestore();
  });

  it("registers the monitor synchronously before emitting create-worktree-result", async () => {
    // Regression guard for the bug where monitor availability lagged event
    // emission. Any caller that synchronously queries this.monitors.get(id)
    // in response to the success event must find a live monitor.
    const requestId = "test-request-sync";
    const options = {
      baseBranch: "main",
      newBranch: "feature/sync-monitor",
      path: "/test/worktree-sync",
    };

    let monitorPresentAtEmission: boolean | null = null;
    mockSendEvent.mockImplementation((event: { type: string; worktreeId?: string }) => {
      if (event.type === "create-worktree-result" && event.worktreeId) {
        monitorPresentAtEmission = service["monitors"].has(event.worktreeId);
      }
    });

    await service.createWorktree(requestId, "/test/root", options);

    expect(monitorPresentAtEmission).toBe(true);
    expect(service["monitors"].has("/test/worktree-sync")).toBe(true);
  });

  it("emits a worktree-update before create-worktree-result so the renderer's store picks up the new worktree", async () => {
    // Regression guard for the bug where startWithoutGitStatus never emitted
    // an initial snapshot, leaving freshly-created worktrees invisible in the
    // UI until the first watcher fire or manual refresh.
    const requestId = "test-request-store";
    const options = {
      baseBranch: "main",
      newBranch: "feature/store-sync",
      path: "/test/worktree-store",
    };

    await service.createWorktree(requestId, "/test/root", options);

    const eventTypes = mockSendEvent.mock.calls.map(
      ([event]: [{ type: string; worktreeId?: string }]) => event?.type
    );
    const firstUpdateIndex = eventTypes.indexOf("worktree-update");
    const createResultIndex = eventTypes.indexOf("create-worktree-result");

    expect(firstUpdateIndex).toBeGreaterThanOrEqual(0);
    expect(createResultIndex).toBeGreaterThanOrEqual(0);
    expect(firstUpdateIndex).toBeLessThan(createResultIndex);

    // The emitted update must carry the correct worktree id.
    const updateCall = mockSendEvent.mock.calls[firstUpdateIndex][0];
    expect(updateCall.worktree).toEqual(
      expect.objectContaining({ id: "/test/worktree-store", branch: "feature/store-sync" })
    );
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

    service["listService"].list = vi.fn().mockResolvedValue(rawWorktrees);
    service["syncMonitors"] = vi.fn().mockResolvedValue(undefined);
    service["initializePRService"] = vi.fn().mockReturnValue(prPromise);
    service["refreshAll"] = vi.fn().mockReturnValue(refreshPromise);

    await service.loadProject("req-1", "/test/root");

    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "load-project-result",
        requestId: "req-1",
        success: true,
      })
    );
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
    service["listService"].setGit(
      mockSimpleGit as unknown as import("simple-git").SimpleGit,
      "/repo"
    );

    const first = await service["listService"].list();
    const second = await service["listService"].list();

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
    service["listService"].setGit(
      mockSimpleGit as unknown as import("simple-git").SimpleGit,
      "/repo"
    );

    await service["listService"].list();
    await service["listService"].list({ forceRefresh: true });

    expect(mockSimpleGit.raw).toHaveBeenCalledTimes(2);
  });

  it("uses the worktree folder name for detached worktrees", () => {
    const mapped = service["listService"].mapToWorktrees([
      {
        path: "/repo/daintree-bisect/cross-worktree-diff-2026-03-06",
        branch: "",
        head: "a4b85920ee91c51a265eb7ceb98a23381d4ba08f",
        isDetached: true,
        isMainWorktree: false,
        bare: false,
      },
    ]);

    expect(mapped).toEqual([
      expect.objectContaining({
        name: "cross-worktree-diff-2026-03-06",
        head: "a4b85920ee91c51a265eb7ceb98a23381d4ba08f",
        isDetached: true,
      }),
    ]);
  });
});
