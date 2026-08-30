import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import path from "path";
import type { WorkspaceService } from "../WorkspaceService.js";

const mockSimpleGit = {
  raw: vi.fn().mockResolvedValue(undefined),
  checkIsRepo: vi.fn().mockResolvedValue(true),
  branch: vi.fn().mockResolvedValue({ current: "main" }),
  branchLocal: vi.fn().mockResolvedValue({ all: [], current: "", branches: {}, detached: false }),
  // The tracking decision needs the real remote names to know where
  // `origin/main` splits; a repo with one remote is the ordinary case.
  getRemotes: vi.fn().mockResolvedValue([{ name: "origin", refs: { fetch: "url", push: "url" } }]),
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
  validateBranchName: vi.fn(),
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
  getGitCommonDir: vi.fn().mockReturnValue(null),
  clearGitDirCache: vi.fn(),
  clearGitCommonDirCache: vi.fn(),
}));

vi.mock("../../services/worktree/mood.js", () => ({
  categorizeWorktree: vi.fn().mockReturnValue("stable"),
}));

vi.mock("../../services/issueExtractor.js", () => ({
  extractIssueNumberSync: vi.fn().mockReturnValue(null),
  extractIssueNumber: vi.fn().mockResolvedValue(null),
  deriveIssueTitleFromBranch: vi.fn().mockReturnValue(undefined),
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
        return Promise.resolve(false);
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
  // Identity by default: no symlinks in unit tests. The containment check
  // (assertWorktreePathContained) realpaths the repo parent and the target's
  // nearest existing ancestor; identity keeps resolved paths unchanged.
  realpath: vi.fn().mockImplementation((p: string) => Promise.resolve(p)),
}));

// Default to "exists" so pre-existing tests don't exercise the parent mkdir
// path unless they opt in by toggling the mock.
vi.mock("fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
}));

function flushAsyncTail(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Collision plumbing for the optimistic-add order: the first `worktree add -b
 * <branch>` rejects with git's stale-branch error (what a real repo produces),
 * `worktree list --porcelain` returns the given output (or rejects), and every
 * other git call resolves. Recovery behavior itself is asserted per test.
 */
function mockCollidingAdd(
  raw: ReturnType<typeof vi.fn>,
  branch: string,
  porcelain: string[] | Error
): void {
  raw.mockImplementation((args: string[]) => {
    if (args[0] === "worktree" && args[1] === "add" && args[2] === "-b" && args[3] === branch) {
      return Promise.reject(new Error(`fatal: a branch named '${branch}' already exists`));
    }
    if (args[0] === "worktree" && args[1] === "list") {
      return porcelain instanceof Error
        ? Promise.reject(porcelain)
        : Promise.resolve(porcelain.join("\n"));
    }
    return Promise.resolve(undefined);
  });
}

/** The last `worktree add` argv issued — recovery retries follow the failed optimistic add. */
function lastWorktreeAddCall(raw: ReturnType<typeof vi.fn>): string[] | undefined {
  const calls = raw.mock.calls.filter((call) => call[0][0] === "worktree" && call[0][1] === "add");
  return calls.at(-1)?.[0];
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
    mockSimpleGit.checkIsRepo.mockResolvedValue(true);
    mockSimpleGit.branch.mockResolvedValue({ current: "main" });
    mockSimpleGit.branchLocal.mockResolvedValue({
      all: [],
      current: "",
      branches: {},
      detached: false,
    });

    const fsModule = await import("../../utils/fs.js");
    waitForPathExists = vi.mocked(fsModule.waitForPathExists);

    // Re-anchor realpath to identity each test so a per-test symlink override
    // (the containment-escape cases below) can't leak into later tests.
    const fsPromisesModule = await import("fs/promises");
    vi.mocked(fsPromisesModule.realpath).mockImplementation((p: any) => Promise.resolve(p));

    mockSendEvent = vi.fn();

    const WorkspaceServiceModule = await import("../WorkspaceService.js");
    service = new WorkspaceServiceModule.WorkspaceService(mockSendEvent);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes --no-track on issue-mode git add and emits success with the direct-built worktree id", async () => {
    const requestId = "test-request-123";
    const expectedWorktreePath = path.resolve("/test/worktree");
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
      "--end-of-options",
      "/test/worktree",
      "main",
    ]);

    expect(waitForPathExists).toHaveBeenCalledWith(expectedWorktreePath, {
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
        worktreeId: expectedWorktreePath,
      })
    );

    // Opt 3: the O(N²) `git worktree list --porcelain` call on the success
    // path is gone — the Worktree object is built directly from inputs.
    await flushAsyncTail();
    expect(listSpy).not.toHaveBeenCalled();
  });

  it("uses the real path as the created worktree id", async () => {
    const fsPromisesModule = await import("fs/promises");
    const requestId = "test-request-realpath";
    const rootPath = path.resolve("/test/repo");
    const requestedPath = path.resolve("/test/worktree");
    const expectedRealPath = path.resolve("/test/canonical-worktree");

    vi.mocked(fsPromisesModule.realpath).mockImplementation((p: any) =>
      Promise.resolve(String(p) === requestedPath ? expectedRealPath : String(p))
    );

    await service.createWorktree(requestId, rootPath, {
      baseBranch: "main",
      newBranch: "feature/realpath",
      path: requestedPath,
    });

    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "create-worktree-result",
        requestId,
        success: true,
        worktreeId: expectedRealPath,
      })
    );
    expect(service["monitors"].has(expectedRealPath)).toBe(true);
    expect(service["monitors"].has(requestedPath)).toBe(false);
  });

  it("coalesces concurrent duplicate create requests while the first git add is in flight", async () => {
    const expectedWorktreePath = path.resolve("/test/worktree-duplicate");
    const options = {
      baseBranch: "main",
      newBranch: "feature/duplicate",
      path: "/test/worktree-duplicate",
    };

    let resolveAdd!: () => void;
    let markAddStarted!: () => void;
    const addStarted = new Promise<void>((resolve) => {
      markAddStarted = resolve;
    });
    const addFinished = new Promise<void>((resolve) => {
      resolveAdd = resolve;
    });

    mockSimpleGit.raw.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "add") {
        markAddStarted();
        return addFinished;
      }
      return Promise.resolve(undefined);
    });

    const firstCreate = service.createWorktree("req-duplicate-a", "/test/root", options);
    await addStarted;

    const secondCreate = service.createWorktree("req-duplicate-b", "/test/root", options);
    await flushAsyncTail();

    const addCallsBeforeRelease = mockSimpleGit.raw.mock.calls.filter(
      (call) => call[0][0] === "worktree" && call[0][1] === "add"
    );
    expect(addCallsBeforeRelease).toHaveLength(1);

    resolveAdd();
    await Promise.all([firstCreate, secondCreate]);

    const addCalls = mockSimpleGit.raw.mock.calls.filter(
      (call) => call[0][0] === "worktree" && call[0][1] === "add"
    );
    expect(addCalls).toHaveLength(1);

    const createResultCalls = mockSendEvent.mock.calls.filter(
      ([event]: [{ type: string }]) => event.type === "create-worktree-result"
    );
    const createResultEvents = createResultCalls.map(
      ([event]: [{ type: string; requestId?: string; success?: boolean; worktreeId?: string }]) =>
        event
    );

    expect(createResultEvents).toHaveLength(2);
    expect(createResultEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestId: "req-duplicate-a",
          success: true,
          worktreeId: expectedWorktreePath,
        }),
        expect.objectContaining({
          requestId: "req-duplicate-b",
          success: true,
          worktreeId: expectedWorktreePath,
        }),
      ])
    );
    expect(service["monitors"].has(expectedWorktreePath)).toBe(true);
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
      "--end-of-options",
      "/test/worktree2",
      "existing-branch",
    ]);
    expect(waitForPathExists).toHaveBeenCalledWith(
      path.resolve("/test/worktree2"),
      expect.objectContaining({ timeoutMs: 500 })
    );
  });

  it("tracks a remote base only when the new branch is its counterpart", async () => {
    // `-b feature/remote --track origin/main` would write
    // `branch.feature/remote.merge = refs/heads/main`, pointing a brand new
    // topic branch at the BASE. Everything downstream then reads that as the
    // branch's own remote counterpart.
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
      "--no-track",
      "--end-of-options",
      "/test/worktree3",
      "origin/main",
    ]);
    expect(waitForPathExists).toHaveBeenCalledWith(
      path.resolve("/test/worktree3"),
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
    expect(service["monitors"].has(path.resolve("/test/worktree-fail"))).toBe(false);
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
    expect(service["monitors"].has(path.resolve("/test/worktree-sync"))).toBe(true);
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
    // The optimistic `-b` add fails with git's stale-branch error; the
    // worktree list shows only main checked out, so the stale
    // bugfix/issue-6463 branch has no live worktree.
    mockCollidingAdd(mockSimpleGit.raw, "bugfix/issue-6463", [
      "worktree /test/root",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
    ]);

    await service.createWorktree("req-stale-reuse", "/test/root", {
      baseBranch: "main",
      newBranch: "bugfix/issue-6463",
      path: "/test/worktree-reuse",
    });

    // Recovery is failure-driven: the FIRST add must be the optimistic -b
    // attempt (a reintroduced pre-flight would issue the reuse form first).
    const addCalls = mockSimpleGit.raw.mock.calls.filter(
      (call) => call[0][0] === "worktree" && call[0][1] === "add"
    );
    expect(addCalls[0]![0]).toEqual([
      "worktree",
      "add",
      "-b",
      "bugfix/issue-6463",
      "--no-track",
      "--end-of-options",
      "/test/worktree-reuse",
      "main",
    ]);
    // No -b — reuse path, like the explicit useExistingBranch caller.
    expect(lastWorktreeAddCall(mockSimpleGit.raw)).toEqual([
      "worktree",
      "add",
      "--end-of-options",
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
    mockCollidingAdd(mockSimpleGit.raw, "feature/foo", [
      "worktree /test/root",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /test/foo-existing",
      "HEAD def456",
      "branch refs/heads/feature/foo",
      "",
    ]);

    await service.createWorktree("req-checked-out", "/test/root", {
      baseBranch: "main",
      newBranch: "feature/foo",
      path: "/test/worktree-foo",
    });

    expect(lastWorktreeAddCall(mockSimpleGit.raw)).toEqual([
      "worktree",
      "add",
      "-b",
      "feature/foo-2",
      "--no-track",
      "--end-of-options",
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
    // feature/foo is live; feature/foo-2 and feature/foo-3 are stale local
    // branches but the requested name is feature/foo (live), so we must
    // suffix past every existing local name.
    mockCollidingAdd(mockSimpleGit.raw, "feature/foo", [
      "worktree /test/root",
      "HEAD abc",
      "branch refs/heads/main",
      "",
      "worktree /test/foo-live",
      "HEAD def",
      "branch refs/heads/feature/foo",
      "",
    ]);

    await service.createWorktree("req-suffix-skip", "/test/root", {
      baseBranch: "main",
      newBranch: "feature/foo",
      path: "/test/worktree-foo-new",
    });

    expect(lastWorktreeAddCall(mockSimpleGit.raw)).toEqual([
      "worktree",
      "add",
      "-b",
      "feature/foo-4",
      "--no-track",
      "--end-of-options",
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
    mockCollidingAdd(
      mockSimpleGit.raw,
      "feature/foo",
      new Error("fatal: unable to read .git/index")
    );

    await service.createWorktree("req-list-failed", "/test/root", {
      baseBranch: "main",
      newBranch: "feature/foo",
      path: "/test/worktree-foo-fail",
    });

    expect(lastWorktreeAddCall(mockSimpleGit.raw)).toEqual([
      "worktree",
      "add",
      "-b",
      "feature/foo-2",
      "--no-track",
      "--end-of-options",
      "/test/worktree-foo-fail",
      "main",
    ]);
  });

  it("keeps --track when the new branch IS the remote base's counterpart", async () => {
    // The PR-mode shape, and the only one where tracking states a truth:
    // `topic` tracking `origin/topic` is what ahead/behind counts are for.
    await service.createWorktree("req-track-counterpart", "/test/root", {
      baseBranch: "origin/feature/login",
      newBranch: "feature/login",
      path: "/test/worktree-track",
      fromRemote: true,
    });

    expect(lastWorktreeAddCall(mockSimpleGit.raw)).toEqual([
      "worktree",
      "add",
      "-b",
      "feature/login",
      "--track",
      "--end-of-options",
      "/test/worktree-track",
      "origin/feature/login",
    ]);
  });

  it("splits the base at a slash-bearing remote's real boundary", async () => {
    // `team/fork/topic` is `topic` on the remote `team/fork`. Splitting at the
    // first slash would read it as `fork/topic` and refuse to track a branch
    // that genuinely is its counterpart.
    mockSimpleGit.getRemotes.mockResolvedValueOnce([
      { name: "team/fork", refs: { fetch: "url", push: "url" } },
    ]);

    await service.createWorktree("req-slash-remote", "/test/root", {
      baseBranch: "team/fork/topic",
      newBranch: "topic",
      path: "/test/worktree-slash",
      fromRemote: true,
    });

    expect(lastWorktreeAddCall(mockSimpleGit.raw)![4]).toBe("--track");
  });

  it("does not track a local base branch even when fromRemote is set", async () => {
    // `fromRemote` is the caller's claim, not a fact. A base that no remote
    // prefixes is a local ref, and `--track` against a local ref is exactly
    // what `--no-track` exists to prevent under branch.autoSetupMerge=always.
    await service.createWorktree("req-local-base-fromremote", "/test/root", {
      baseBranch: "main",
      newBranch: "topic",
      path: "/test/worktree-localbase",
      fromRemote: true,
    });

    expect(lastWorktreeAddCall(mockSimpleGit.raw)![4]).toBe("--no-track");
  });

  it("does not track when the repository has no remotes at all", async () => {
    // With no remote table, `origin/topic` cannot be a remote ref — so the
    // base is a local branch literally named `origin/topic`.
    mockSimpleGit.getRemotes.mockResolvedValueOnce([]);

    await service.createWorktree("req-no-remotes", "/test/root", {
      baseBranch: "origin/topic",
      newBranch: "topic",
      path: "/test/worktree-noremotes-repo",
      fromRemote: true,
    });

    expect(lastWorktreeAddCall(mockSimpleGit.raw)![4]).toBe("--no-track");
  });

  it("degrades to --no-track when the remote table cannot be read", async () => {
    // Without remote names the ref cannot be split at a boundary git agrees
    // with, so the counterpart question has no answer. Not tracking is the
    // recoverable direction — `git push -u` sets the right upstream later,
    // whereas a wrong one has to be noticed first.
    mockSimpleGit.getRemotes.mockRejectedValueOnce(new Error("git remote failed"));

    await service.createWorktree("req-remotes-unreadable", "/test/root", {
      baseBranch: "origin/feature/login",
      newBranch: "feature/login",
      path: "/test/worktree-noremotes",
      fromRemote: true,
    });

    expect(lastWorktreeAddCall(mockSimpleGit.raw)![4]).toBe("--no-track");
  });

  it("suffixes (not reuses) when fromRemote=true and the local branch already exists", async () => {
    // Reusing a stale local branch would pin the worktree to whatever commit
    // that branch was left at instead of origin's current tip, so PR mode
    // always suffixes. The suffixed name is not `origin/pr-9999-feature`'s
    // counterpart, so the retry drops to --no-track (asserted below).
    mockSimpleGit.branchLocal.mockResolvedValueOnce({
      all: ["main", "pr-9999-feature"],
      current: "main",
      branches: {},
      detached: false,
    });
    // pr-9999-feature is NOT checked out — would normally trigger reuse,
    // but fromRemote suppresses that.
    mockCollidingAdd(mockSimpleGit.raw, "pr-9999-feature", [
      "worktree /test/root",
      "HEAD abc",
      "branch refs/heads/main",
      "",
    ]);

    await service.createWorktree("req-fromremote-stale", "/test/root", {
      baseBranch: "origin/pr-9999-feature",
      newBranch: "pr-9999-feature",
      path: "/test/worktree-pr",
      fromRemote: true,
    });

    // Failure-driven: the optimistic add for the original name runs first and
    // tracks, because `pr-9999-feature` IS `origin/pr-9999-feature`'s local
    // counterpart. The suffixed retry is not — `pr-9999-feature-2` tracking
    // `origin/pr-9999-feature` is the same mis-tracking by another route — so
    // the decision is recomputed against the name actually being created.
    const addCalls = mockSimpleGit.raw.mock.calls.filter(
      (call) => call[0][0] === "worktree" && call[0][1] === "add"
    );
    expect(addCalls[0]![0][3]).toBe("pr-9999-feature");
    expect(addCalls[0]![0][4]).toBe("--track");
    expect(lastWorktreeAddCall(mockSimpleGit.raw)).toEqual([
      "worktree",
      "add",
      "-b",
      "pr-9999-feature-2",
      "--no-track",
      "--end-of-options",
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
    mockCollidingAdd(mockSimpleGit.raw, "feature/foo", [
      "worktree /test/root",
      "HEAD abc",
      "branch refs/heads/main",
      "",
      "worktree /test/foo-live",
      "HEAD def",
      "branch refs/heads/feature/foo",
      "",
    ]);

    await service.createWorktree("req-suffix-gap", "/test/root", {
      baseBranch: "main",
      newBranch: "feature/foo",
      path: "/test/worktree-foo-gap",
    });

    expect(lastWorktreeAddCall(mockSimpleGit.raw)![3]).toBe("feature/foo-11");
  });

  it("escapes regex metacharacters in branch names when computing suffixes", async () => {
    // Branch names like `bugfix/foo(6463)` contain regex metacharacters; without
    // escaping, the suffix scan would miss `bugfix/foo(6463)-2` and reissue it.
    // Parens are valid per git check-ref-format; pre-#7033 the test used `[…]`
    // but `[` is forbidden by check-ref-format and now rejected at the gate.
    mockSimpleGit.branchLocal.mockResolvedValueOnce({
      all: ["main", "bugfix/foo(6463)", "bugfix/foo(6463)-2"],
      current: "main",
      branches: {},
      detached: false,
    });
    mockCollidingAdd(mockSimpleGit.raw, "bugfix/foo(6463)", [
      "worktree /test/root",
      "HEAD abc",
      "branch refs/heads/main",
      "",
      "worktree /test/live",
      "HEAD def",
      "branch refs/heads/bugfix/foo(6463)",
      "",
    ]);

    await service.createWorktree("req-regex-escape", "/test/root", {
      baseBranch: "main",
      newBranch: "bugfix/foo(6463)",
      path: "/test/worktree-regex",
    });

    expect(lastWorktreeAddCall(mockSimpleGit.raw)![3]).toBe("bugfix/foo(6463)-3");
  });

  it("proceeds with the original -b path and zero probe spawns when the branch does not exist locally", async () => {
    // Baseline: recovery is failure-driven, so a collision-free create issues
    // exactly one git call — the add itself. Argv must match the issue-mode
    // --no-track contract exactly.
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
      "--end-of-options",
      "/test/worktree-new",
      "main",
    ]);
    // No pre-flight branch listing and no worktree-list probe on the happy
    // path — the old order charged every create a branchLocal spawn.
    expect(mockSimpleGit.branchLocal).not.toHaveBeenCalled();
    const listCall = mockSimpleGit.raw.mock.calls.find(
      (call) => call[0][0] === "worktree" && call[0][1] === "list"
    );
    expect(listCall).toBeUndefined();
  });

  it("surfaces the original add error when branch listing fails during recovery", async () => {
    mockSimpleGit.raw.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "add") {
        return Promise.reject(new Error("fatal: a branch named 'feature/foo' already exists"));
      }
      return Promise.resolve(undefined);
    });
    mockSimpleGit.branchLocal.mockRejectedValueOnce(new Error("fatal: bad repo"));

    await service.createWorktree("req-recovery-blind", "/test/root", {
      baseBranch: "main",
      newBranch: "feature/foo",
      path: "/test/worktree-foo-blind",
    });

    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "create-worktree-result",
        requestId: "req-recovery-blind",
        success: false,
        error: "fatal: a branch named 'feature/foo' already exists",
      })
    );
    // Only the single failed add — no reuse/suffix retries were attempted.
    const addCalls = mockSimpleGit.raw.mock.calls.filter(
      (call) => call[0][0] === "worktree" && call[0][1] === "add"
    );
    expect(addCalls).toHaveLength(1);
  });

  it("does not run branch-collision recovery for non-collision add failures", async () => {
    // `worktree add` reports an existing target *path* with a similar
    // "already exists" phrase; that must surface as-is, not trigger the
    // stale-branch recovery.
    mockSimpleGit.raw.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "add") {
        return Promise.reject(new Error("fatal: '/test/worktree-dup' already exists"));
      }
      return Promise.resolve(undefined);
    });

    await service.createWorktree("req-path-exists", "/test/root", {
      baseBranch: "main",
      newBranch: "feature/foo",
      path: "/test/worktree-dup",
    });

    expect(mockSimpleGit.branchLocal).not.toHaveBeenCalled();
    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "create-worktree-result",
        requestId: "req-path-exists",
        success: false,
        error: "fatal: '/test/worktree-dup' already exists",
      })
    );
  });

  it("runs concurrent distinct creates on the same root strictly one at a time", async () => {
    // The per-root create queue is what lets the IPC rate limit grant a burst
    // allowance: git adds must never overlap on one repo (#5098), enforced
    // structurally here rather than by wall-clock pacing.
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    mockSimpleGit.raw.mockImplementation(async (args: string[]) => {
      if (args[0] === "worktree" && args[1] === "add") {
        order.push(`add:${args[3]}`);
        if (args[3] === "serial-a") await firstGate;
      }
      return undefined;
    });

    const first = service.createWorktree("req-serial-1", "/test/root", {
      baseBranch: "main",
      newBranch: "serial-a",
      path: "/test/worktree-serial-a",
    });
    const second = service.createWorktree("req-serial-2", "/test/root", {
      baseBranch: "main",
      newBranch: "serial-b",
      path: "/test/worktree-serial-b",
    });

    for (let i = 0; i < 25 && order.length === 0; i++) {
      await flushAsyncTail();
    }
    // First add is in flight (gated); the second create must not have
    // started its git work.
    expect(order).toEqual(["add:serial-a"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["add:serial-a", "add:serial-b"]);

    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "create-worktree-result",
        requestId: "req-serial-1",
        success: true,
      })
    );
    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "create-worktree-result",
        requestId: "req-serial-2",
        success: true,
      })
    );
  });

  it("keeps serving creates after a failed create earlier in the queue", async () => {
    mockSimpleGit.raw.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "add" && args[3] === "fail-first") {
        return Promise.reject(new Error("fatal: could not create work tree dir"));
      }
      return Promise.resolve(undefined);
    });

    await service.createWorktree("req-fail-first", "/test/root", {
      baseBranch: "main",
      newBranch: "fail-first",
      path: "/test/worktree-fail-first",
    });
    await service.createWorktree("req-after-fail", "/test/root", {
      baseBranch: "main",
      newBranch: "after-fail",
      path: "/test/worktree-after-fail",
    });

    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "create-worktree-result",
        requestId: "req-fail-first",
        success: false,
      })
    );
    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "create-worktree-result",
        requestId: "req-after-fail",
        success: true,
      })
    );
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
      "--end-of-options",
      "/test/worktree-explicit",
      "existing-branch",
    ]);
  });

  it("rejects empty newBranch before invoking git (#7033)", async () => {
    await service.createWorktree("req-empty", "/test/root", {
      baseBranch: "main",
      newBranch: "",
      path: "/test/worktree-empty",
    });

    expect(mockSimpleGit.raw).not.toHaveBeenCalled();
    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "create-worktree-result",
        requestId: "req-empty",
        success: false,
        error: expect.stringMatching(/empty/i),
      })
    );
  });

  it("rejects whitespace-only newBranch before invoking git (#7033)", async () => {
    await service.createWorktree("req-blank", "/test/root", {
      baseBranch: "main",
      newBranch: "   ",
      path: "/test/worktree-blank",
    });

    expect(mockSimpleGit.raw).not.toHaveBeenCalled();
    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "create-worktree-result",
        requestId: "req-blank",
        success: false,
      })
    );
  });

  it("rejects git-invalid branch names before invoking git (#7033)", async () => {
    await service.createWorktree("req-head", "/test/root", {
      baseBranch: "main",
      newBranch: "HEAD",
      path: "/test/worktree-head",
    });

    expect(mockSimpleGit.raw).not.toHaveBeenCalled();
    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "create-worktree-result",
        requestId: "req-head",
        success: false,
        error: expect.stringContaining("HEAD"),
      })
    );
  });

  it("rejects Windows-reserved branch names before invoking git (#7033)", async () => {
    await service.createWorktree("req-nul", "/test/root", {
      baseBranch: "main",
      newBranch: "feature/NUL",
      path: "/test/worktree-nul",
    });

    expect(mockSimpleGit.raw).not.toHaveBeenCalled();
    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "create-worktree-result",
        requestId: "req-nul",
        success: false,
        error: expect.stringMatching(/Windows-reserved/),
      })
    );
  });

  it("creates the parent directory when it does not exist", async () => {
    // Nested under the repo's parent boundary (/test) so the containment gate
    // passes; the parent (/test/sub) is the not-yet-existing dir under test.
    const expectedWorktreePath = path.resolve("/test/sub/worktree");
    const fsModule = await import("fs");
    const fsPromisesModule = await import("fs/promises");
    vi.mocked(fsModule.existsSync).mockReturnValueOnce(false);

    await service.createWorktree("req-no-parent", "/test/root", {
      baseBranch: "main",
      newBranch: "feature/foo",
      path: "/test/sub/worktree",
    });

    expect(fsPromisesModule.mkdir).toHaveBeenCalledWith(path.dirname(expectedWorktreePath), {
      recursive: true,
    });
    expect(mockSimpleGit.raw).toHaveBeenCalledWith([
      "worktree",
      "add",
      "-b",
      "feature/foo",
      "--no-track",
      "--end-of-options",
      "/test/sub/worktree",
      "main",
    ]);
    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "create-worktree-result",
        requestId: "req-no-parent",
        success: true,
        worktreeId: expectedWorktreePath,
      })
    );
  });

  it("validates branch name even when useExistingBranch is true (#7033)", async () => {
    // The pre-flight gate must run unconditionally; useExistingBranch is just
    // the create-strategy switch. A reuse caller passing 'HEAD' must still be
    // rejected before reaching git.
    await service.createWorktree("req-existing-head", "/test/root", {
      baseBranch: "main",
      newBranch: "HEAD",
      path: "/test/worktree-existing-head",
      useExistingBranch: true,
    });

    expect(mockSimpleGit.raw).not.toHaveBeenCalled();
    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "create-worktree-result",
        requestId: "req-existing-head",
        success: false,
        error: expect.stringContaining("HEAD"),
      })
    );
  });

  it("creates the rootPath-resolved parent directory for a relative path", async () => {
    // Programmatic callers (MCP, recipes) may pass a relative `path`. The
    // mkdir target must be the rootPath-resolved parent, not process.cwd.
    // The source uses `path.resolve(rootPath, relPath)`, which on Windows
    // turns "/test/root" into a drive-rooted absolute path; build the
    // expected parent the same way so the assertion stays cross-platform.
    const expectedParent = path.resolve("/test/root", "worktrees");
    const fsModule = await import("fs");
    const fsPromisesModule = await import("fs/promises");
    const existsSyncMock = vi.mocked(fsModule.existsSync);
    existsSyncMock.mockImplementationOnce((p: unknown) => {
      // Only return false for the expected resolved parent; other lookups
      // (none in this test, but defensive) default to true.
      return p !== expectedParent;
    });

    await service.createWorktree("req-relative-path", "/test/root", {
      baseBranch: "main",
      newBranch: "feature/foo",
      path: "worktrees/feat",
    });

    expect(existsSyncMock).toHaveBeenCalledWith(expectedParent);
    expect(fsPromisesModule.mkdir).toHaveBeenCalledWith(expectedParent, { recursive: true });
    expect(mockSimpleGit.raw).toHaveBeenCalledWith([
      "worktree",
      "add",
      "-b",
      "feature/foo",
      "--no-track",
      "--end-of-options",
      "worktrees/feat",
      "main",
    ]);
    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "create-worktree-result",
        requestId: "req-relative-path",
        success: true,
        worktreeId: path.resolve("/test/root", "worktrees/feat"),
      })
    );
  });

  it("normalizes absolute create paths before registering the new monitor", async () => {
    const basePath = path.resolve("/test/root");
    const rawPath = `${basePath}${path.sep}..${path.sep}worktree-normalized`;
    const expectedPath = path.resolve(basePath, "..", "worktree-normalized");

    await service.createWorktree("req-normalized-absolute", "/test/root", {
      baseBranch: "main",
      newBranch: "feature/normalized",
      path: rawPath,
    });

    expect(mockSimpleGit.raw).toHaveBeenCalledWith([
      "worktree",
      "add",
      "-b",
      "feature/normalized",
      "--no-track",
      "--end-of-options",
      rawPath,
      "main",
    ]);
    expect(waitForPathExists).toHaveBeenCalledWith(
      expectedPath,
      expect.objectContaining({ timeoutMs: 500 })
    );
    expect(service["monitors"].has(expectedPath)).toBe(true);
    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "create-worktree-result",
        requestId: "req-normalized-absolute",
        success: true,
        worktreeId: expectedPath,
      })
    );
  });

  it("rejects an absolute path outside the repository's parent directory (#9154)", async () => {
    await service.createWorktree("req-escape-abs", "/test/root", {
      baseBranch: "main",
      newBranch: "feature/escape",
      path: "/etc/cron.d/evil",
    });

    expect(mockSimpleGit.raw).not.toHaveBeenCalled();
    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "create-worktree-result",
        requestId: "req-escape-abs",
        success: false,
        error: expect.stringContaining("parent directory"),
      })
    );
  });

  it("rejects a relative path that traverses outside the parent directory (#9154)", async () => {
    // /test/root + ../../escape resolves to /escape, above the /test boundary.
    await service.createWorktree("req-escape-rel", "/test/root", {
      baseBranch: "main",
      newBranch: "feature/escape-rel",
      path: "../../escape",
    });

    expect(mockSimpleGit.raw).not.toHaveBeenCalled();
    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "create-worktree-result",
        requestId: "req-escape-rel",
        success: false,
        error: expect.stringContaining("parent directory"),
      })
    );
  });

  it("rejects a symlinked ancestor that escapes the parent directory (#9154)", async () => {
    // /test/evil is a symlink to /outside; the not-yet-created worktree dir
    // /test/evil/wt therefore really lives at /outside/wt, outside the /test
    // boundary. canonicalizeNearestExisting must resolve the symlink.
    const fsPromisesModule = await import("fs/promises");
    vi.mocked(fsPromisesModule.realpath).mockImplementation((p: any) => {
      const s = String(p);
      if (s === path.resolve("/test/evil/wt")) {
        return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
      }
      if (s === path.resolve("/test/evil")) {
        return Promise.resolve(path.resolve("/outside"));
      }
      return Promise.resolve(s);
    });

    await service.createWorktree("req-escape-symlink", "/test/root", {
      baseBranch: "main",
      newBranch: "feature/escape-symlink",
      path: "/test/evil/wt",
    });

    expect(mockSimpleGit.raw).not.toHaveBeenCalled();
    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "create-worktree-result",
        requestId: "req-escape-symlink",
        success: false,
        error: expect.stringContaining("parent directory"),
      })
    );
  });

  it("rejects a path equal to the parent-directory boundary itself (#9154)", async () => {
    // path "/test" == dirname("/test/root"); rel === "" must be rejected.
    await service.createWorktree("req-boundary-eq", "/test/root", {
      baseBranch: "main",
      newBranch: "feature/boundary",
      path: "/test",
    });

    expect(mockSimpleGit.raw).not.toHaveBeenCalled();
    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "create-worktree-result",
        requestId: "req-boundary-eq",
        success: false,
        error: expect.stringContaining("parent directory"),
      })
    );
  });

  it("propagates a non-ENOENT realpath error instead of degrading containment (#9154)", async () => {
    // EACCES on an existing-but-unreadable segment must fail closed, not be
    // treated as a not-yet-created directory.
    const fsPromisesModule = await import("fs/promises");
    vi.mocked(fsPromisesModule.realpath).mockImplementation((p: any) => {
      const s = String(p);
      if (s === path.resolve("/test/locked/wt")) {
        return Promise.reject(Object.assign(new Error("EACCES"), { code: "EACCES" }));
      }
      return Promise.resolve(s);
    });

    await service.createWorktree("req-eacces", "/test/root", {
      baseBranch: "main",
      newBranch: "feature/eacces",
      path: "/test/locked/wt",
    });

    expect(mockSimpleGit.raw).not.toHaveBeenCalled();
    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "create-worktree-result",
        requestId: "req-eacces",
        success: false,
        error: expect.stringContaining("EACCES"),
      })
    );
  });

  it("allows the default sibling worktree path under the parent directory (#9154)", async () => {
    // Mirrors DEFAULT_WORKTREE_PATH_PATTERN: {parent-dir}/{base-folder}-worktrees/...
    await service.createWorktree("req-sibling-ok", "/test/root", {
      baseBranch: "main",
      newBranch: "feature/ok",
      path: "/test/root-worktrees/feature-ok",
    });

    expect(mockSimpleGit.raw).toHaveBeenCalled();
    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "create-worktree-result",
        requestId: "req-sibling-ok",
        success: true,
      })
    );
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
      expect.objectContaining({
        id: path.resolve("/test/worktree-store"),
        branch: "feature/store-sync",
      })
    );
  });
});

describe("WorkspaceService.loadProject performance behavior", () => {
  let service: WorkspaceService;
  let mockSendEvent: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSimpleGit.raw.mockResolvedValue(undefined);
    mockSimpleGit.checkIsRepo.mockResolvedValue(true);
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

    await service.loadProject("req-1", "/test/root", "ws-test-project-id");

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

  it("uses the worktree folder name for detached worktrees", async () => {
    const mapped = await service["listService"].mapToWorktrees([
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

describe("WorkspaceService.createWorktree submodule init", () => {
  let service: WorkspaceService;
  let mockSendEvent: any;

  const GITLINK_OID = "ed89474bb0f5f812f126c359f46fa6cad2dfe365";
  const BLOB_OID = "0123456789abcdef0123456789abcdef01234567";

  /** `git ls-files --stage -z` output: NUL-TERMINATED records, tab before path. */
  function lsFiles(entries: Array<[mode: string, oid: string, path: string]>): string {
    return entries.map(([mode, oid, p]) => `${mode} ${oid} 0\t${p}\0`).join("");
  }

  function submoduleUpdateCalls(): string[][] {
    return mockSimpleGit.raw.mock.calls
      .map((call) => call[0] as string[])
      .filter((args) => Array.isArray(args) && args[0] === "submodule");
  }

  /**
   * The tail chains several awaits before the submodule call, so one
   * `setImmediate` is not enough to drain it.
   */
  async function drainTail(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSimpleGit.raw.mockResolvedValue(undefined);
    mockSimpleGit.checkIsRepo.mockResolvedValue(true);
    mockSimpleGit.branch.mockResolvedValue({ current: "main" });
    mockSimpleGit.branchLocal.mockResolvedValue({
      all: [],
      current: "",
      branches: {},
      detached: false,
    });

    const fsPromisesModule = await import("fs/promises");
    vi.mocked(fsPromisesModule.realpath).mockImplementation((p: any) => Promise.resolve(p));
    vi.mocked(fsPromisesModule.stat).mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    );

    mockSendEvent = vi.fn();
    const WorkspaceServiceModule = await import("../WorkspaceService.js");
    service = new WorkspaceServiceModule.WorkspaceService(mockSendEvent);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function create(options: Record<string, unknown> = {}): Promise<void> {
    await service.createWorktree("req-submodule", "/test/root", {
      baseBranch: "main",
      newBranch: "feature/submodule",
      path: "/test/worktree",
      ...options,
    } as any);
    await drainTail();
  }

  it("does not run submodule update when the index records no gitlinks", async () => {
    mockSimpleGit.raw.mockImplementation(async (args: string[]) =>
      args[0] === "ls-files" ? lsFiles([["100644", BLOB_OID, "README.md"]]) : undefined
    );

    await create();

    expect(submoduleUpdateCalls()).toEqual([]);
  });

  it("initializes every indexed gitlink under the `all` policy", async () => {
    mockSimpleGit.raw.mockImplementation(async (args: string[]) =>
      args[0] === "ls-files"
        ? lsFiles([
            ["160000", GITLINK_OID, "vendor/lib"],
            ["100644", BLOB_OID, "README.md"],
            ["160000", GITLINK_OID, "vendor/other"],
          ])
        : undefined
    );

    await create({ submoduleInit: "all" });

    expect(submoduleUpdateCalls()).toEqual([
      [
        "submodule",
        "update",
        "--init",
        // Forces clone progress onto a non-tty stderr, which is what keeps
        // simple-git's 30s block timeout from killing a live large clone.
        "--progress",
        "--recommend-shallow",
        "--jobs",
        "4",
        "--",
        "vendor/lib",
        "vendor/other",
      ],
    ]);
  });

  it("initializes only the source checkout's populated modules under `inherit`", async () => {
    const fsPromisesModule = await import("fs/promises");
    // `vendor/lib` is checked out in the source; `vendor/huge` was deliberately
    // left out and must not be silently acquired by the new worktree.
    vi.mocked(fsPromisesModule.stat).mockImplementation(async (target: any) => {
      if (String(target).replace(/\\/g, "/").endsWith("/test/root/vendor/lib/.git")) {
        return { isDirectory: () => true, isFile: () => false } as any;
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    mockSimpleGit.raw.mockImplementation(async (args: string[]) =>
      args[0] === "ls-files"
        ? lsFiles([
            ["160000", GITLINK_OID, "vendor/lib"],
            ["160000", GITLINK_OID, "vendor/huge"],
          ])
        : undefined
    );

    await create();

    const calls = submoduleUpdateCalls();
    expect(calls.length).toBe(1);
    expect(calls[0].slice(calls[0].indexOf("--") + 1)).toEqual(["vendor/lib"]);
  });

  it("skips the roster read entirely under the `none` policy", async () => {
    mockSimpleGit.raw.mockImplementation(async (args: string[]) =>
      args[0] === "ls-files" ? lsFiles([["160000", GITLINK_OID, "vendor/lib"]]) : undefined
    );

    await create({ submoduleInit: "none" });

    expect(submoduleUpdateCalls()).toEqual([]);
    const lsFilesCalls = mockSimpleGit.raw.mock.calls.filter(
      (call) => (call[0] as string[])[0] === "ls-files"
    );
    expect(lsFilesCalls.length).toBe(0);
  });

  it("reports an init failure as lifecycle-setup-error without failing the create", async () => {
    mockSimpleGit.raw.mockImplementation(async (args: string[]) => {
      if (args[0] === "ls-files") return lsFiles([["160000", GITLINK_OID, "vendor/lib"]]);
      if (args[0] === "submodule") throw new Error("fatal: could not read from remote repository");
      return undefined;
    });

    await create({ submoduleInit: "all" });

    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "create-worktree-result",
        requestId: "req-submodule",
        success: true,
      })
    );
    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "lifecycle-setup-error",
        worktreeId: path.resolve("/test/worktree"),
        message: expect.stringContaining("Submodule initialization failed"),
      })
    );
  });

  it('surfaces a malformed roster instead of reading it as "no submodules"', async () => {
    // `-z` output that does not end in NUL is a truncated stream. Treating it as
    // an empty roster is the silent-unpopulated-worktree bug this pass exists to
    // fix, so it has to fail visibly instead.
    mockSimpleGit.raw.mockImplementation(async (args: string[]) =>
      args[0] === "ls-files" ? "160000 0000 0\tvendor/lib" : undefined
    );

    await create({ submoduleInit: "all" });

    expect(submoduleUpdateCalls()).toEqual([]);
    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "lifecycle-setup-error",
        message: expect.stringContaining("Submodule initialization failed"),
      })
    );
  });

  it("still runs lifecycle setup after an init failure", async () => {
    mockSimpleGit.raw.mockImplementation(async (args: string[]) => {
      if (args[0] === "ls-files") return lsFiles([["160000", GITLINK_OID, "vendor/lib"]]);
      if (args[0] === "submodule") throw new Error("fatal: could not read from remote repository");
      return undefined;
    });
    const setupSpy = vi.spyOn(service as any, "runLifecycleSetup").mockResolvedValue(undefined);

    await create({ submoduleInit: "all" });

    // The failing init has to have actually run, or this asserts nothing about
    // ordering — it would pass with the whole submodule pass deleted.
    expect(submoduleUpdateCalls().length).toBe(1);
    // One unreachable private submodule must not leave the worktree completely
    // unprovisioned — there is no retry path for setup.
    expect(setupSpy).toHaveBeenCalledTimes(1);
  });

  it('surfaces an unreadable roster instead of reading it as "no submodules"', async () => {
    // `git.raw` resolving to something that is not a string is an unknown, and an
    // unknown answered as "no submodules" is the silent-empty-worktree bug.
    mockSimpleGit.raw.mockResolvedValue(undefined);

    await create({ submoduleInit: "all" });

    expect(submoduleUpdateCalls()).toEqual([]);
    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "lifecycle-setup-error",
        message: expect.stringContaining("no readable output"),
      })
    );
  });

  it("finishes submodule init before lifecycle setup is dispatched", async () => {
    const order: string[] = [];
    let releaseUpdate!: () => void;
    const updateGate = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });

    mockSimpleGit.raw.mockImplementation(async (args: string[]) => {
      if (args[0] === "ls-files") return lsFiles([["160000", GITLINK_OID, "vendor/lib"]]);
      if (args[0] === "submodule") {
        order.push("submodule-update:start");
        await updateGate;
        order.push("submodule-update:end");
      }
      return undefined;
    });

    const setupSpy = vi.spyOn(service as any, "runLifecycleSetup").mockImplementation(async () => {
      order.push("lifecycle-setup");
    });

    await service.createWorktree("req-order", "/test/root", {
      baseBranch: "main",
      newBranch: "feature/order",
      path: "/test/worktree",
      submoduleInit: "all",
    } as any);
    await drainTail();

    expect(order).toEqual(["submodule-update:start"]);
    expect(setupSpy).not.toHaveBeenCalled();

    releaseUpdate();
    await drainTail();

    expect(order).toEqual(["submodule-update:start", "submodule-update:end", "lifecycle-setup"]);
  });
});
