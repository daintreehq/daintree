import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import type { WorkspaceService } from "../WorkspaceService.js";

const mockSimpleGit = {
  raw: vi.fn().mockResolvedValue(undefined),
  branch: vi.fn().mockResolvedValue({ current: "main" }),
  branchLocal: vi.fn().mockResolvedValue({ all: [], current: "", branches: {}, detached: false }),
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

    // restoreAllMocks (in afterEach) wipes mockResolvedValue so we re-anchor
    // the defaults each test. Without this, branchLocal returns undefined on
    // the second test onwards, which the createWorktree pre-flight handles
    // via try/catch — but the fallback masks real test failures.
    mockSimpleGit.raw.mockResolvedValue(undefined);
    mockSimpleGit.branch.mockResolvedValue({ current: "main" });
    mockSimpleGit.branchLocal.mockResolvedValue({
      all: [],
      current: "",
      branches: {},
      detached: false,
    });

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

    // The pre-flight branchLocal check (added for #6463) adds one microtask
    // hop before git.raw is reached on the happy path; flush via setImmediate
    // so this assertion isn't tied to the precise tick count.
    await flushAsyncTail();
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

  it("reuses a stale local branch (no -b) when it exists locally and is not checked out in any worktree", async () => {
    // #6463 regression guard: a leftover local branch from a previously
    // deleted worktree must not poison the next create. Reuse semantics
    // (`git worktree add <path> <branch>`) preserve the user's chosen name.
    mockSimpleGit.branchLocal.mockResolvedValueOnce({
      all: ["main", "bugfix/issue-6463"],
      current: "main",
      branches: {},
      detached: false,
    });
    // git worktree list --porcelain — only main is checked out, the stale
    // bugfix/issue-6463 branch has no live worktree.
    mockSimpleGit.raw.mockImplementationOnce((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return Promise.resolve(
          ["worktree /test/root", "HEAD abc123", "branch refs/heads/main", ""].join("\n")
        );
      }
      return Promise.resolve(undefined);
    });

    await service.createWorktree("req-stale-reuse", "/test/root", {
      baseBranch: "main",
      newBranch: "bugfix/issue-6463",
      path: "/test/worktree-reuse",
    });

    const worktreeAddCall = mockSimpleGit.raw.mock.calls.find(
      (call) => call[0][0] === "worktree" && call[0][1] === "add"
    );
    expect(worktreeAddCall).toBeDefined();
    // No -b — reuse path, like the explicit useExistingBranch caller.
    expect(worktreeAddCall![0]).toEqual([
      "worktree",
      "add",
      "/test/worktree-reuse",
      "bugfix/issue-6463",
    ]);

    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "create-worktree-result",
        requestId: "req-stale-reuse",
        success: true,
      })
    );
  });

  it("suffixes branch name when it exists locally and is already checked out in another worktree", async () => {
    // #6463: branch is live in another worktree → cannot reuse, must
    // generate a unique suffix and create with -b.
    mockSimpleGit.branchLocal.mockResolvedValueOnce({
      all: ["main", "feature/foo"],
      current: "main",
      branches: {},
      detached: false,
    });
    mockSimpleGit.raw.mockImplementationOnce((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return Promise.resolve(
          [
            "worktree /test/root",
            "HEAD abc123",
            "branch refs/heads/main",
            "",
            "worktree /test/foo-existing",
            "HEAD def456",
            "branch refs/heads/feature/foo",
            "",
          ].join("\n")
        );
      }
      return Promise.resolve(undefined);
    });

    await service.createWorktree("req-checked-out", "/test/root", {
      baseBranch: "main",
      newBranch: "feature/foo",
      path: "/test/worktree-foo",
    });

    const worktreeAddCall = mockSimpleGit.raw.mock.calls.find(
      (call) => call[0][0] === "worktree" && call[0][1] === "add"
    );
    expect(worktreeAddCall).toBeDefined();
    expect(worktreeAddCall![0]).toEqual([
      "worktree",
      "add",
      "-b",
      "feature/foo-2",
      "--no-track",
      "/test/worktree-foo",
      "main",
    ]);

    // Emitted worktree carries the suffixed branch name, not the original.
    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "worktree-update",
        worktree: expect.objectContaining({ branch: "feature/foo-2" }),
      })
    );
  });

  it("picks the next free suffix past existing -2/-3 collisions", async () => {
    mockSimpleGit.branchLocal.mockResolvedValueOnce({
      all: ["main", "feature/foo", "feature/foo-2", "feature/foo-3"],
      current: "main",
      branches: {},
      detached: false,
    });
    mockSimpleGit.raw.mockImplementationOnce((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        // feature/foo is live; feature/foo-2 and feature/foo-3 are stale
        // local branches but the requested name is feature/foo (live), so
        // we must suffix past every existing local name.
        return Promise.resolve(
          [
            "worktree /test/root",
            "HEAD abc",
            "branch refs/heads/main",
            "",
            "worktree /test/foo-live",
            "HEAD def",
            "branch refs/heads/feature/foo",
            "",
          ].join("\n")
        );
      }
      return Promise.resolve(undefined);
    });

    await service.createWorktree("req-suffix-skip", "/test/root", {
      baseBranch: "main",
      newBranch: "feature/foo",
      path: "/test/worktree-foo-new",
    });

    const worktreeAddCall = mockSimpleGit.raw.mock.calls.find(
      (call) => call[0][0] === "worktree" && call[0][1] === "add"
    );
    expect(worktreeAddCall![0]).toEqual([
      "worktree",
      "add",
      "-b",
      "feature/foo-4",
      "--no-track",
      "/test/worktree-foo-new",
      "main",
    ]);
  });

  it("falls through to the suffix path when the worktree-list probe fails", async () => {
    // #6463 critical edge case: the porcelain probe must NOT mask "branch is
    // live elsewhere" as "stale and reusable". When git rejects the probe
    // (e.g., .git lock contention under bulk creation), the safer move is to
    // suffix the branch and create fresh, not reuse a possibly-live ref.
    mockSimpleGit.branchLocal.mockResolvedValueOnce({
      all: ["main", "feature/foo"],
      current: "main",
      branches: {},
      detached: false,
    });
    mockSimpleGit.raw.mockImplementationOnce((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return Promise.reject(new Error("fatal: unable to read .git/index"));
      }
      return Promise.resolve(undefined);
    });

    await service.createWorktree("req-list-failed", "/test/root", {
      baseBranch: "main",
      newBranch: "feature/foo",
      path: "/test/worktree-foo-fail",
    });

    const worktreeAddCall = mockSimpleGit.raw.mock.calls.find(
      (call) => call[0][0] === "worktree" && call[0][1] === "add"
    );
    expect(worktreeAddCall![0]).toEqual([
      "worktree",
      "add",
      "-b",
      "feature/foo-2",
      "--no-track",
      "/test/worktree-foo-fail",
      "main",
    ]);
  });

  it("suffixes (not reuses) when fromRemote=true and the local branch already exists", async () => {
    // PR-mode creates need --track to give @{u} for ahead/behind badges
    // (WorktreeMonitor.ts:1092). Reusing a stale local branch would drop the
    // tracking ref AND pin the worktree to whatever commit the stale branch
    // was at, instead of origin's current tip. Always suffix in PR mode.
    mockSimpleGit.branchLocal.mockResolvedValueOnce({
      all: ["main", "pr-9999-feature"],
      current: "main",
      branches: {},
      detached: false,
    });
    mockSimpleGit.raw.mockImplementationOnce((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        // pr-9999-feature is NOT checked out — would normally trigger reuse,
        // but fromRemote suppresses that.
        return Promise.resolve(
          ["worktree /test/root", "HEAD abc", "branch refs/heads/main", ""].join("\n")
        );
      }
      return Promise.resolve(undefined);
    });

    await service.createWorktree("req-fromremote-stale", "/test/root", {
      baseBranch: "origin/pr-9999-feature",
      newBranch: "pr-9999-feature",
      path: "/test/worktree-pr",
      fromRemote: true,
    });

    const worktreeAddCall = mockSimpleGit.raw.mock.calls.find(
      (call) => call[0][0] === "worktree" && call[0][1] === "add"
    );
    expect(worktreeAddCall![0]).toEqual([
      "worktree",
      "add",
      "-b",
      "pr-9999-feature-2",
      "--track",
      "/test/worktree-pr",
      "origin/pr-9999-feature",
    ]);
  });

  it("picks the next free suffix past non-contiguous existing names", async () => {
    // nextAvailableBranchName scans for the maximum existing -N suffix; gaps
    // (e.g., -2 deleted but -10 kept) must not regress to a colliding name.
    mockSimpleGit.branchLocal.mockResolvedValueOnce({
      all: ["main", "feature/foo", "feature/foo-10"],
      current: "main",
      branches: {},
      detached: false,
    });
    mockSimpleGit.raw.mockImplementationOnce((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return Promise.resolve(
          [
            "worktree /test/root",
            "HEAD abc",
            "branch refs/heads/main",
            "",
            "worktree /test/foo-live",
            "HEAD def",
            "branch refs/heads/feature/foo",
            "",
          ].join("\n")
        );
      }
      return Promise.resolve(undefined);
    });

    await service.createWorktree("req-suffix-gap", "/test/root", {
      baseBranch: "main",
      newBranch: "feature/foo",
      path: "/test/worktree-foo-gap",
    });

    const worktreeAddCall = mockSimpleGit.raw.mock.calls.find(
      (call) => call[0][0] === "worktree" && call[0][1] === "add"
    );
    expect(worktreeAddCall![0][3]).toBe("feature/foo-11");
  });

  it("escapes regex metacharacters in branch names when computing suffixes", async () => {
    // Branch names like `bugfix/[6463]` contain regex metacharacters; without
    // escaping, the suffix scan would miss `bugfix/[6463]-2` and reissue it.
    mockSimpleGit.branchLocal.mockResolvedValueOnce({
      all: ["main", "bugfix/[6463]", "bugfix/[6463]-2"],
      current: "main",
      branches: {},
      detached: false,
    });
    mockSimpleGit.raw.mockImplementationOnce((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return Promise.resolve(
          [
            "worktree /test/root",
            "HEAD abc",
            "branch refs/heads/main",
            "",
            "worktree /test/live",
            "HEAD def",
            "branch refs/heads/bugfix/[6463]",
            "",
          ].join("\n")
        );
      }
      return Promise.resolve(undefined);
    });

    await service.createWorktree("req-regex-escape", "/test/root", {
      baseBranch: "main",
      newBranch: "bugfix/[6463]",
      path: "/test/worktree-regex",
    });

    const worktreeAddCall = mockSimpleGit.raw.mock.calls.find(
      (call) => call[0][0] === "worktree" && call[0][1] === "add"
    );
    expect(worktreeAddCall![0][3]).toBe("bugfix/[6463]-3");
  });

  it("proceeds with the original -b path when the branch does not exist locally", async () => {
    // Baseline: the guard is a no-op when there's no collision. Argv must
    // match the pre-fix shape exactly so the issue-mode --no-track contract
    // is preserved.
    mockSimpleGit.branchLocal.mockResolvedValueOnce({
      all: ["main", "develop"],
      current: "main",
      branches: {},
      detached: false,
    });

    await service.createWorktree("req-no-collision", "/test/root", {
      baseBranch: "main",
      newBranch: "feature/brand-new",
      path: "/test/worktree-new",
    });

    expect(mockSimpleGit.raw).toHaveBeenCalledWith([
      "worktree",
      "add",
      "-b",
      "feature/brand-new",
      "--no-track",
      "/test/worktree-new",
      "main",
    ]);
    // Never queried the worktree list — short-circuit when branch is free.
    const listCall = mockSimpleGit.raw.mock.calls.find(
      (call) => call[0][0] === "worktree" && call[0][1] === "list"
    );
    expect(listCall).toBeUndefined();
  });

  it("skips the pre-flight guard entirely when useExistingBranch is true", async () => {
    // The caller is asking for explicit reuse; the guard's job is done by
    // intent, not detection. Confirms we don't add a redundant branchLocal
    // round-trip on the explicit-reuse path.
    await service.createWorktree("req-explicit-reuse", "/test/root", {
      baseBranch: "main",
      newBranch: "existing-branch",
      path: "/test/worktree-explicit",
      useExistingBranch: true,
    });

    expect(mockSimpleGit.branchLocal).not.toHaveBeenCalled();
    expect(mockSimpleGit.raw).toHaveBeenCalledWith([
      "worktree",
      "add",
      "/test/worktree-explicit",
      "existing-branch",
    ]);
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
