import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import type { WorkspaceService } from "../WorkspaceService.js";
import type { WorktreeMonitor } from "../WorktreeMonitor.js";
import type { Worktree } from "../../../shared/types/worktree.js";

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

const mockEvents = new EventEmitter();
vi.mock("../../services/events.js", () => ({
  events: mockEvents,
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

describe("WorkspaceService external worktree removal", () => {
  let service: WorkspaceService;
  let mockSendEvent: ReturnType<typeof vi.fn>;
  let WorktreeMonitorClass: typeof WorktreeMonitor;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSimpleGit.raw.mockReset().mockResolvedValue(undefined);
    mockSimpleGit.branch.mockReset().mockResolvedValue({ current: "main" });
    mockSendEvent = vi.fn();

    const WorkspaceServiceModule = await import("../WorkspaceService.js");
    service = new WorkspaceServiceModule.WorkspaceService(mockSendEvent as any);

    const WorktreeMonitorModule = await import("../WorktreeMonitor.js");
    WorktreeMonitorClass = WorktreeMonitorModule.WorktreeMonitor;

    service["projectRootPath"] = "/test/root";
    service["git"] = mockSimpleGit as any;
    service["listService"].setGit(mockSimpleGit as any, "/test/root");
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

  describe("discoverAndSyncWorktrees() prune-before-list (#6669)", () => {
    it("prunes before listing so externally-deleted worktrees clear from the sidebar", async () => {
      createAndRegisterMonitor();
      expect(service["monitors"].has("/test/worktree")).toBe(true);

      const callOrder: string[] = [];
      mockSimpleGit.raw.mockImplementation(async (args: string[]) => {
        callOrder.push(args.join(" "));
        if (args[0] === "worktree" && args[1] === "list") {
          // Post-prune list: phantom worktree is gone, only main remains.
          return [
            "worktree /test/root",
            "HEAD aaaaaaaaaaaaaaaaaaaa",
            "branch refs/heads/main",
            "",
          ].join("\n");
        }
        return undefined;
      });

      // Force the list cache to be re-fetched (forceRefresh: true bypasses
      // it anyway, but ensure no stale entry leaks through).
      service["listService"].invalidateCache();

      await service["discoverAndSyncWorktrees"]();

      const pruneIdx = callOrder.findIndex((c) => c.startsWith("worktree prune"));
      const listIdx = callOrder.findIndex((c) => c.startsWith("worktree list"));
      expect(pruneIdx).toBeGreaterThanOrEqual(0);
      expect(listIdx).toBeGreaterThanOrEqual(0);
      expect(pruneIdx).toBeLessThan(listIdx);

      expect(service["monitors"].has("/test/worktree")).toBe(false);
      expect(mockSendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "worktree-removed",
          worktreeId: "/test/worktree",
        })
      );
    });
  });

  describe("handleExternalWorktreeRemoval()", () => {
    it("removes non-main worktree and emits removal event", () => {
      createAndRegisterMonitor();

      service["handleExternalWorktreeRemoval"]("/test/worktree");

      expect(mockSendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "worktree-removed",
          worktreeId: "/test/worktree",
        })
      );
      expect(service["monitors"].has("/test/worktree")).toBe(false);
    });

    it("does not remove main worktree", () => {
      createAndRegisterMonitor({ isMainWorktree: true });

      service["handleExternalWorktreeRemoval"]("/test/worktree");

      expect(service["monitors"].has("/test/worktree")).toBe(true);
      expect(mockSendEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "worktree-removed" })
      );
    });
  });
});
