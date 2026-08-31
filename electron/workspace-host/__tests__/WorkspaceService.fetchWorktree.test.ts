import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import type { WorkspaceService } from "../WorkspaceService.js";
import type { WorktreeMonitor } from "../WorktreeMonitor.js";

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
  refresh: vi.fn(),
  updateForgeCredentials: vi.fn(),
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
  access: vi.fn().mockRejectedValue(new Error("ENOENT")),
  readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
  cp: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

const startedMonitors: WorktreeMonitor[] = [];

describe("WorkspaceService.fetchWorktree", () => {
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
    service["git"] = mockSimpleGit as any;
  });

  afterEach(() => {
    // Monitors arm REAL 2-5s initial-status timers. `restoreAllMocks` does not
    // cancel them, so an unstopped monitor fires its callback into whichever
    // test happens to be running by then.
    for (const monitor of startedMonitors) monitor.stop();
    startedMonitors.length = 0;
    vi.restoreAllMocks();
  });

  function createMonitor(id: string): WorktreeMonitor {
    const monitor = new WorktreeMonitorClass(
      {
        id,
        path: id,
        name: `feature/${id}`,
        branch: `feature/${id}`,
        isCurrent: false,
        isMainWorktree: false,
        gitDir: `${id}/.git`,
      },
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
    startedMonitors.push(monitor);
    return monitor;
  }

  function lastResultEvent() {
    const calls = mockSendEvent.mock.calls.filter(
      (call) => call[0]?.type === "fetch-worktree-result"
    );
    return calls.at(-1)?.[0];
  }

  it("forces a fetch and reports the coordinator's result back to the caller", async () => {
    const monitor = createMonitor("/test/wt-fetch");
    monitor.start();
    const trigger = vi
      .spyOn(monitor, "triggerFetchNow")
      .mockResolvedValue({ status: "success", remote: "origin", lastFetchedAt: 123 });

    await service.fetchWorktree("req-1", "/test/wt-fetch", false);

    expect(trigger).toHaveBeenCalledWith(false);
    expect(lastResultEvent()).toEqual({
      type: "fetch-worktree-result",
      requestId: "req-1",
      result: { status: "success", remote: "origin", lastFetchedAt: 123 },
    });
  });

  it("passes the prune request straight through", async () => {
    const monitor = createMonitor("/test/wt-prune");
    monitor.start();
    const trigger = vi
      .spyOn(monitor, "triggerFetchNow")
      .mockResolvedValue({ status: "success", remote: "origin" });

    await service.fetchWorktree("req-2", "/test/wt-prune", true);

    expect(trigger).toHaveBeenCalledWith(true);
  });

  it("answers with a transport error rather than hanging when no monitor owns the id", async () => {
    await service.fetchWorktree("req-3", "/test/wt-missing", false);

    const event = lastResultEvent();
    expect(event.requestId).toBe("req-3");
    expect(event.result).toBeUndefined();
    expect(event.error).toContain("/test/wt-missing");
  });

  it("finds the monitor by path when its id was minted differently", async () => {
    // Creation mints an id from `realpath()`; enumeration from `pathResolve()`.
    // Those diverge across a symlink, and the renderer reaches us holding the
    // worktree's PATH — an id-only lookup would fail on exactly the symlinked
    // checkouts that are hardest to debug.
    const monitor = createMonitor("/real/wt-symlinked");
    monitor.start();
    Object.defineProperty(monitor, "path", { value: "/link/wt", configurable: true });
    const trigger = vi
      .spyOn(monitor, "triggerFetchNow")
      .mockResolvedValue({ status: "success", remote: "origin" });

    await service.fetchWorktree("req-path", "/link/wt", false);

    expect(trigger).toHaveBeenCalledWith(false);
    expect(lastResultEvent().error).toBeUndefined();
  });

  it("answers with a transport error for a monitor that exists but is stopped", async () => {
    createMonitor("/test/wt-stopped");

    await service.fetchWorktree("req-4", "/test/wt-stopped", false);

    expect(lastResultEvent().error).toBeTruthy();
  });

  it("reports a thrown fetch as an error instead of a silent success", async () => {
    const monitor = createMonitor("/test/wt-throws");
    monitor.start();
    vi.spyOn(monitor, "triggerFetchNow").mockRejectedValue(new Error("host went away"));

    await service.fetchWorktree("req-5", "/test/wt-throws", false);

    const event = lastResultEvent();
    expect(event.result).toBeUndefined();
    expect(event.error).toBe("host went away");
  });

  it("does not claim success when the scheduler declined to run a fetch at all", async () => {
    // `triggerFetchNow` resolving undefined means no fetch ran (monitor stopped
    // mid-flight). Reporting that as a success would put a fresh-looking
    // timestamp over counts nothing refreshed.
    const monitor = createMonitor("/test/wt-declined");
    monitor.start();
    vi.spyOn(monitor, "triggerFetchNow").mockResolvedValue(undefined);

    await service.fetchWorktree("req-6", "/test/wt-declined", false);

    expect(lastResultEvent().result).toBeUndefined();
  });
});

describe("WorkspaceService.executeFetchForWorktree", () => {
  let service: WorkspaceService;
  let WorktreeMonitorClass: typeof WorktreeMonitor;

  beforeEach(async () => {
    vi.clearAllMocks();
    const WorkspaceServiceModule = await import("../WorkspaceService.js");
    service = new WorkspaceServiceModule.WorkspaceService(vi.fn() as any);
    const WorktreeMonitorModule = await import("../WorktreeMonitor.js");
    WorktreeMonitorClass = WorktreeMonitorModule.WorktreeMonitor;
    service["projectRootPath"] = "/test/root";
    service["git"] = mockSimpleGit as any;
  });

  afterEach(() => {
    // Monitors arm REAL 2-5s initial-status timers. `restoreAllMocks` does not
    // cancel them, so an unstopped monitor fires its callback into whichever
    // test happens to be running by then.
    for (const monitor of startedMonitors) monitor.stop();
    startedMonitors.length = 0;
    vi.restoreAllMocks();
  });

  function createMonitor(id: string): WorktreeMonitor {
    const monitor = new WorktreeMonitorClass(
      {
        id,
        path: id,
        name: `feature/${id}`,
        branch: `feature/${id}`,
        isCurrent: false,
        isMainWorktree: false,
        gitDir: `${id}/.git`,
      },
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
    startedMonitors.push(monitor);
    return monitor;
  }

  it("hands prune to the coordinator unchanged", async () => {
    const monitor = createMonitor("/test/wt-exec");
    monitor.start();
    const spy = vi
      .spyOn(service["fetchCoordinator"], "fetchForWorktree")
      .mockResolvedValue({ status: "success", remote: "origin" });

    await service["executeFetchForWorktree"]("/test/wt-exec", true, false);

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ force: true, prune: false }));
  });

  it("leaves prune undefined on the scheduled path so the coordinator default applies", async () => {
    // Background fetches have pruned since #6564; #12091 must not quietly turn
    // that off for every repo.
    const monitor = createMonitor("/test/wt-sched");
    monitor.start();
    const spy = vi
      .spyOn(service["fetchCoordinator"], "fetchForWorktree")
      .mockResolvedValue({ status: "success", remote: "origin" });

    await service["executeFetchForWorktree"]("/test/wt-sched", false);

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ prune: undefined }));
  });

  it("does not stamp fetch state onto a monitor removed while the fetch was running", async () => {
    const monitor = createMonitor("/test/wt-gone");
    monitor.start();
    const setFetchState = vi.spyOn(monitor, "setFetchState");
    vi.spyOn(service["fetchCoordinator"], "fetchForWorktree").mockImplementation(async () => {
      service["monitors"].delete("/test/wt-gone");
      return { status: "success", remote: "origin", lastFetchedAt: 1, authFailed: false };
    });

    const result = await service["executeFetchForWorktree"]("/test/wt-gone", true, false);

    expect(result?.status).toBe("success");
    expect(setFetchState).not.toHaveBeenCalled();
  });

  it("returns undefined without spawning a fetch for an unknown worktree", async () => {
    const spy = vi.spyOn(service["fetchCoordinator"], "fetchForWorktree");

    await expect(
      service["executeFetchForWorktree"]("/test/nope", true, false)
    ).resolves.toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });
});
