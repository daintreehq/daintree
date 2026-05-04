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
});
