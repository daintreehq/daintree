import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import path from "node:path";
import type { WorkspaceService } from "../WorkspaceService.js";
import type { WorktreeMonitor } from "../WorktreeMonitor.js";
import type { Worktree } from "../../../shared/types/worktree.js";
import type { SubmoduleDeleteRisk } from "../../../shared/types/submodule.js";

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

const submoduleInventoryMocks = vi.hoisted(() => ({
  buildSubmoduleDeleteRisk: vi.fn(),
}));

vi.mock("../../utils/submoduleInventory.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/submoduleInventory.js")>()),
  buildSubmoduleDeleteRisk: submoduleInventoryMocks.buildSubmoduleDeleteRisk,
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

// `.code` is not decoration: the delete path distinguishes "definitively not
// there" from "could not tell", and a code-less rejection is the second.
const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });

vi.mock("fs/promises", () => ({
  stat: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
  readFile: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
  readdir: vi.fn().mockResolvedValue([]),
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
    // Every delete now inventories submodules, so the default has to be a real
    // clean risk rather than the bare `vi.fn()`'s undefined.
    submoduleInventoryMocks.buildSubmoduleDeleteRisk.mockReset().mockResolvedValue({
      entries: [],
      dirtyFiles: [],
      untrackedFiles: [],
      atRiskCommits: [],
      requiresMechanicalForce: false,
      incomplete: false,
    } satisfies SubmoduleDeleteRisk);
    mockSendEvent = vi.fn();

    // `restoreAllMocks` wipes the factory's implementations, so the coded
    // rejections have to be re-established or the delete path reads "cannot
    // tell" where the fixture means "not there".
    const fsModule = await import("fs/promises");
    vi.mocked(fsModule.stat).mockRejectedValue(enoent());
    vi.mocked(fsModule.access).mockRejectedValue(enoent());
    vi.mocked(fsModule.readFile).mockRejectedValue(enoent());
    vi.mocked(fsModule.readdir).mockResolvedValue([]);

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

  // `force` and `forceDeleteBranch` are two consents. `force` covers the
  // working tree; only `forceDeleteBranch` may reach for `branch -D`. They
  // used to be one boolean, so a user who agreed to discard uncommitted files
  // also, unannounced, discarded commits no other branch held.
  describe("branch deletion is a consent of its own", () => {
    function mockUnmergedBranch() {
      mockSimpleGit.raw.mockImplementation(async (args: string[]) => {
        if (args[0] === "branch" && args[1] === "-d") {
          throw new Error("error: the branch 'feature/test' is not fully merged.");
        }
        return undefined;
      });
    }

    async function mockWorktreePathPresent() {
      const fsModule = await import("fs/promises");
      vi.mocked(fsModule.access).mockImplementation(async (p: unknown) => {
        if (n(p as string) === "/test/worktree") return undefined;
        throw new Error("ENOENT");
      });
    }

    function branchArgs(): string[][] {
      return mockSimpleGit.raw.mock.calls
        .map((c) => c[0])
        .filter((a): a is string[] => Array.isArray(a) && a[0] === "branch");
    }

    it("still uses the safe 'branch -d' when force=true", async () => {
      await mockWorktreePathPresent();
      createAndRegisterMonitor({ branch: "feature/test" });

      await service.deleteWorktree("req-force-delete", "/test/worktree", true, true);

      expect(branchArgs()).toEqual([["branch", "-d", "feature/test"]]);
      expect(mockSendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "delete-worktree-result",
          requestId: "req-force-delete",
          success: true,
        })
      );
    });

    it("uses 'branch -D' only when forceDeleteBranch is granted", async () => {
      await mockWorktreePathPresent();
      mockUnmergedBranch();
      createAndRegisterMonitor({ branch: "feature/test" });

      await service.deleteWorktree(
        "req-force-branch",
        "/test/worktree",
        false,
        true,
        undefined,
        false,
        {
          forceDeleteBranch: true,
        }
      );

      expect(branchArgs()).toEqual([["branch", "-D", "feature/test"]]);
      expect(mockSendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "delete-worktree-result",
          requestId: "req-force-branch",
          success: true,
        })
      );
    });

    it.each([
      ["force=false", false],
      ["force=true", true],
    ])(
      "keeps an unmerged branch when %s and reports the removal that happened",
      async (_label, force) => {
        await mockWorktreePathPresent();
        mockUnmergedBranch();
        createAndRegisterMonitor({ branch: "feature/test" });

        const requestId = `req-unmerged-${force}`;
        await service.deleteWorktree(requestId, "/test/worktree", force, true);

        // Only the safe attempt is ever made — `force` must not reach for `-D`.
        expect(branchArgs()).toEqual([["branch", "-d", "feature/test"]]);
        // The worktree is gone by the time the branch step runs, so the error
        // has to say so — the user cannot retry the operation as a whole. And
        // it must not tell them to enable force, which no longer does this.
        const result = mockSendEvent.mock.calls
          .map((c) => c[0])
          .find((e) => e.type === "delete-worktree-result" && e.requestId === requestId);
        expect(result.success).toBe(false);
        expect(result.error).toContain("Worktree removed.");
        expect(result.error).toContain("was kept because Git reports it isn't fully merged");
        expect(result.error).not.toContain("force");
        expect(service["monitors"].has("/test/worktree")).toBe(false);
      }
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

  describe("getFreshWorktreeChanges (#11343)", () => {
    it("returns a guaranteed-fresh status read (bypassing the single-flight pass)", async () => {
      const monitor = createAndRegisterMonitor();
      const fresh = {
        worktreeId: "/test/worktree",
        rootPath: "/test/worktree",
        changedFileCount: 2,
        changes: [
          { path: "a.ts", status: "modified" as const, insertions: null, deletions: null },
          { path: "n.txt", status: "untracked" as const, insertions: null, deletions: null },
        ],
      };
      // The service must read through getFreshChanges (forced git status), NOT
      // refresh()/getWorktreeChanges() which can no-op to a stale snapshot when
      // a poll is mid-pass.
      const freshSpy = vi.spyOn(monitor, "getFreshChanges").mockResolvedValue(fresh);

      const result = await service.getFreshWorktreeChanges("/test/worktree");

      expect(freshSpy).toHaveBeenCalledTimes(1);
      expect(result).toEqual(fresh);
    });

    it("propagates a fresh-read failure so callers fail closed", async () => {
      const monitor = createAndRegisterMonitor();
      vi.spyOn(monitor, "getFreshChanges").mockRejectedValue(new Error("git status failed"));

      await expect(service.getFreshWorktreeChanges("/test/worktree")).rejects.toThrow(
        "git status failed"
      );
    });

    it("returns null when no monitor exists for the id", async () => {
      await expect(service.getFreshWorktreeChanges("/nonexistent")).resolves.toBeNull();
    });
  });

  describe("submodule delete gate", () => {
    // WorkspaceService resolves filesystem probes before calling them. On
    // Windows an apparent `/test/...` path acquires the current drive, so the
    // mocks must compare with that same host-resolved spelling.
    const MODULES_DIR = n(path.resolve("/test/worktree", ".git", "modules"));
    const SURVIVING_STORE = n(path.resolve("/test/worktree", ".git", "modules", "vendor-lib"));
    /** Field separator in the surviving-store rev walk's `--format`. */
    const US = "\u001f";

    const dirent = (name: string, kind: "dir" | "file") => ({
      name,
      isDirectory: () => kind === "dir",
      isFile: () => kind === "file",
    });

    /** `stat` answers "directory" for the worktree-owned module store. */
    async function withModuleStore(): Promise<void> {
      const fsModule = await import("fs/promises");
      vi.mocked(fsModule.stat).mockImplementation(async (target: unknown) => {
        if (n(target as string) === MODULES_DIR) {
          return { isDirectory: () => true, isFile: () => false } as any;
        }
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });
      await withPresentWorktreeDir();
    }

    /** No module store on disk — git would not refuse, so no mechanical force. */
    async function withoutModuleStore(): Promise<void> {
      const fsModule = await import("fs/promises");
      vi.mocked(fsModule.stat).mockRejectedValue(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" })
      );
      await withPresentWorktreeDir();
    }

    /** Keeps the delete on the `git worktree remove` path, not the #6669 prune one. */
    async function withPresentWorktreeDir(): Promise<void> {
      const fsModule = await import("fs/promises");
      vi.mocked(fsModule.access).mockImplementation(async (p: unknown) => {
        if (n(p as string) === "/test/worktree") return undefined;
        throw new Error("ENOENT");
      });
    }

    function stubRisk(overrides: Partial<SubmoduleDeleteRisk> = {}): ReturnType<typeof vi.spyOn> {
      return vi.spyOn(service as any, "inventorySubmoduleRisk").mockResolvedValue({
        entries: [],
        dirtyFiles: [],
        untrackedFiles: [],
        atRiskCommits: [],
        requiresMechanicalForce: false,
        incomplete: false,
        ...overrides,
      } satisfies SubmoduleDeleteRisk);
    }

    function removeArgs(): string[] | undefined {
      const call = mockSimpleGit.raw.mock.calls.find(
        (c) => Array.isArray(c[0]) && c[0][0] === "worktree" && c[0][1] === "remove"
      );
      return call?.[0] as string[] | undefined;
    }

    function failureError(): string | undefined {
      return mockSendEvent.mock.calls
        .map((c) => c[0])
        .find((e) => e.type === "delete-worktree-result" && e.success === false)?.error;
    }

    it("adds --force mechanically on the direct module-store probe alone", async () => {
      // Inventory says no, the `<gitdir>/modules` stat says yes — the case where
      // the inventory timed out and answered `requiresMechanicalForce: false`.
      await withModuleStore();
      stubRisk({ requiresMechanicalForce: false });
      createAndRegisterMonitor();

      await service.deleteWorktree("req-mech-probe", "/test/worktree");

      expect(mockSendEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "delete-worktree-result", success: true })
      );
      expect(removeArgs()).toContain("--force");
    });

    it("adds --force mechanically on the inventory's answer alone", async () => {
      // The mirror case: `--git-dir` could not be resolved, so the direct probe
      // answered false, but the inventory found the module store.
      await withoutModuleStore();
      stubRisk({ requiresMechanicalForce: true });
      createAndRegisterMonitor();

      await service.deleteWorktree("req-mech-inventory", "/test/worktree");

      expect(mockSendEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "delete-worktree-result", success: true })
      );
      expect(removeArgs()).toContain("--force");
    });

    it("leaves --force off when the worktree owns no module store", async () => {
      await withoutModuleStore();
      stubRisk();
      createAndRegisterMonitor();

      await service.deleteWorktree("req-nomodules", "/test/worktree");

      expect(mockSendEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "delete-worktree-result", success: true })
      );
      expect(removeArgs()).not.toContain("--force");
    });

    it("still inventories when no module store exists, catching an old-form embedded repository", async () => {
      // An embedded `.git` DIRECTORY inside the submodule checkout owns its
      // objects without producing `<worktree gitdir>/modules`, so git raises no
      // refusal and an ordinary unforced remove would take the whole store.
      await withoutModuleStore();
      stubRisk({
        atRiskCommits: [{ oid: "feed0123abcd", subject: "embedded work" }],
      });
      createAndRegisterMonitor();

      await service.deleteWorktree("req-oldform", "/test/worktree");

      expect(failureError()).toContain("embedded work");
      expect(removeArgs()).toBeUndefined();
    });

    it("refuses dirty submodule content even when git would not have refused the removal", async () => {
      // The working-tree refusal used to sit behind the mechanical-force gate,
      // so an old-form embedded submodule — which produces no
      // `<worktree gitdir>/modules` and therefore no refusal from git — had its
      // modified and untracked files taken by a plain unforced delete.
      await withoutModuleStore();
      stubRisk({
        requiresMechanicalForce: false,
        dirtyFiles: ["vendor/lib/a.c"],
        untrackedFiles: ["vendor/lib/b.txt"],
      });
      createAndRegisterMonitor();

      await service.deleteWorktree("req-oldform-dirty", "/test/worktree");

      expect(failureError()).toContain("1 modified submodule file");
      expect(failureError()).toContain("1 untracked submodule file");
      expect(removeArgs()).toBeUndefined();
    });

    it("lets force discard old-form submodule content", async () => {
      await withoutModuleStore();
      stubRisk({ requiresMechanicalForce: false, dirtyFiles: ["vendor/lib/a.c"] });
      createAndRegisterMonitor();

      await service.deleteWorktree("req-oldform-forced", "/test/worktree", true);

      expect(mockSendEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "delete-worktree-result", success: true })
      );
      expect(removeArgs()).toBeDefined();
    });

    it("refuses an unforced delete that would destroy commits existing nowhere else", async () => {
      await withModuleStore();
      stubRisk({
        requiresMechanicalForce: true,
        atRiskCommits: [{ oid: "abc1234def5678", subject: "wip parser fix" }],
      });
      createAndRegisterMonitor();

      await service.deleteWorktree("req-atrisk", "/test/worktree");

      expect(failureError()).toContain("nowhere else");
      expect(failureError()).toContain("abc1234d");
      expect(failureError()).toContain("wip parser fix");
      expect(removeArgs()).toBeUndefined();
    });

    it("refuses at-risk commits even when the user passed force", async () => {
      // `force` means "discard uncommitted changes in the working tree"
      // everywhere it is offered, and bulk removal passes it for every selected
      // worktree — so it is not consent to lose commits that exist nowhere else.
      await withModuleStore();
      stubRisk({
        requiresMechanicalForce: true,
        atRiskCommits: [{ oid: "0badc0de1234", subject: "detached HEAD commit" }],
      });
      createAndRegisterMonitor();

      await service.deleteWorktree("req-forced-atrisk", "/test/worktree", true);

      expect(failureError()).toContain("detached HEAD commit");
      expect(removeArgs()).toBeUndefined();
    });

    it("refuses an unforced delete when the inventory could not be completed", async () => {
      await withModuleStore();
      stubRisk({ requiresMechanicalForce: true, incomplete: true });
      createAndRegisterMonitor();

      await service.deleteWorktree("req-incomplete", "/test/worktree");

      expect(failureError()).toContain("could not be inspected");
      expect(removeArgs()).toBeUndefined();
    });

    it("refuses an incomplete inventory even under force", async () => {
      // `incomplete` is set by a failed rev walk and a failed module-store scan
      // just as readily as by an unreadable working tree, so an empty
      // `atRiskCommits` beside it means "could not tell", not "nothing there".
      await withModuleStore();
      stubRisk({ requiresMechanicalForce: true, incomplete: true, dirtyFiles: ["vendor/lib/a.c"] });
      createAndRegisterMonitor();

      await service.deleteWorktree("req-forced-incomplete", "/test/worktree", true);

      expect(failureError()).toContain("could not be inspected");
      expect(removeArgs()).toBeUndefined();
    });

    it("lets force discard modified and untracked submodule files", async () => {
      // Those ARE working-tree changes, which is exactly what force consents to.
      await withModuleStore();
      stubRisk({
        requiresMechanicalForce: true,
        dirtyFiles: ["vendor/lib/a.c"],
        untrackedFiles: ["vendor/lib/b.txt"],
      });
      createAndRegisterMonitor();

      await service.deleteWorktree("req-forced-dirty", "/test/worktree", true);

      expect(mockSendEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "delete-worktree-result", success: true })
      );
      expect(removeArgs()).toContain("--force");
    });

    it("names dirty and untracked submodule content in the refusal", async () => {
      await withModuleStore();
      stubRisk({
        requiresMechanicalForce: true,
        dirtyFiles: ["vendor/lib/src/main.c"],
        untrackedFiles: ["vendor/lib/scratch.txt", "vendor/lib/notes.md"],
      });
      createAndRegisterMonitor();

      await service.deleteWorktree("req-dirty", "/test/worktree");

      expect(failureError()).toContain("1 modified submodule file");
      expect(failureError()).toContain("2 untracked submodule files");
    });

    it("re-reads the parent for real before adding the mechanical --force", async () => {
      await withModuleStore();
      stubRisk({ requiresMechanicalForce: true });
      const monitor = createAndRegisterMonitor();
      // Cached snapshot says clean (the monitor never polled); the fresh read
      // disagrees. Before the mechanical --force existed, git's own refusal was
      // the backstop for this.
      // Clean on the pre-teardown guard, dirty on the one immediately before the
      // remove — so this fails if the post-teardown re-check is dropped.
      let call = 0;
      vi.spyOn(monitor, "getFreshChanges").mockImplementation(async () => {
        call += 1;
        return {
          head: "abc123",
          isDirty: call > 1,
          stagedFileCount: 0,
          unstagedFileCount: call > 1 ? 1 : 0,
          untrackedFileCount: 0,
          conflictedFileCount: 0,
          changedFileCount: call > 1 ? 1 : 0,
          changes: [],
        } as any;
      });

      await service.deleteWorktree("req-toctou", "/test/worktree");

      expect(failureError()).toContain("uncommitted changes");
      expect(removeArgs()).toBeUndefined();
    });

    it("re-checks after teardown, and the later answer is the one that decides", async () => {
      await withModuleStore();
      const clean = {
        entries: [],
        dirtyFiles: [],
        untrackedFiles: [],
        atRiskCommits: [],
        requiresMechanicalForce: true,
        incomplete: false,
      } satisfies SubmoduleDeleteRisk;
      // Work appears in the window teardown opens. Only the post-teardown guard
      // can see it, so this fails if that call is dropped.
      const riskSpy = vi
        .spyOn(service as any, "inventorySubmoduleRisk")
        .mockResolvedValueOnce(clean)
        .mockResolvedValue({
          ...clean,
          atRiskCommits: [{ oid: "cafe12345678", subject: "landed mid-teardown" }],
        } satisfies SubmoduleDeleteRisk);
      const teardownSpy = vi.spyOn(service as any, "runLifecycleTeardown");
      createAndRegisterMonitor();

      await service.deleteWorktree("req-recheck", "/test/worktree");

      expect(riskSpy.mock.calls.length).toBe(2);
      expect(teardownSpy).toHaveBeenCalledTimes(1);
      expect(failureError()).toContain("landed mid-teardown");
      expect(removeArgs()).toBeUndefined();
    });

    /**
     * A checkout that is gone while one module store under
     * `<gitdir>/modules` outlived it — the #6669 prune branch with something at
     * stake.
     */
    async function withSurvivingModuleStore(): Promise<void> {
      const fsModule = await import("fs/promises");
      // `.code` matters: only ENOENT routes to the #6669 prune branch.
      vi.mocked(fsModule.access).mockRejectedValue(enoent());
      vi.mocked(fsModule.stat).mockImplementation(async (target: unknown) => {
        if (n(target as string) === MODULES_DIR) {
          return { isDirectory: () => true, isFile: () => false } as any;
        }
        throw enoent();
      });
      vi.mocked(fsModule.readdir).mockImplementation(async (target: unknown) => {
        const at = n(target as string);
        if (at === MODULES_DIR) return [dirent("vendor-lib", "dir")] as any;
        if (at === SURVIVING_STORE) {
          return [dirent("HEAD", "file"), dirent("objects", "dir")] as any;
        }
        throw enoent();
      });
    }

    /** Answers the surviving store's rev walk; every other git call keeps the default. */
    function withStoreRevWalk(result: string | Error): void {
      mockSimpleGit.raw.mockImplementation(async (args: unknown) => {
        if (Array.isArray(args) && args[0] === "--git-dir" && args[2] === "log") {
          if (result instanceof Error) throw result;
          return result;
        }
        return undefined;
      });
    }

    function pruneCallCount(): number {
      return mockSimpleGit.raw.mock.calls.filter(
        (c) => Array.isArray(c[0]) && c[0][0] === "worktree" && c[0][1] === "prune"
      ).length;
    }

    it("never runs the checkout inventory for a worktree whose folder is already gone", async () => {
      // The real `buildSubmoduleDeleteRisk` inventories FROM a checkout, so on a
      // missing one it answers `incomplete` — and routing that through the
      // checkout guard refused every phantom entry, putting the prune branch
      // (and the only in-app recovery for one) out of reach entirely.
      submoduleInventoryMocks.buildSubmoduleDeleteRisk.mockResolvedValue({
        entries: [],
        dirtyFiles: [],
        untrackedFiles: [],
        atRiskCommits: [],
        requiresMechanicalForce: false,
        incomplete: true,
      } satisfies SubmoduleDeleteRisk);
      const fsModule = await import("fs/promises");
      vi.mocked(fsModule.access).mockRejectedValue(enoent());
      createAndRegisterMonitor();

      await service.deleteWorktree("req-prune-phantom", "/test/worktree");

      expect(failureError()).toBeUndefined();
      expect(pruneCallCount()).toBe(1);
      expect(submoduleInventoryMocks.buildSubmoduleDeleteRisk).not.toHaveBeenCalled();
    });

    it("prunes a missing worktree whose surviving module stores hold nothing unique", async () => {
      // The stores existing is not itself a loss, and this branch is the only
      // in-app recovery for a phantom entry — so an empty rev walk lets it run.
      await withSurvivingModuleStore();
      withStoreRevWalk("");
      createAndRegisterMonitor();

      await service.deleteWorktree("req-prune-clean", "/test/worktree");

      expect(failureError()).toBeUndefined();
      expect(pruneCallCount()).toBe(1);
    });

    it("refuses to prune a missing worktree whose module stores hold commits existing nowhere else", async () => {
      // `worktree prune` removes `.git/worktrees/<id>`, so the module stores that
      // outlived the deleted checkout die with it — no dangling object, no
      // reflog, nothing for `fsck --lost-found`.
      await withSurvivingModuleStore();
      withStoreRevWalk(`beefcafe1234${US}stranded submodule work\n`);
      createAndRegisterMonitor();

      await service.deleteWorktree("req-prune-atrisk", "/test/worktree");

      expect(failureError()).toContain("stranded submodule work");
      expect(pruneCallCount()).toBe(0);
    });

    it("refuses those commits on the prune branch even under force", async () => {
      // The prune branch used to gate on nothing but "do the stores exist", so a
      // forced or bulk delete pruned surviving module repositories outright.
      // `force` consents to discarding a working tree, and here the working tree
      // is already gone — commits are all that is left.
      await withSurvivingModuleStore();
      withStoreRevWalk(`beefcafe1234${US}stranded submodule work\n`);
      createAndRegisterMonitor();

      await service.deleteWorktree("req-prune-forced-atrisk", "/test/worktree", true);

      expect(failureError()).toContain("stranded submodule work");
      expect(pruneCallCount()).toBe(0);
    });

    it("refuses to prune when a surviving module store could not be walked", async () => {
      await withSurvivingModuleStore();
      withStoreRevWalk(new Error("fatal: not a git repository"));
      createAndRegisterMonitor();

      await service.deleteWorktree("req-prune-unreadable", "/test/worktree");

      expect(failureError()).toContain("could not be inspected");
      expect(pruneCallCount()).toBe(0);
    });
  });

  describe("getSubmoduleDeleteRisk", () => {
    const cleanRisk: SubmoduleDeleteRisk = {
      entries: [],
      dirtyFiles: [],
      untrackedFiles: [],
      atRiskCommits: [],
      requiresMechanicalForce: false,
      incomplete: false,
    };

    it("returns null when no monitor exists for the id", async () => {
      await expect(service.getSubmoduleDeleteRisk("/nonexistent")).resolves.toBeNull();
    });

    it("inventories the monitor's own path", async () => {
      submoduleInventoryMocks.buildSubmoduleDeleteRisk.mockResolvedValue({
        ...cleanRisk,
        requiresMechanicalForce: true,
      });
      createAndRegisterMonitor();

      const risk = await service.getSubmoduleDeleteRisk("/test/worktree");

      expect(submoduleInventoryMocks.buildSubmoduleDeleteRisk).toHaveBeenCalledWith(
        "/test/worktree",
        expect.objectContaining({ signal: expect.anything() })
      );
      expect(risk?.requiresMechanicalForce).toBe(true);
      expect(risk?.incomplete).toBe(false);
    });

    it("surfaces a watchdog expiry as incomplete rather than rejecting", async () => {
      // A rejection here would reach the delete gate as "no risk data", which a
      // D2 preview renders as "nothing at stake". `incomplete` is the vocabulary
      // every caller already fails closed on.
      vi.useFakeTimers();
      try {
        submoduleInventoryMocks.buildSubmoduleDeleteRisk.mockReturnValue(new Promise(() => {}));
        createAndRegisterMonitor();

        const pending = service.getSubmoduleDeleteRisk("/test/worktree");
        await vi.advanceTimersByTimeAsync(60_000);

        await expect(pending).resolves.toMatchObject({
          incomplete: true,
          requiresMechanicalForce: false,
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
