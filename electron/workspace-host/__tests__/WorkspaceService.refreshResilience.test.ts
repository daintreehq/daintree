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
  validateBranchName: vi.fn(),
}));

vi.mock("../../utils/git.js", () => ({
  invalidateGitStatusCache: vi.fn(),
  getWorktreeChangesWithStats: vi.fn().mockResolvedValue({
    head: "abc123",
    isDirty: false,
    changedFileCount: 0,
    changes: [],
    lastUpdated: 0,
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
      recordNoChange: vi.fn(),
    };
  }),
  NoteFileReader: vi.fn(function () {
    return { read: vi.fn().mockResolvedValue({}) };
  }),
}));

const mockPullRequestService = {
  initialize: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  reset: vi.fn(),
  refresh: vi.fn().mockResolvedValue(undefined),
  getStatus: vi.fn().mockReturnValue({
    state: "idle",
    isPolling: false,
    candidateCount: 0,
    resolvedCount: 0,
    isEnabled: true,
  }),
};

vi.mock("../../services/PullRequestService.js", () => ({
  pullRequestService: mockPullRequestService,
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

describe("WorkspaceService refresh resilience (escape hatch)", () => {
  let service: WorkspaceService;
  let mockSendEvent: ReturnType<typeof vi.fn>;
  let WorktreeMonitorClass: typeof WorktreeMonitor;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSendEvent = vi.fn();

    const WorkspaceServiceModule = await import("../WorkspaceService.js");
    service = new WorkspaceServiceModule.WorkspaceService(mockSendEvent as never);

    const WorktreeMonitorModule = await import("../WorktreeMonitor.js");
    WorktreeMonitorClass = WorktreeMonitorModule.WorktreeMonitor;

    service["projectRootPath"] = "/test/root";
    service["git"] = mockSimpleGit as never;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function registerMonitor(id: string): WorktreeMonitor {
    const monitor = new WorktreeMonitorClass(
      createTestWorktree({ id, path: id, gitDir: `${id}/.git` }),
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
    service["monitors"].set(id, monitor);
    monitor.start();
    return monitor;
  }

  it("reports success and refreshes every worktree even when one worktree's refresh rejects", async () => {
    const m1 = registerMonitor("/test/wt-1");
    const m2 = registerMonitor("/test/wt-2");
    vi.spyOn(service as any, "discoverAndSyncWorktrees").mockResolvedValue(undefined);
    const r1 = vi.spyOn(m1, "refresh").mockRejectedValue(new Error("wt-1 git stalled"));
    const r2 = vi.spyOn(m2, "refresh").mockResolvedValue(undefined);

    await service.refresh("req-1");

    // The failing worktree must not abort the others (allSettled, not all).
    expect(r1).toHaveBeenCalledTimes(1);
    expect(r2).toHaveBeenCalledTimes(1);
    expect(mockSendEvent).toHaveBeenCalledWith({
      type: "refresh-result",
      requestId: "req-1",
      success: true,
    });
  });

  it("still refreshes worktree status when topology re-discovery fails", async () => {
    const m1 = registerMonitor("/test/wt-1");
    vi.spyOn(service as any, "discoverAndSyncWorktrees").mockRejectedValue(
      new Error("worktree list stalled")
    );
    const r1 = vi.spyOn(m1, "refresh").mockResolvedValue(undefined);

    await service.refresh("req-2");

    // discover failed, but the per-monitor status refresh still ran and the
    // request still resolved successfully — the button is never a hard no-op.
    expect(r1).toHaveBeenCalledTimes(1);
    expect(mockSendEvent).toHaveBeenCalledWith({
      type: "refresh-result",
      requestId: "req-2",
      success: true,
    });
  });

  it("still reports success when the PR refresh rejects", async () => {
    const m1 = registerMonitor("/test/wt-1");
    vi.spyOn(service as any, "discoverAndSyncWorktrees").mockResolvedValue(undefined);
    vi.spyOn(m1, "refresh").mockResolvedValue(undefined);
    mockPullRequestService.refresh.mockRejectedValueOnce(new Error("rate limited"));

    await service.refresh("req-3");

    expect(mockSendEvent).toHaveBeenCalledWith({
      type: "refresh-result",
      requestId: "req-3",
      success: true,
    });
  });
});

describe("WorkspaceService.scheduleTopologyReconcile force / recovery", () => {
  let service: WorkspaceService;
  let reconcileSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const WorkspaceServiceModule = await import("../WorkspaceService.js");
    service = new WorkspaceServiceModule.WorkspaceService(vi.fn() as never);
    service["projectRootPath"] = "/test/root";
    service["git"] = mockSimpleGit as never;
    reconcileSpy = vi.spyOn(service as any, "runTopologyReconcile").mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("force bypasses the post-reconcile cooldown; non-force coalesces", async () => {
    service["topologyWatchCooldownUntil"] = Date.now() + 60_000;

    service.scheduleTopologyReconcile(false);
    await service["topologyReconcileQueue"].onIdle();
    expect(reconcileSpy).not.toHaveBeenCalled();
    expect(service["topologyWatchCooldownDirty"]).toBe(true);

    service.scheduleTopologyReconcile(true);
    await service["topologyReconcileQueue"].onIdle();
    expect(reconcileSpy).toHaveBeenCalledTimes(1);
  });

  it("force bypasses the pollingEnabled gate that silences background reconciles", async () => {
    service["pollingEnabled"] = false;

    service.scheduleTopologyReconcile(false);
    await service["topologyReconcileQueue"].onIdle();
    expect(reconcileSpy).not.toHaveBeenCalled();

    service.scheduleTopologyReconcile(true);
    await service["topologyReconcileQueue"].onIdle();
    expect(reconcileSpy).toHaveBeenCalledTimes(1);
  });

  it("clears the pending flag after a reconcile so the next one can run", async () => {
    service.scheduleTopologyReconcile(true);
    await service["topologyReconcileQueue"].onIdle();
    expect(service["topologyReconcilePending"]).toBe(false);

    service.scheduleTopologyReconcile(true);
    await service["topologyReconcileQueue"].onIdle();
    expect(reconcileSpy).toHaveBeenCalledTimes(2);
  });

  it("clears the pending flag even when the reconcile hangs (watchdog)", async () => {
    vi.useFakeTimers();
    try {
      reconcileSpy.mockReturnValue(new Promise<never>(() => {}) as never);

      service.scheduleTopologyReconcile(true);
      expect(service["topologyReconcilePending"]).toBe(true);

      // Past TOPOLOGY_RECONCILE_TIMEOUT_MS (60s): the watchdog abandons the
      // hung pass and the finally clears the flag — without this a stuck
      // prune/list would freeze all worktree add/remove detection forever.
      await vi.advanceTimersByTimeAsync(61_000);

      expect(service["topologyReconcilePending"]).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
