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
    mockSendEvent = vi.fn();

    const WorkspaceServiceModule = await import("../WorkspaceService.js");
    service = new WorkspaceServiceModule.WorkspaceService(mockSendEvent as any);

    const WorktreeMonitorModule = await import("../WorktreeMonitor.js");
    WorktreeMonitorClass = WorktreeMonitorModule.WorktreeMonitor;

    service["projectRootPath"] = "/test/root";
    service["projectScopeId"] = "test-scope";
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
    monitor.setProjectScopeId("test-scope");
    service["monitors"].set(wt.id, monitor);
    return monitor;
  }

  it("sends delete-worktree-result success after removing monitor", async () => {
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
      if (n(p as string).endsWith("/test/root/.canopy/config.json")) return undefined;
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
      if (n(p as string).endsWith("/test/root/.canopy/config.json")) return undefined;
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
          if (event === "close") setTimeout(() => cb(1), 0);
        }),
        kill: vi.fn(),
      };
      return child as any;
    });

    createAndRegisterMonitor();

    await service.deleteWorktree("req-5", "/test/worktree");

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

    createAndRegisterMonitor();

    await service.deleteWorktree("req-6", "/test/worktree");

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "delete-worktree-result", success: true })
    );
  });
});
