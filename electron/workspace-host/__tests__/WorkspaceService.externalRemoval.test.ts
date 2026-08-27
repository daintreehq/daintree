import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { resolve as pathResolve } from "path";
import type { SimpleGit } from "simple-git";
import type { WorkspaceService } from "../WorkspaceService.js";
import type { WorktreeMonitor } from "../WorktreeMonitor.js";
import type { Worktree } from "../../../shared/types/worktree.js";

const TEST_WORKTREE_PATH = pathResolve("/test/worktree");

const { mockGetGitCommonDir, mockParcelSubscribe } = vi.hoisted(() => {
  return {
    mockGetGitCommonDir: vi.fn<(arg: string) => string | null>().mockReturnValue(null),
    mockParcelSubscribe: vi.fn(() => Promise.resolve({ unsubscribe: vi.fn() })),
  };
});

vi.mock("@parcel/watcher", () => ({
  default: {
    subscribe: mockParcelSubscribe,
  },
}));

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
  getGitCommonDir: mockGetGitCommonDir,
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

const mockEvents = new EventEmitter();
vi.mock("../../services/events.js", () => ({
  events: mockEvents,
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

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    existsSync: vi.fn((p: unknown) => {
      if (typeof p === "string" && p.endsWith("/worktrees")) return true;
      return (actual.existsSync as (p: unknown) => boolean)(p);
    }),
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
    id: TEST_WORKTREE_PATH,
    path: TEST_WORKTREE_PATH,
    name: "feature/test",
    branch: "feature/test",
    isCurrent: false,
    isMainWorktree: false,
    gitDir: `${TEST_WORKTREE_PATH}/.git`,
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
    // Stands in for the completed `loadProject` these tests skip. Since #11922
    // only a proven repository gets monitors, so the probe verdict has to be
    // part of the primed state rather than left at its `null` default.
    service["gitBacked"] = true;
    service["listService"].setGit(mockSimpleGit as unknown as SimpleGit, "/test/root");
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

  describe("discoverAndSyncWorktrees() conditional prune (#6669)", () => {
    it("prunes and re-lists when the list carries a prunable entry, clearing externally-deleted worktrees", async () => {
      createAndRegisterMonitor();
      expect(service["monitors"].has(TEST_WORKTREE_PATH)).toBe(true);

      const callOrder: string[] = [];
      let pruned = false;
      mockSimpleGit.raw.mockImplementation(async (args: string[]) => {
        callOrder.push(args.join(" "));
        if (args[0] === "worktree" && args[1] === "prune") {
          pruned = true;
          return undefined;
        }
        if (args[0] === "worktree" && args[1] === "list") {
          if (pruned) {
            // Post-prune list: phantom worktree is gone, only main remains.
            return [
              "worktree /test/root",
              "HEAD aaaaaaaaaaaaaaaaaaaa",
              "branch refs/heads/main",
              "",
            ].join("\n");
          }
          // Pre-prune list: Git 2.31+ keeps the externally-deleted worktree
          // in the porcelain output with a `prunable` marker.
          return [
            "worktree /test/root",
            "HEAD aaaaaaaaaaaaaaaaaaaa",
            "branch refs/heads/main",
            "",
            `worktree ${TEST_WORKTREE_PATH}`,
            "HEAD bbbbbbbbbbbbbbbbbbbb",
            "branch refs/heads/feature",
            "prunable gitdir file points to non-existent location",
            "",
          ].join("\n");
        }
        return undefined;
      });

      // Force the list cache to be re-fetched (forceRefresh: true bypasses
      // it anyway, but ensure no stale entry leaks through).
      service["listService"].invalidateCache();

      await service["discoverAndSyncWorktrees"]();

      // List-first, prune only on a prunable marker, then re-list so the
      // sync sees the cleaned topology.
      const firstListIdx = callOrder.findIndex((c) => c.startsWith("worktree list"));
      const pruneIdx = callOrder.findIndex((c) => c.startsWith("worktree prune"));
      const secondListIdx = callOrder.findIndex(
        (c, i) => i > pruneIdx && c.startsWith("worktree list")
      );
      expect(firstListIdx).toBeGreaterThanOrEqual(0);
      expect(pruneIdx).toBeGreaterThan(firstListIdx);
      expect(secondListIdx).toBeGreaterThan(pruneIdx);

      expect(service["monitors"].has(TEST_WORKTREE_PATH)).toBe(false);
      expect(mockSendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "worktree-removed",
          worktreeId: TEST_WORKTREE_PATH,
        })
      );
    });

    it("skips the prune spawn entirely on a quiet cycle with nothing prunable", async () => {
      const callOrder: string[] = [];
      mockSimpleGit.raw.mockImplementation(async (args: string[]) => {
        callOrder.push(args.join(" "));
        if (args[0] === "worktree" && args[1] === "list") {
          return [
            "worktree /test/root",
            "HEAD aaaaaaaaaaaaaaaaaaaa",
            "branch refs/heads/main",
            "",
          ].join("\n");
        }
        return undefined;
      });

      service["listService"].invalidateCache();
      await service["discoverAndSyncWorktrees"]();

      expect(callOrder.some((c) => c.startsWith("worktree list"))).toBe(true);
      expect(callOrder.some((c) => c.startsWith("worktree prune"))).toBe(false);
    });
  });

  describe("discoverAndSyncWorktrees() prune failure handling (#6669)", () => {
    it("continues refresh when 'git worktree prune' itself fails", async () => {
      createAndRegisterMonitor();

      let listCalled = false;
      mockSimpleGit.raw.mockImplementation(async (args: string[]) => {
        if (args[0] === "worktree" && args[1] === "prune") {
          throw new Error("fatal: failed to prune (EPERM)");
        }
        if (args[0] === "worktree" && args[1] === "list") {
          listCalled = true;
          // List still includes the registered monitor — refresh succeeds,
          // sync runs, monitor remains registered (no phantom to clean up).
          return [
            "worktree /test/root",
            "HEAD aaaaaaaaaaaaaaaaaaaa",
            "branch refs/heads/main",
            "",
            "worktree /test/worktree",
            "HEAD bbbbbbbbbbbbbbbbbbbb",
            "branch refs/heads/feature/test",
            "",
          ].join("\n");
        }
        return undefined;
      });

      service["listService"].invalidateCache();

      await expect(service["discoverAndSyncWorktrees"]()).resolves.not.toThrow();
      expect(listCalled).toBe(true);
      expect(service["monitors"].has(TEST_WORKTREE_PATH)).toBe(true);
    });
  });

  describe("handleExternalWorktreeRemoval()", () => {
    it("removes non-main worktree and emits removal event", () => {
      createAndRegisterMonitor();

      service["handleExternalWorktreeRemoval"](TEST_WORKTREE_PATH);

      expect(mockSendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "worktree-removed",
          worktreeId: TEST_WORKTREE_PATH,
        })
      );
      expect(service["monitors"].has(TEST_WORKTREE_PATH)).toBe(false);
    });

    it("does not remove main worktree", () => {
      createAndRegisterMonitor({ isMainWorktree: true });

      service["handleExternalWorktreeRemoval"](TEST_WORKTREE_PATH);

      expect(service["monitors"].has(TEST_WORKTREE_PATH)).toBe(true);
      expect(mockSendEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "worktree-removed" })
      );
    });
  });

  describe("same-path re-creation (#11994)", () => {
    // A worktree id is its path, so a delete-then-create at the same location
    // reuses it. The monitor incarnation is the only thing that distinguishes
    // the two, both for the renderer's tombstone and for fencing continuations
    // still running against the torn-down monitor.
    it("mints a higher incarnation for the replacement and stamps the removal with the old one", async () => {
      await service["addNewWorktreeMonitor"](createTestWorktree(), false, true);
      const first = service["monitors"].get(TEST_WORKTREE_PATH);

      service["removeMonitor"](TEST_WORKTREE_PATH);

      expect(mockSendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "worktree-removed",
          worktreeId: TEST_WORKTREE_PATH,
          generation: first?.generation,
        })
      );

      await service["addNewWorktreeMonitor"](createTestWorktree(), false, true);
      const second = service["monitors"].get(TEST_WORKTREE_PATH);

      expect(second).not.toBe(first);
      expect(second!.generation).toBeGreaterThan(first!.generation);
      expect(second!.getSnapshot().generation).toBe(second!.generation);
    });

    it("ignores a torn-down monitor's removal callback for the worktree that replaced it", async () => {
      await service["addNewWorktreeMonitor"](createTestWorktree(), false, true);
      const first = service["monitors"].get(TEST_WORKTREE_PATH)!;
      service["removeMonitor"](TEST_WORKTREE_PATH);
      await service["addNewWorktreeMonitor"](createTestWorktree(), false, true);
      const second = service["monitors"].get(TEST_WORKTREE_PATH)!;
      mockSendEvent.mockClear();

      // The old monitor's watcher finally fires. Resolving by id alone would
      // find — and delete — the live worktree the user just created.
      service["handleExternalWorktreeRemoval"](TEST_WORKTREE_PATH, first);

      expect(service["monitors"].get(TEST_WORKTREE_PATH)).toBe(second);
      expect(mockSendEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "worktree-removed" })
      );
    });
  });

  describe("periodic safety-net timer (#8510)", () => {
    it("clears a phantom monitor end-to-end when the interval fires", async () => {
      createAndRegisterMonitor();
      expect(service["monitors"].has(TEST_WORKTREE_PATH)).toBe(true);

      mockSimpleGit.raw.mockImplementation(async (args: string[]) => {
        if (args[0] === "worktree" && args[1] === "list") {
          // Post-prune list: the externally-removed worktree is gone.
          return [
            "worktree /test/root",
            "HEAD aaaaaaaaaaaaaaaaaaaa",
            "branch refs/heads/main",
            "",
          ].join("\n");
        }
        return undefined;
      });
      service["listService"].invalidateCache();

      vi.useFakeTimers();
      service["topologyWatcher"]["startSafetyTimer"]();
      await vi.advanceTimersByTimeAsync(90_000);

      expect(service["monitors"].has(TEST_WORKTREE_PATH)).toBe(false);
      expect(mockSendEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "worktree-removed", worktreeId: TEST_WORKTREE_PATH })
      );

      vi.useRealTimers();
    });

    it("restarts symmetrically across a setPollingEnabled pause/resume cycle", async () => {
      vi.useFakeTimers();
      try {
        const reconcileSpy = vi
          .spyOn(service["topologyWatcher"], "scheduleReconcile")
          .mockImplementation(() => {});

        service["topologyWatcher"]["startSafetyTimer"]();
        service.setPollingEnabled(false);
        expect(service["topologyWatcher"]["periodicSafetyTimer"]).toBeNull();

        await vi.advanceTimersByTimeAsync(90_000);
        expect(reconcileSpy).not.toHaveBeenCalled();

        service.setPollingEnabled(true);
        // setPollingEnabled(true) also fires an immediate reconcile; clear it
        // so the assertion isolates the restarted timer's tick.
        reconcileSpy.mockClear();
        await vi.advanceTimersByTimeAsync(90_000);
        expect(reconcileSpy).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
