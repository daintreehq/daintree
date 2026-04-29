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

const mockPullRequestService = {
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

import os from "os";

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

describe("WorkspaceService.pause/resume", () => {
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

  it("pause() stops PR service, pauses monitors, and lowers process priority", () => {
    const monitor = createAndRegisterMonitor();
    const pauseSpy = vi.spyOn(monitor, "pausePolling");
    const setPrioritySpy = vi.spyOn(os, "setPriority").mockImplementation(() => {});

    service.pause();

    expect(mockPullRequestService.stop).toHaveBeenCalled();
    expect(pauseSpy).toHaveBeenCalled();
    expect(service["pollingEnabled"]).toBe(false);
    expect(setPrioritySpy).toHaveBeenCalledWith(process.pid, os.constants.priority.PRIORITY_LOW);
  });

  it("resume() restarts PR service, resumes monitors, and restores priority", () => {
    const monitor = createAndRegisterMonitor();
    // First pause to set pollingEnabled = false
    vi.spyOn(os, "setPriority").mockImplementation(() => {});
    service.pause();
    vi.clearAllMocks();

    const resumeSpy = vi.spyOn(monitor, "resumePolling");
    const setPrioritySpy = vi.spyOn(os, "setPriority").mockImplementation(() => {});

    service.resume();

    expect(mockPullRequestService.start).toHaveBeenCalled();
    expect(resumeSpy).toHaveBeenCalled();
    expect(service["pollingEnabled"]).toBe(true);
    expect(setPrioritySpy).toHaveBeenCalledWith(process.pid, os.constants.priority.PRIORITY_NORMAL);
  });

  it("pause() is idempotent — second call does not re-pause monitors", () => {
    const monitor = createAndRegisterMonitor();
    const pauseSpy = vi.spyOn(monitor, "pausePolling");
    vi.spyOn(os, "setPriority").mockImplementation(() => {});

    service.pause();
    service.pause();

    // pausePolling called only once because setPollingEnabled guards on current value
    expect(pauseSpy).toHaveBeenCalledTimes(1);
    // But stop() is called each time (idempotent on the PR service side)
    expect(mockPullRequestService.stop).toHaveBeenCalledTimes(2);
  });

  it("pause() silently swallows os.setPriority errors", () => {
    vi.spyOn(os, "setPriority").mockImplementation(() => {
      throw new Error("EPERM");
    });

    expect(() => service.pause()).not.toThrow();
  });

  it("resume() silently swallows os.setPriority errors", () => {
    vi.spyOn(os, "setPriority").mockImplementation(() => {});
    service.pause();

    vi.spyOn(os, "setPriority").mockImplementation(() => {
      throw new Error("EPERM");
    });

    expect(() => service.resume()).not.toThrow();
  });

  it("pause() calls global.gc when available", () => {
    vi.spyOn(os, "setPriority").mockImplementation(() => {});
    const mockGc = vi.fn();
    (global as any).gc = mockGc;

    service.pause();

    expect(mockGc).toHaveBeenCalled();
    delete (global as any).gc;
  });

  it("pause() skips global.gc when not available", () => {
    vi.spyOn(os, "setPriority").mockImplementation(() => {});
    delete (global as any).gc;

    // Should not throw
    expect(() => service.pause()).not.toThrow();
  });
});

describe("WorkspaceService.refreshOnWake", () => {
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
    vi.restoreAllMocks();
  });

  function registerMonitor(id: string): WorktreeMonitor {
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
    return monitor;
  }

  it("resets every monitor's polling strategy before triggering refresh", async () => {
    const m1 = registerMonitor("/test/wt-1");
    const m2 = registerMonitor("/test/wt-2");

    const callOrder: string[] = [];
    const reset1 = vi.spyOn(m1, "resetPollingStrategy").mockImplementation(() => {
      callOrder.push("reset:wt-1");
    });
    const reset2 = vi.spyOn(m2, "resetPollingStrategy").mockImplementation(() => {
      callOrder.push("reset:wt-2");
    });
    vi.spyOn(m1, "updateGitStatus").mockImplementation(async () => {
      callOrder.push("updateGitStatus:wt-1");
    });
    vi.spyOn(m2, "updateGitStatus").mockImplementation(async () => {
      callOrder.push("updateGitStatus:wt-2");
    });
    mockPullRequestService.refresh.mockImplementation(() => {
      callOrder.push("pr-refresh");
    });

    await service.refreshOnWake("req-wake-1");

    expect(reset1).toHaveBeenCalledTimes(1);
    expect(reset2).toHaveBeenCalledTimes(1);
    // Both resets must complete before any updateGitStatus runs.
    const firstUpdateIdx = callOrder.findIndex((s) => s.startsWith("updateGitStatus"));
    const lastResetIdx = Math.max(
      callOrder.lastIndexOf("reset:wt-1"),
      callOrder.lastIndexOf("reset:wt-2")
    );
    expect(lastResetIdx).toBeLessThan(firstUpdateIdx);
    expect(mockPullRequestService.refresh).toHaveBeenCalledTimes(1);
    expect(mockSendEvent).toHaveBeenCalledWith({
      type: "refresh-result",
      requestId: "req-wake-1",
      success: true,
    });
  });

  it("triggers PR refresh and reports success even when no monitors are registered", async () => {
    await service.refreshOnWake("req-wake-empty");

    expect(mockPullRequestService.refresh).toHaveBeenCalledTimes(1);
    expect(mockSendEvent).toHaveBeenCalledWith({
      type: "refresh-result",
      requestId: "req-wake-empty",
      success: true,
    });
  });

  it("does not call discoverAndSyncWorktrees on wake (worktree list is stable across sleep)", async () => {
    registerMonitor("/test/wt-1");
    const discoverSpy = vi.spyOn(service as any, "discoverAndSyncWorktrees");

    await service.refreshOnWake("req-wake-no-discover");

    expect(discoverSpy).not.toHaveBeenCalled();
  });

  it("reports failure via refresh-result when PR refresh throws", async () => {
    registerMonitor("/test/wt-1");
    mockPullRequestService.refresh.mockRejectedValueOnce(new Error("rate limited"));

    await service.refreshOnWake("req-wake-fail");

    expect(mockSendEvent).toHaveBeenCalledWith({
      type: "refresh-result",
      requestId: "req-wake-fail",
      success: false,
      error: "rate limited",
    });
  });

  it("staggers wake refresh — at most one git status runs at a time", async () => {
    const monitors = ["/test/wt-1", "/test/wt-2", "/test/wt-3", "/test/wt-4"].map(registerMonitor);

    let inFlight = 0;
    let maxInFlight = 0;
    for (const monitor of monitors) {
      vi.spyOn(monitor, "updateGitStatus").mockImplementation(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      });
    }

    await service.refreshOnWake("req-wake-stagger");

    expect(maxInFlight).toBe(1);
    for (const monitor of monitors) {
      expect(monitor.updateGitStatus).toHaveBeenCalledWith(true);
    }
  });
});
