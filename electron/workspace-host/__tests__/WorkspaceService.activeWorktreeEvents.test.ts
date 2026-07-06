import { EventEmitter } from "events";
import { resolve as pathResolve } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SimpleGit } from "simple-git";
import type { WorkspaceService } from "../WorkspaceService.js";
import type { WorktreeMonitor } from "../WorktreeMonitor.js";
import type { Worktree } from "../../../shared/types/worktree.js";
import type { WorkspaceHostEvent } from "../../../shared/types/workspace-host.js";

const mockSimpleGit = {
  raw: vi.fn().mockResolvedValue(undefined),
  branch: vi.fn().mockResolvedValue({ current: "main" }),
};

vi.mock("simple-git", () => ({
  simpleGit: vi.fn(() => mockSimpleGit),
}));

const waitForPathExistsMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../../utils/fs.js", () => ({
  waitForPathExists: waitForPathExistsMock,
}));

vi.mock("../../utils/hardenedGit.js", () => ({
  createHardenedGit: vi.fn(() => mockSimpleGit),
  createAuthenticatedGit: vi.fn(() => mockSimpleGit),
  validateBranchName: vi.fn(),
}));

vi.mock("../../utils/git.js", () => ({
  invalidateGitStatusCache: vi.fn(),
}));

vi.mock("../../utils/gitUtils.js", () => ({
  getGitDir: vi.fn().mockReturnValue("/test/worktree/.git"),
  // null → the post-reconcile watcher self-heal (ensureTopologyWatcherAlive)
  // no-ops, keeping these tests focused on event ordering.
  getGitCommonDir: vi.fn().mockResolvedValue(null),
  clearGitDirCache: vi.fn(),
  clearGitCommonDirCache: vi.fn(),
}));

vi.mock("../../services/issueExtractor.js", () => ({
  extractIssueNumberSync: vi.fn().mockReturnValue(null),
  extractIssueNumber: vi.fn().mockResolvedValue(null),
  deriveIssueTitleFromBranch: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../services/worktree/mood.js", () => ({
  categorizeWorktree: vi.fn().mockReturnValue("stable"),
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

vi.mock("fs/promises", () => ({
  stat: vi.fn().mockRejectedValue(new Error("ENOENT")),
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
  cp: vi.fn().mockResolvedValue(undefined),
  realpath: vi.fn().mockImplementation((p: string) => Promise.resolve(p)),
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

vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

function createTestWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: pathResolve("/test/worktree"),
    path: pathResolve("/test/worktree"),
    name: "feature/test",
    branch: "feature/test",
    isCurrent: false,
    isMainWorktree: false,
    gitDir: "/test/worktree/.git",
    ...overrides,
  };
}

describe("WorkspaceService active-worktree event emission (#9945)", () => {
  let service: WorkspaceService;
  let mockSendEvent: ReturnType<typeof vi.fn>;
  let sentEvents: WorkspaceHostEvent[];
  let WorktreeMonitorClass: typeof WorktreeMonitor;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSimpleGit.raw.mockReset().mockResolvedValue(undefined);
    mockSimpleGit.branch.mockReset().mockResolvedValue({ current: "main" });
    waitForPathExistsMock.mockReset().mockResolvedValue(undefined);

    sentEvents = [];
    mockSendEvent = vi.fn((event: WorkspaceHostEvent) => {
      sentEvents.push(event);
    });

    const WorkspaceServiceModule = await import("../WorkspaceService.js");
    service = new WorkspaceServiceModule.WorkspaceService(mockSendEvent as any);

    const WorktreeMonitorModule = await import("../WorktreeMonitor.js");
    WorktreeMonitorClass = WorktreeMonitorModule.WorktreeMonitor;

    service["projectRootPath"] = "/test/root";
    service["git"] = mockSimpleGit as any;
    service["listService"].setGit(mockSimpleGit as unknown as SimpleGit, "/test/root");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockEvents.removeAllListeners();
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

  function eventOfType<T extends WorkspaceHostEvent["type"]>(
    type: T
  ): Extract<WorkspaceHostEvent, { type: T }> | undefined {
    return sentEvents.find((e) => e.type === type) as
      | Extract<WorkspaceHostEvent, { type: T }>
      | undefined;
  }

  function indexOfEvent(type: WorkspaceHostEvent["type"]): number {
    return sentEvents.findIndex((e) => e.type === type);
  }

  it("emits worktree-activated when setActiveWorktree is called directly (Main-originated IPC path)", () => {
    const mainMonitor = createAndRegisterMonitor({
      id: pathResolve("/test/main"),
      path: pathResolve("/test/main"),
      isMainWorktree: true,
    });
    createAndRegisterMonitor({
      id: pathResolve("/test/active"),
      path: pathResolve("/test/active"),
    });
    service["activeWorktreeId"] = null;

    service["setActiveWorktree"]("port-1", pathResolve("/test/main"));

    const activated = eventOfType("worktree-activated");
    expect(activated).toBeDefined();
    expect(activated?.worktreeId).toBe(pathResolve("/test/main"));
    expect(activated?.epoch).toBe(service["epoch"]);
    expect(typeof activated?.seq).toBe("number");
    // The new event is emitted BEFORE the existing set-active-result so the
    // renderer's MessagePort listener fires in the same synchronous hop.
    const activatedIdx = indexOfEvent("worktree-activated");
    const resultIdx = indexOfEvent("set-active-result");
    expect(activatedIdx).toBeGreaterThanOrEqual(0);
    expect(resultIdx).toBeGreaterThanOrEqual(0);
    expect(activatedIdx).toBeLessThan(resultIdx);
    // Sanity: the main monitor's isCurrent flips on.
    expect(mainMonitor.isCurrent).toBe(true);
  });

  it("propagates the silent flag from the originating set-active request (#9945)", () => {
    createAndRegisterMonitor({
      id: pathResolve("/test/main"),
      path: pathResolve("/test/main"),
      isMainWorktree: true,
    });
    service["activeWorktreeId"] = null;

    service["setActiveWorktree"]("port-1", pathResolve("/test/main"), { silent: true });

    const activated = eventOfType("worktree-activated");
    expect(activated).toBeDefined();
    expect(activated?.silent).toBe(true);

    // Default (no options) leaves silent undefined.
    service["setActiveWorktree"]("port-2", pathResolve("/test/main"));
    const activatedDefault = sentEvents.filter((e) => e.type === "worktree-activated").at(-1);
    expect(activatedDefault?.silent).toBeUndefined();
  });

  it("rejects unknown worktree ids with success:false and does not emit worktree-activated", () => {
    createAndRegisterMonitor({
      id: pathResolve("/test/main"),
      path: pathResolve("/test/main"),
      isMainWorktree: true,
    });
    const unknownId = pathResolve("/test/does-not-exist");
    service["activeWorktreeId"] = null;

    service["setActiveWorktree"]("port-bad", unknownId);

    // No worktree-activated event for an unknown id — the per-view renderer
    // would otherwise call selectWorktree(unknown) and leave the sidebar in
    // a half-state.
    expect(eventOfType("worktree-activated")).toBeUndefined();
    // The IPC contract still receives a set-active-result so the caller
    // learns the activation was rejected.
    const result = eventOfType("set-active-result");
    expect(result).toBeDefined();
    expect(result?.success).toBe(false);
    expect(result?.requestId).toBe("port-bad");
    // activeWorktreeId is untouched.
    expect(service["activeWorktreeId"]).toBeNull();
  });

  it("auto-switch in runTopologyReconcile emits worktree-removed then worktree-activated, in that order (#9945)", async () => {
    // Register main + active worktrees.
    const mainPath = pathResolve("/test/main");
    const activePath = pathResolve("/test/active");
    createAndRegisterMonitor({ id: mainPath, path: mainPath, isMainWorktree: true });
    createAndRegisterMonitor({ id: activePath, path: activePath, isCurrent: true });
    service["activeWorktreeId"] = activePath;

    // Mock discoverAndSyncWorktrees to drop the active monitor and emit
    // worktree-removed in the same pass (matches what syncMonitors does in
    // the prune loop at line 605).
    vi.spyOn(service as any, "discoverAndSyncWorktrees").mockImplementation(async () => {
      const monitor = service["monitors"].get(activePath);
      if (monitor) {
        service["activeWorktreeId"] = null;
        service.resourceActionExecutor["cleanupResourceActionState"](activePath);
        monitor.stop();
        service["monitors"].delete(activePath);
        service["sendEvent"]({
          type: "worktree-removed",
          worktreeId: activePath,
          epoch: service["epoch"],
          seq: service["nextSeq"](),
        });
      }
    });

    await service["runTopologyReconcile"]();

    const removedIdx = indexOfEvent("worktree-removed");
    const activatedIdx = indexOfEvent("worktree-activated");
    expect(removedIdx).toBeGreaterThanOrEqual(0);
    expect(activatedIdx).toBeGreaterThanOrEqual(0);
    // worktree-removed must fire BEFORE worktree-activated so the renderer's
    // per-view store clears activeWorktreeId first, then re-selects main.
    expect(removedIdx).toBeLessThan(activatedIdx);

    const activated = eventOfType("worktree-activated");
    expect(activated?.worktreeId).toBe(mainPath);
    expect(activated?.epoch).toBe(service["epoch"]);
    expect(typeof activated?.seq).toBe("number");

    // Both events carry the same epoch and monotonically-increasing seqs.
    const removed = eventOfType("worktree-removed");
    expect(removed?.epoch).toBe(activated?.epoch);
    expect(removed?.seq).toBeLessThan(activated?.seq as number);
  });

  it("does not emit worktree-activated when the topology reconcile auto-switch condition is not met", async () => {
    // No previous active worktree — nothing to auto-switch from.
    createAndRegisterMonitor({
      id: pathResolve("/test/main"),
      path: pathResolve("/test/main"),
      isMainWorktree: true,
    });
    service["activeWorktreeId"] = null;

    vi.spyOn(service as any, "discoverAndSyncWorktrees").mockResolvedValue(undefined);

    await service["runTopologyReconcile"]();

    expect(eventOfType("worktree-activated")).toBeUndefined();
    expect(eventOfType("worktree-removed")).toBeUndefined();
  });
});
