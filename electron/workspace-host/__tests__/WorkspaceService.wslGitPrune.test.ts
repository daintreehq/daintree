import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { resolve as pathResolve } from "path";
import type { SimpleGit } from "simple-git";
import type { WorkspaceService } from "../WorkspaceService.js";
import type { WorktreeMonitor } from "../WorktreeMonitor.js";
import type { Worktree } from "../../../shared/types/worktree.js";

const TEST_WORKTREE_PATH = pathResolve("/test/worktree");

const { mockGetGitCommonDir, mockParcelSubscribe } = vi.hoisted(() => {
  const callbacks: Array<(err: Error | null, events: unknown[]) => void> = [];
  return {
    mockGetGitCommonDir: vi.fn<(arg: string) => string | null>().mockReturnValue(null),
    mockParcelSubscribe: vi.fn(
      (_dir: string, cb: (err: Error | null, events: unknown[]) => void) => {
        callbacks.push(cb);
        return Promise.resolve({ unsubscribe: vi.fn() });
      }
    ),
  };
});

vi.mock("@parcel/watcher", () => ({
  default: { subscribe: mockParcelSubscribe },
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
    cleanup: vi.fn(),
    refresh: vi.fn(),
    getStatus: vi.fn().mockReturnValue({
      state: "idle",
      isPolling: false,
      candidateCount: 0,
      resolvedCount: 0,
      isEnabled: true,
    }),
    setForgeSettings: vi.fn(),
  },
}));

const mockEvents = new EventEmitter();
vi.mock("../../services/events.js", () => ({ events: mockEvents }));

vi.mock("../../utils/gitFileWatcher.js", () => ({
  GitFileWatcher: class {
    start() {
      return Promise.resolve(false);
    }
    dispose() {}
  },
}));

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

vi.mock("child_process", () => ({ spawn: vi.fn() }));

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

describe("WorkspaceService WSL git opt-in pruning (#9926)", () => {
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

  describe("removeMonitor chokepoint", () => {
    it("emits clear-wsl-git-opt-in before worktree-removed when wsl entry exists", () => {
      createAndRegisterMonitor();
      service["wslGitByWorktree"][TEST_WORKTREE_PATH] = { enabled: true, dismissed: false };

      service["removeMonitor"](TEST_WORKTREE_PATH);

      expect(service["monitors"].has(TEST_WORKTREE_PATH)).toBe(false);
      expect(service["wslGitByWorktree"][TEST_WORKTREE_PATH]).toBeUndefined();

      const clearCall = mockSendEvent.mock.calls.find(
        ([arg]) => (arg as { type: string }).type === "clear-wsl-git-opt-in"
      );
      const removedCall = mockSendEvent.mock.calls.find(
        ([arg]) => (arg as { type: string }).type === "worktree-removed"
      );
      expect(clearCall).toBeDefined();
      expect(removedCall).toBeDefined();
      expect((clearCall![0] as { worktreeId: string }).worktreeId).toBe(TEST_WORKTREE_PATH);
      expect((removedCall![0] as { worktreeId: string }).worktreeId).toBe(TEST_WORKTREE_PATH);

      // clear must come before worktree-removed so main's persistent-store
      // prune races ahead of any renderer-driven refresh that consults the
      // worktree list.
      const clearIdx = mockSendEvent.mock.calls.indexOf(clearCall!);
      const removedIdx = mockSendEvent.mock.calls.indexOf(removedCall!);
      expect(clearIdx).toBeLessThan(removedIdx);
    });

    it("does not emit clear-wsl-git-opt-in when no wsl entry exists", () => {
      createAndRegisterMonitor();

      service["removeMonitor"](TEST_WORKTREE_PATH);

      const clearCalls = mockSendEvent.mock.calls.filter(
        ([arg]) => (arg as { type: string }).type === "clear-wsl-git-opt-in"
      );
      expect(clearCalls).toHaveLength(0);
      // worktree-removed still fires so the renderer's view stays consistent.
      const removedCalls = mockSendEvent.mock.calls.filter(
        ([arg]) => (arg as { type: string }).type === "worktree-removed"
      );
      expect(removedCalls).toHaveLength(1);
    });

    it("refuses to remove the main worktree monitor", () => {
      createAndRegisterMonitor({ isMainWorktree: true });
      service["wslGitByWorktree"][TEST_WORKTREE_PATH] = { enabled: true, dismissed: false };

      service["removeMonitor"](TEST_WORKTREE_PATH);

      // Monitor and wsl entry both untouched.
      expect(service["monitors"].has(TEST_WORKTREE_PATH)).toBe(true);
      expect(service["wslGitByWorktree"][TEST_WORKTREE_PATH]).toEqual({
        enabled: true,
        dismissed: false,
      });
      // Neither clear nor removed fires.
      const clearOrRemoved = mockSendEvent.mock.calls.filter(([arg]) =>
        ["clear-wsl-git-opt-in", "worktree-removed"].includes((arg as { type: string }).type)
      );
      expect(clearOrRemoved).toHaveLength(0);
    });

    it("is idempotent — calling twice on the same id is a no-op the second time", () => {
      createAndRegisterMonitor();
      service["wslGitByWorktree"][TEST_WORKTREE_PATH] = { enabled: true, dismissed: false };

      service["removeMonitor"](TEST_WORKTREE_PATH);
      mockSendEvent.mockClear();

      service["removeMonitor"](TEST_WORKTREE_PATH);

      // The second call sees no monitor in the map and returns early
      // (no clear event, no worktree-removed event).
      expect(mockSendEvent).not.toHaveBeenCalled();
    });
  });

  describe("syncMonitors stale-loop routes through removeMonitor", () => {
    it("prunes wsl entry + emits clear for monitors missing from the live list", async () => {
      createAndRegisterMonitor();
      service["wslGitByWorktree"][TEST_WORKTREE_PATH] = { enabled: true, dismissed: false };

      // Live list is empty — every existing monitor is stale.
      await service["syncMonitors"]([], null, "main", undefined, true);

      expect(service["monitors"].has(TEST_WORKTREE_PATH)).toBe(false);
      expect(service["wslGitByWorktree"][TEST_WORKTREE_PATH]).toBeUndefined();

      const clearCall = mockSendEvent.mock.calls.find(
        ([arg]) => (arg as { type: string }).type === "clear-wsl-git-opt-in"
      );
      expect(clearCall).toBeDefined();
      expect((clearCall![0] as { worktreeId: string }).worktreeId).toBe(TEST_WORKTREE_PATH);
    });
  });

  describe("pruneStaleWslGitEntries bulk self-heal (review #1)", () => {
    // The persisted `wslGitByWorktree` is a single global electron-store
    // record. Loading project A would otherwise prune project B's valid
    // opt-ins on every load/prewarm/restart. The bulk self-heal restricts
    // the walk to keys whose path is rooted at this project's parent dir.
    // Test the helper directly — going through full `loadProject` is too
    // tied to mocked git/topology side effects.

    it("does not emit clear-wsl-git-opt-in for keys belonging to other projects", () => {
      // Current project is /test/root. The persisted map carries one live
      // in-project entry and one foreign-project entry that would be
      // silently erased by an un-scoped self-heal.
      service["projectRootPath"] = "/test/root";
      service["wslGitByWorktree"] = {
        [TEST_WORKTREE_PATH]: { enabled: true, dismissed: false },
        "/other-projects/repo/wt": { enabled: true, dismissed: false },
      };

      const liveWorktree = createTestWorktree({ id: TEST_WORKTREE_PATH });
      service["pruneStaleWslGitEntries"]([liveWorktree]);

      // Foreign key is left untouched in the in-memory mirror (and therefore
      // no clear event is sent for it).
      expect(service["wslGitByWorktree"]["/other-projects/repo/wt"]).toEqual({
        enabled: true,
        dismissed: false,
      });
      const clearCalls = mockSendEvent.mock.calls.filter(
        ([arg]) => (arg as { type: string }).type === "clear-wsl-git-opt-in"
      );
      const clearWorktreeIds = clearCalls.map(
        ([arg]) => (arg as { worktreeId: string }).worktreeId
      );
      expect(clearWorktreeIds).not.toContain("/other-projects/repo/wt");
    });

    it("does emit clear-wsl-git-opt-in for stale keys inside the current project", () => {
      // The current project's parent dir is /test (parent of /test/root). A
      // stale key under /test/root/.worktrees (a former worktree) must
      // still be pruned.
      const staleProjectKey = "/test/root/.worktrees/old-feature";
      service["projectRootPath"] = "/test/root";
      service["wslGitByWorktree"] = {
        [TEST_WORKTREE_PATH]: { enabled: true, dismissed: false },
        [staleProjectKey]: { enabled: true, dismissed: false },
      };

      const liveWorktree = createTestWorktree({ id: TEST_WORKTREE_PATH });
      service["pruneStaleWslGitEntries"]([liveWorktree]);

      // The stale in-project key is pruned; the live key stays.
      expect(service["wslGitByWorktree"][staleProjectKey]).toBeUndefined();
      expect(service["wslGitByWorktree"][TEST_WORKTREE_PATH]).toEqual({
        enabled: true,
        dismissed: false,
      });

      const clearCalls = mockSendEvent.mock.calls.filter(
        ([arg]) => (arg as { type: string }).type === "clear-wsl-git-opt-in"
      );
      const clearWorktreeIds = clearCalls.map(
        ([arg]) => (arg as { worktreeId: string }).worktreeId
      );
      expect(clearWorktreeIds).toContain(staleProjectKey);
    });

    it("handles Windows-style stale keys without relying on the host OS separator", () => {
      const liveKey = "C:\\test\\root";
      const staleProjectKey = "C:\\test\\root\\.worktrees\\old-feature";
      const foreignProjectKey = "D:\\other-projects\\repo\\wt";
      service["projectRootPath"] = liveKey;
      service["wslGitByWorktree"] = {
        [liveKey]: { enabled: true, dismissed: false },
        [staleProjectKey]: { enabled: true, dismissed: false },
        [foreignProjectKey]: { enabled: true, dismissed: false },
      };

      const liveWorktree = createTestWorktree({ id: liveKey });
      service["pruneStaleWslGitEntries"]([liveWorktree]);

      expect(service["wslGitByWorktree"][staleProjectKey]).toBeUndefined();
      expect(service["wslGitByWorktree"][liveKey]).toEqual({
        enabled: true,
        dismissed: false,
      });
      expect(service["wslGitByWorktree"][foreignProjectKey]).toEqual({
        enabled: true,
        dismissed: false,
      });

      const clearCalls = mockSendEvent.mock.calls.filter(
        ([arg]) => (arg as { type: string }).type === "clear-wsl-git-opt-in"
      );
      const clearWorktreeIds = clearCalls.map(
        ([arg]) => (arg as { worktreeId: string }).worktreeId
      );
      expect(clearWorktreeIds).toContain(staleProjectKey);
      expect(clearWorktreeIds).not.toContain(foreignProjectKey);
    });
  });
});
