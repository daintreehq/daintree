import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import type { WorkspaceService } from "../WorkspaceService.js";
import type { WorktreeMonitor } from "../WorktreeMonitor.js";
import type { Worktree } from "../../../shared/types/worktree.js";

const n = (p: string) => (p as string).replace(/\\/g, "/");

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
  validateBranchName: vi.fn(),
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
    return { read: vi.fn().mockResolvedValue({}) };
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
  access: vi.fn().mockRejectedValue(new Error("ENOENT")),
  readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
  cp: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

function createTestWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: "/test/worktree",
    path: "/test/worktree",
    name: "feature/test",
    branch: "feature/test",
    isCurrent: false,
    isMainWorktree: false,
    gitDir: "/test/worktree/.git",
    ...overrides,
  };
}

describe("WorkspaceService.deleteWorktree", () => {
  let service: WorkspaceService;
  let mockSendEvent: ReturnType<typeof vi.fn>;
  let WorktreeMonitorClass: typeof WorktreeMonitor;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset implementations too — `clearAllMocks` only wipes call history, so
    // a custom `mockImplementation` from a prior test would leak otherwise.
    mockSimpleGit.raw.mockReset().mockResolvedValue(undefined);
    mockSimpleGit.branch.mockReset().mockResolvedValue({ current: "main" });
    mockSendEvent = vi.fn();

    const WorkspaceServiceModule = await import("../WorkspaceService.js");
    service = new WorkspaceServiceModule.WorkspaceService(mockSendEvent as any);

    const WorktreeMonitorModule = await import("../WorktreeMonitor.js");
    WorktreeMonitorClass = WorktreeMonitorModule.WorktreeMonitor;

    service["projectRootPath"] = "/test/root";
    service["git"] = mockSimpleGit as any;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createAndRegisterMonitor(overrides: Partial<Worktree> = {}): WorktreeMonitor {
    const wt = createTestWorktree(overrides);
    const monitor = new WorktreeMonitorClass(
      wt,
      {
        basePollingInterval: 10000,
        adaptiveBackoff: false,
        pollIntervalMax: 30000,
        circuitBreakerThreshold: 3,
        gitWatchEnabled: false,
      },
      { onUpdate: vi.fn() },
      "main"
    );
    service["monitors"].set(wt.id, monitor);
    return monitor;
  }

  it("sends delete-worktree-result success after removing monitor", async () => {
    const fsModule = await import("fs/promises");
    vi.mocked(fsModule.access).mockImplementation(async (p: unknown) => {
      if (n(p as string) === "/test/worktree") return undefined;
      throw new Error("ENOENT");
    });

    createAndRegisterMonitor();

    await service.deleteWorktree("req-1", "/test/worktree");

    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "delete-worktree-result",
        requestId: "req-1",
        success: true,
      })
    );
    expect(service["monitors"].has("/test/worktree")).toBe(false);
    const removeCalls = mockSimpleGit.raw.mock.calls.filter(
      (c) => Array.isArray(c[0]) && c[0][0] === "worktree" && c[0][1] === "remove"
    );
    expect(removeCalls.length).toBe(1);
    // Defuses leading-dash worktree paths so they cannot be parsed as flags.
    const removeArgs = removeCalls[0][0] as string[];
    const eooIdx = removeArgs.indexOf("--end-of-options");
    const pathIdx = removeArgs.indexOf("/test/worktree");
    expect(eooIdx).toBeGreaterThanOrEqual(0);
    expect(pathIdx).toBeGreaterThan(eooIdx);
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
    createAndRegisterMonitor({ isMainWorktree: true });

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

    mockAccess.mockImplementation(async (p: unknown) => {
      const norm = n(p as string);
      if (norm.endsWith("/test/root/.daintree/config.json")) return undefined;
      if (norm === "/test/worktree") return undefined;
      throw new Error("ENOENT");
    });
    mockReadFile.mockResolvedValue(JSON.stringify(teardownConfig));

    const childProcessModule = await import("child_process");
    const mockSpawn = vi.mocked(childProcessModule.spawn);

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
      return child as any;
    });

    mockSimpleGit.raw.mockImplementation(async (args: string[]) => {
      globalCallLog.push(`git:${args.join(" ")}`);
    });

    createAndRegisterMonitor();

    await service.deleteWorktree("req-4", "/test/worktree");

    const spawnPos = globalCallLog.indexOf("spawn");
    const gitRemovePos = globalCallLog.findIndex((e) => e.includes("worktree remove"));

    expect(spawnPos).toBeGreaterThanOrEqual(0);
    expect(gitRemovePos).toBeGreaterThanOrEqual(0);
    expect(spawnPos).toBeLessThan(gitRemovePos);
  });

  it("proceeds with deletion even when teardown fails", async () => {
    const teardownConfig = { teardown: ["failing-teardown-cmd"] };
    const fsModule = await import("fs/promises");
    const mockAccess = vi.mocked(fsModule.access);
    const mockReadFile = vi.mocked(fsModule.readFile);

    mockAccess.mockImplementation(async (p: unknown) => {
      const norm = n(p as string);
      if (norm.endsWith("/test/root/.daintree/config.json")) return undefined;
      // Worktree dir is present so we exercise the normal `git worktree
      // remove` path, not the #6669 prune-on-missing branch.
      if (norm === "/test/worktree") return undefined;
      throw new Error("ENOENT");
    });
    mockReadFile.mockResolvedValue(JSON.stringify(teardownConfig));

    const gitCalls: string[][] = [];
    mockSimpleGit.raw.mockImplementation(async (args: string[]) => {
      gitCalls.push(args);
      return undefined;
    });

    const childProcessModule = await import("child_process");
    const mockSpawn = vi.mocked(childProcessModule.spawn);
    mockSpawn.mockImplementation(() => {
      const child = {
        pid: 99,
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
          if (event === "close") setTimeout(() => cb(1), 0);
        }),
        kill: vi.fn(),
      };
      return child as any;
    });

    createAndRegisterMonitor();

    await service.deleteWorktree("req-5", "/test/worktree");

    const removeCalls = gitCalls.filter((c) => c[0] === "worktree" && c[1] === "remove");
    expect(removeCalls.length).toBe(1);

    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "delete-worktree-result",
        success: true,
      })
    );
    expect(service["monitors"].has("/test/worktree")).toBe(false);
  });

  it("blocks non-force deletion with 'untracked files' when only untracked files exist", async () => {
    const monitor = createAndRegisterMonitor();
    vi.spyOn(monitor, "getWorktreeChanges").mockReturnValue({
      worktreeId: "/test/worktree",
      rootPath: "/test/worktree",
      changedFileCount: 2,
      changes: [
        { path: "new.txt", status: "untracked", insertions: null, deletions: null },
        { path: "temp.log", status: "untracked", insertions: null, deletions: null },
      ],
    });

    await service.deleteWorktree("req-ut1", "/test/worktree");

    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "delete-worktree-result",
        success: false,
        error: expect.stringContaining("untracked files"),
      })
    );
    const call = mockSendEvent.mock.calls.find(
      (c: unknown[]) => (c[0] as Record<string, unknown>).type === "delete-worktree-result"
    );
    expect((call![0] as Record<string, string>).error).not.toContain("uncommitted changes");
  });

  it("blocks non-force deletion with 'uncommitted changes' when only tracked changes exist", async () => {
    const monitor = createAndRegisterMonitor();
    vi.spyOn(monitor, "getWorktreeChanges").mockReturnValue({
      worktreeId: "/test/worktree",
      rootPath: "/test/worktree",
      changedFileCount: 1,
      changes: [{ path: "src/app.ts", status: "modified", insertions: 5, deletions: 2 }],
    });

    await service.deleteWorktree("req-ut2", "/test/worktree");

    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "delete-worktree-result",
        success: false,
        error: expect.stringContaining("uncommitted changes"),
      })
    );
    const call = mockSendEvent.mock.calls.find(
      (c: unknown[]) => (c[0] as Record<string, unknown>).type === "delete-worktree-result"
    );
    expect((call![0] as Record<string, string>).error).not.toContain("untracked files");
  });

  it("blocks non-force deletion with 'uncommitted changes and untracked files' when both exist", async () => {
    const monitor = createAndRegisterMonitor();
    vi.spyOn(monitor, "getWorktreeChanges").mockReturnValue({
      worktreeId: "/test/worktree",
      rootPath: "/test/worktree",
      changedFileCount: 2,
      changes: [
        { path: "src/app.ts", status: "modified", insertions: 5, deletions: 2 },
        { path: "new.txt", status: "untracked", insertions: null, deletions: null },
      ],
    });

    await service.deleteWorktree("req-ut3", "/test/worktree");

    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "delete-worktree-result",
        success: false,
        error: expect.stringContaining("uncommitted changes and untracked files"),
      })
    );
  });

  it("prunes instead of removing when worktree directory is missing (#6669)", async () => {
    const fsModule = await import("fs/promises");
    const mockAccess = vi.mocked(fsModule.access);
    const enoent: NodeJS.ErrnoException = Object.assign(new Error("ENOENT"), {
      code: "ENOENT",
    });
    mockAccess.mockRejectedValue(enoent);

    const gitCalls: string[][] = [];
    mockSimpleGit.raw.mockImplementation(async (args: string[]) => {
      gitCalls.push(args);
      return undefined;
    });

    createAndRegisterMonitor();

    await service.deleteWorktree("req-missing", "/test/worktree");

    const removeCalls = gitCalls.filter((c) => c[0] === "worktree" && c[1] === "remove");
    const pruneCalls = gitCalls.filter((c) => c[0] === "worktree" && c[1] === "prune");
    expect(removeCalls.length).toBe(0);
    expect(pruneCalls.length).toBe(1);

    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "delete-worktree-result",
        requestId: "req-missing",
        success: true,
      })
    );
    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "worktree-removed", worktreeId: "/test/worktree" })
    );
    expect(service["monitors"].has("/test/worktree")).toBe(false);
  });

  it("succeeds when missing path triggers prune even if prune itself fails (#6669)", async () => {
    const fsModule = await import("fs/promises");
    const mockAccess = vi.mocked(fsModule.access);
    const enoent: NodeJS.ErrnoException = Object.assign(new Error("ENOENT"), {
      code: "ENOENT",
    });
    mockAccess.mockRejectedValue(enoent);

    mockSimpleGit.raw.mockImplementation(async (args: string[]) => {
      if (args[0] === "worktree" && args[1] === "prune") {
        throw new Error("fatal: prune failed (unrelated)");
      }
      return undefined;
    });

    createAndRegisterMonitor();

    await service.deleteWorktree("req-prune-fail", "/test/worktree");

    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "delete-worktree-result",
        requestId: "req-prune-fail",
        success: true,
      })
    );
    expect(service["monitors"].has("/test/worktree")).toBe(false);
  });

  it("falls back to prune when remove returns 'is not a working tree' (#6669)", async () => {
    const fsModule = await import("fs/promises");
    const mockAccess = vi.mocked(fsModule.access);
    mockAccess.mockImplementation(async (p: unknown) => {
      if (n(p as string) === "/test/worktree") return undefined;
      throw new Error("ENOENT");
    });

    const gitCalls: string[][] = [];
    mockSimpleGit.raw.mockImplementation(async (args: string[]) => {
      gitCalls.push(args);
      if (args[0] === "worktree" && args[1] === "remove") {
        throw new Error("fatal: '/test/worktree' is not a working tree");
      }
      return undefined;
    });

    createAndRegisterMonitor();

    await service.deleteWorktree("req-stale", "/test/worktree");

    const removeCalls = gitCalls.filter((c) => c[0] === "worktree" && c[1] === "remove");
    const pruneCalls = gitCalls.filter((c) => c[0] === "worktree" && c[1] === "prune");
    expect(removeCalls.length).toBe(1);
    expect(pruneCalls.length).toBe(1);

    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "delete-worktree-result",
        requestId: "req-stale",
        success: true,
      })
    );
    expect(service["monitors"].has("/test/worktree")).toBe(false);
  });

  it("falls through to git remove on non-ENOENT access error (e.g. EPERM)", async () => {
    const fsModule = await import("fs/promises");
    const mockAccess = vi.mocked(fsModule.access);
    const eperm: NodeJS.ErrnoException = Object.assign(new Error("EPERM"), {
      code: "EPERM",
    });
    mockAccess.mockRejectedValue(eperm);

    const gitCalls: string[][] = [];
    mockSimpleGit.raw.mockImplementation(async (args: string[]) => {
      gitCalls.push(args);
      return undefined;
    });

    createAndRegisterMonitor();

    await service.deleteWorktree("req-eperm", "/test/worktree");

    const removeCalls = gitCalls.filter((c) => c[0] === "worktree" && c[1] === "remove");
    const pruneCalls = gitCalls.filter((c) => c[0] === "worktree" && c[1] === "prune");
    expect(removeCalls.length).toBe(1);
    expect(pruneCalls.length).toBe(0);

    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "delete-worktree-result",
        requestId: "req-eperm",
        success: true,
      })
    );
  });

  it("propagates non-stale git errors from worktree remove", async () => {
    const fsModule = await import("fs/promises");
    const mockAccess = vi.mocked(fsModule.access);
    mockAccess.mockImplementation(async (p: unknown) => {
      if (n(p as string) === "/test/worktree") return undefined;
      throw new Error("ENOENT");
    });

    mockSimpleGit.raw.mockImplementation(async (args: string[]) => {
      if (args[0] === "worktree" && args[1] === "remove") {
        throw new Error("fatal: locked working tree");
      }
      return undefined;
    });

    createAndRegisterMonitor();

    await service.deleteWorktree("req-locked", "/test/worktree");

    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "delete-worktree-result",
        requestId: "req-locked",
        success: false,
        error: expect.stringContaining("locked"),
      })
    );
    expect(service["monitors"].has("/test/worktree")).toBe(true);
  });

  it("retries transient filesystem locks from git worktree remove", async () => {
    vi.useFakeTimers();
    try {
      const fsModule = await import("fs/promises");
      const mockAccess = vi.mocked(fsModule.access);
      mockAccess.mockImplementation(async (p: unknown) => {
        if (n(p as string) === "/test/worktree") return undefined;
        throw new Error("ENOENT");
      });

      let removeAttempts = 0;
      mockSimpleGit.raw.mockImplementation(async (args: string[]) => {
        if (args[0] === "worktree" && args[1] === "remove") {
          removeAttempts += 1;
          if (removeAttempts === 1) {
            throw new Error("fatal: failed to delete '/test/worktree': Permission denied");
          }
        }
        return undefined;
      });

      createAndRegisterMonitor();

      const promise = service.deleteWorktree("req-permission-retry", "/test/worktree");
      await vi.advanceTimersByTimeAsync(250);
      await promise;

      expect(removeAttempts).toBe(2);
      expect(mockSendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "delete-worktree-result",
          requestId: "req-permission-retry",
          success: true,
        })
      );
      expect(service["monitors"].has("/test/worktree")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips teardown when no config file exists", async () => {
    const fsModule = await import("fs/promises");
    vi.mocked(fsModule.access).mockRejectedValue(new Error("ENOENT"));

    const childProcessModule = await import("child_process");
    const mockSpawn = vi.mocked(childProcessModule.spawn);

    createAndRegisterMonitor();

    await service.deleteWorktree("req-6", "/test/worktree");

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "delete-worktree-result", success: true })
    );
  });

  it("uses 'branch -D' when force=true and deleteBranch=true", async () => {
    const fsModule = await import("fs/promises");
    vi.mocked(fsModule.access).mockImplementation(async (p: unknown) => {
      if (n(p as string) === "/test/worktree") return undefined;
      throw new Error("ENOENT");
    });

    createAndRegisterMonitor({ branch: "feature/test" });

    await service.deleteWorktree("req-force-delete", "/test/worktree", true, true);

    const branchCalls = mockSimpleGit.raw.mock.calls.filter(
      (c) => Array.isArray(c[0]) && c[0][0] === "branch"
    );
    expect(branchCalls.length).toBe(1);
    expect(branchCalls[0][0]).toEqual(["branch", "-D", "feature/test"]);
    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "delete-worktree-result",
        requestId: "req-force-delete",
        success: true,
      })
    );
  });

  it("surfaces unmerged-branch error when force=false and branch is not fully merged", async () => {
    const fsModule = await import("fs/promises");
    vi.mocked(fsModule.access).mockImplementation(async (p: unknown) => {
      if (n(p as string) === "/test/worktree") return undefined;
      throw new Error("ENOENT");
    });

    mockSimpleGit.raw.mockImplementation(async (args: string[]) => {
      if (args[0] === "branch" && args[1] === "-d") {
        throw new Error("error: the branch 'feature/test' is not fully merged.");
      }
      return undefined;
    });

    createAndRegisterMonitor({ branch: "feature/test" });

    await service.deleteWorktree("req-unmerged", "/test/worktree", false, true);

    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "delete-worktree-result",
        requestId: "req-unmerged",
        success: false,
        error: expect.stringContaining("Enable force delete"),
      })
    );
  });

  it("succeeds when force=true and branch is unmerged", async () => {
    const fsModule = await import("fs/promises");
    vi.mocked(fsModule.access).mockImplementation(async (p: unknown) => {
      if (n(p as string) === "/test/worktree") return undefined;
      throw new Error("ENOENT");
    });

    mockSimpleGit.raw.mockImplementation(async (args: string[]) => {
      if (args[0] === "branch" && args[1] === "-d") {
        throw new Error("error: the branch 'feature/test' is not fully merged.");
      }
      return undefined;
    });

    createAndRegisterMonitor({ branch: "feature/test" });

    await service.deleteWorktree("req-force-unmerged", "/test/worktree", true, true);

    const branchCalls = mockSimpleGit.raw.mock.calls.filter(
      (c) => Array.isArray(c[0]) && c[0][0] === "branch"
    );
    expect(branchCalls.length).toBe(1);
    expect(branchCalls[0][0]).toEqual(["branch", "-D", "feature/test"]);
    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "delete-worktree-result",
        requestId: "req-force-unmerged",
        success: true,
      })
    );
  });

  // Mutation-outbox dedup (#8405). The renderer mints a `mutationId` per
  // user-intent delete and re-fires it on reconnect if the ack never landed;
  // the host must short-circuit acked replays to `success` without re-running
  // `git worktree remove` (which would throw "not a working tree").
  describe("mutation-id dedup (#8405)", () => {
    it("records the mutationId in the ack map after a successful delete", async () => {
      const fsModule = await import("fs/promises");
      vi.mocked(fsModule.access).mockImplementation(async (p: unknown) => {
        if (n(p as string) === "/test/worktree") return undefined;
        throw new Error("ENOENT");
      });
      createAndRegisterMonitor();

      await service.deleteWorktree("req-ack-1", "/test/worktree", false, false, "mut-1");

      expect(service.getAcknowledgedMutationIds()).toEqual(["mut-1"]);
    });

    it("does NOT record the mutationId when the delete fails", async () => {
      const fsModule = await import("fs/promises");
      vi.mocked(fsModule.access).mockImplementation(async (p: unknown) => {
        if (n(p as string) === "/test/worktree") return undefined;
        throw new Error("ENOENT");
      });
      mockSimpleGit.raw.mockImplementation(async (args: string[]) => {
        if (args[0] === "worktree" && args[1] === "remove") {
          throw new Error("simulated worktree remove failure");
        }
      });
      createAndRegisterMonitor();

      await service.deleteWorktree("req-fail-1", "/test/worktree", false, false, "mut-fail");

      expect(service.getAcknowledgedMutationIds()).toEqual([]);
      expect(mockSendEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "delete-worktree-result", success: false })
      );
    });

    it("a replay with the same mutationId acks success without re-running git", async () => {
      const fsModule = await import("fs/promises");
      vi.mocked(fsModule.access).mockImplementation(async (p: unknown) => {
        if (n(p as string) === "/test/worktree") return undefined;
        throw new Error("ENOENT");
      });
      createAndRegisterMonitor();

      await service.deleteWorktree("req-original", "/test/worktree", false, false, "mut-replay");

      // Monitor is gone; ack map remembers `mut-replay`.
      expect(service["monitors"].has("/test/worktree")).toBe(false);
      mockSimpleGit.raw.mockClear();
      mockSendEvent.mockClear();

      await service.deleteWorktree("req-replay", "/test/worktree", false, false, "mut-replay");

      // Did NOT run any git commands — the early-out fired before the monitor
      // lookup (which would have thrown "not found").
      expect(mockSimpleGit.raw).not.toHaveBeenCalled();
      expect(mockSendEvent).toHaveBeenCalledWith({
        type: "delete-worktree-result",
        requestId: "req-replay",
        success: true,
      });
    });

    it("caps the ack set FIFO — oldest ids evict first, recent ids survive", async () => {
      const { MAX_ACKNOWLEDGED_MUTATIONS } = await import("../WorkspaceService.js");
      const record = (id: string) => service["recordAcknowledgedMutation"](id);

      record("mut-oldest");
      for (let i = 0; i < MAX_ACKNOWLEDGED_MUTATIONS; i++) {
        record(`mut-${i}`);
      }

      const ids = service.getAcknowledgedMutationIds();
      expect(ids.length).toBe(MAX_ACKNOWLEDGED_MUTATIONS);
      expect(ids).not.toContain("mut-oldest");
      expect(ids).toContain(`mut-${MAX_ACKNOWLEDGED_MUTATIONS - 1}`);
    });

    it("a request with a NEW mutationId for an already-removed worktree still throws not-found", async () => {
      // Sanity check: only the matching mutationId short-circuits — a fresh
      // mutationId on a phantom id is a genuine error.
      const fsModule = await import("fs/promises");
      vi.mocked(fsModule.access).mockImplementation(async (p: unknown) => {
        if (n(p as string) === "/test/worktree") return undefined;
        throw new Error("ENOENT");
      });
      createAndRegisterMonitor();
      await service.deleteWorktree("req-first", "/test/worktree", false, false, "mut-a");

      mockSendEvent.mockClear();
      await service.deleteWorktree("req-new", "/test/worktree", false, false, "mut-b");

      expect(mockSendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "delete-worktree-result",
          requestId: "req-new",
          success: false,
          error: expect.stringContaining("not found"),
        })
      );
    });

    it("getAllStates includes the ack list in the all-states event", async () => {
      const fsModule = await import("fs/promises");
      vi.mocked(fsModule.access).mockImplementation(async (p: unknown) => {
        if (n(p as string) === "/test/worktree") return undefined;
        throw new Error("ENOENT");
      });
      createAndRegisterMonitor();
      await service.deleteWorktree("req-record", "/test/worktree", false, false, "mut-list");

      mockSendEvent.mockClear();
      service.getAllStates("states-1");

      expect(mockSendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "all-states",
          requestId: "states-1",
          lastAcknowledgedMutationIds: ["mut-list"],
        })
      );
    });

    it("re-throws on failure when throwOnError=true so the port handler can reject (#8405 review #1)", async () => {
      // Pre-PR the port path would resolve to { ok: true } on every call
      // because `deleteWorktree` caught its own errors and emitted them via
      // sendEvent (which the port handler doesn't observe). With
      // `throwOnError=true` the port handler's outer catch rejects the
      // renderer's port request.
      await expect(
        service.deleteWorktree(
          "req-throws",
          "/nonexistent/worktree",
          false,
          false,
          "mut-throw",
          /* throwOnError */ true
        )
      ).rejects.toThrow(/not found/);

      // The legacy sendEvent path still fires for backward compat with
      // `WorkspaceClient.sendWithResponse` callers.
      expect(mockSendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "delete-worktree-result",
          requestId: "req-throws",
          success: false,
          error: expect.stringContaining("not found"),
        })
      );
    });

    it("does NOT re-throw on failure when throwOnError is omitted (legacy contract)", async () => {
      // Legacy IPC callers depend on the resolved-promise + sendEvent contract.
      // Regression guard for the bridge path (`WorkspaceClient.sendWithResponse`)
      // and the existing test suite above this `describe` block.
      await expect(
        service.deleteWorktree("req-legacy-no-throw", "/nonexistent/worktree")
      ).resolves.toBeUndefined();

      expect(mockSendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "delete-worktree-result",
          requestId: "req-legacy-no-throw",
          success: false,
          error: expect.stringContaining("not found"),
        })
      );
    });

    it("deleteWorktree without a mutationId still works (backward compatible)", async () => {
      const fsModule = await import("fs/promises");
      vi.mocked(fsModule.access).mockImplementation(async (p: unknown) => {
        if (n(p as string) === "/test/worktree") return undefined;
        throw new Error("ENOENT");
      });
      createAndRegisterMonitor();

      await service.deleteWorktree("req-no-mut", "/test/worktree");

      expect(mockSendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "delete-worktree-result",
          requestId: "req-no-mut",
          success: true,
        })
      );
      // Nothing recorded in the ack map without an id — legacy callers don't
      // pollute the snapshot list.
      expect(service.getAcknowledgedMutationIds()).toEqual([]);
    });
  });
});
