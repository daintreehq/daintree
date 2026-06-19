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

describe("WorkspaceService.retryAuthFetch", () => {
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
    return monitor;
  }

  it("clears auth suspensions and triggers a fetch on every running monitor", () => {
    const m1 = createMonitor("/test/wt-1");
    const m2 = createMonitor("/test/wt-2");
    m1.start();
    m2.start();

    const clearSpy = vi.spyOn(service["fetchCoordinator"], "clearAuthFailures");
    const fetch1 = vi.spyOn(m1, "triggerFetchNow").mockResolvedValue(undefined);
    const fetch2 = vi.spyOn(m2, "triggerFetchNow").mockResolvedValue(undefined);

    service.retryAuthFetch();

    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(fetch1).toHaveBeenCalledTimes(1);
    expect(fetch2).toHaveBeenCalledTimes(1);
  });

  it("clears auth suspensions even when no monitors are running", () => {
    const stopped = createMonitor("/test/wt-stopped");
    const clearSpy = vi.spyOn(service["fetchCoordinator"], "clearAuthFailures");
    const fetchSpy = vi.spyOn(stopped, "triggerFetchNow").mockResolvedValue(undefined);

    service.retryAuthFetch();

    // Clearing must happen unconditionally so the next scheduled fetch retries;
    // a stopped monitor must not be force-fetched.
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("clears the suspension BEFORE triggering fetches (else the fetch short-circuits on auth-suspended)", () => {
    const monitor = createMonitor("/test/wt-order");
    monitor.start();

    const order: string[] = [];
    vi.spyOn(service["fetchCoordinator"], "clearAuthFailures").mockImplementation(() => {
      order.push("clear");
    });
    vi.spyOn(monitor, "triggerFetchNow").mockImplementation(async () => {
      order.push("fetch");
    });

    service.retryAuthFetch();

    expect(order).toEqual(["clear", "fetch"]);
  });

  it("does not force-fetch stopped monitors while still fetching running ones", () => {
    const running = createMonitor("/test/wt-running");
    const stopped = createMonitor("/test/wt-stopped");
    running.start();

    const runningFetch = vi.spyOn(running, "triggerFetchNow").mockResolvedValue(undefined);
    const stoppedFetch = vi.spyOn(stopped, "triggerFetchNow").mockResolvedValue(undefined);

    service.retryAuthFetch();

    expect(runningFetch).toHaveBeenCalledTimes(1);
    expect(stoppedFetch).not.toHaveBeenCalled();
  });

  it("re-arms the confirmed-auth escalation guard so a later re-confirmation re-notifies", () => {
    const confirm = (commonDir: string) =>
      service["handleAuthFailureConfirmed"](commonDir, "auth-failed");

    // First confirmation emits the escalation event.
    confirm("/repo/.git");
    expect(
      mockSendEvent.mock.calls.filter((c) => c[0]?.type === "fetch-auth-failure-confirmed").length
    ).toBe(1);

    // A second confirmation for the same repo is suppressed by the guard.
    confirm("/repo/.git");
    expect(
      mockSendEvent.mock.calls.filter((c) => c[0]?.type === "fetch-auth-failure-confirmed").length
    ).toBe(1);

    // A user retry clears the guard; the next confirmation re-emits.
    service.retryAuthFetch();
    confirm("/repo/.git");
    expect(
      mockSendEvent.mock.calls.filter((c) => c[0]?.type === "fetch-auth-failure-confirmed").length
    ).toBe(2);
  });
});

describe("WorkspaceService — handleAuthFailureConfirmed", () => {
  let service: WorkspaceService;
  let mockSendEvent: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSendEvent = vi.fn();
    const WorkspaceServiceModule = await import("../WorkspaceService.js");
    service = new WorkspaceServiceModule.WorkspaceService(mockSendEvent as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits a single escalation event per commondir and carries the reason", () => {
    service["handleAuthFailureConfirmed"]("/repoA/.git", "auth-failed");
    service["handleAuthFailureConfirmed"]("/repoA/.git", "auth-failed");

    const events = mockSendEvent.mock.calls
      .map((c) => c[0])
      .filter((e) => e?.type === "fetch-auth-failure-confirmed");
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe("auth-failed");
    // The raw commondir path must never cross the IPC boundary.
    expect(JSON.stringify(events[0])).not.toContain("/repoA/.git");
  });

  it("confirms distinct commondirs independently", () => {
    service["handleAuthFailureConfirmed"]("/repoA/.git", "auth-failed");
    service["handleAuthFailureConfirmed"]("/repoB/.git", "repository-not-found");

    const events = mockSendEvent.mock.calls
      .map((c) => c[0])
      .filter((e) => e?.type === "fetch-auth-failure-confirmed");
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.reason)).toEqual(["auth-failed", "repository-not-found"]);
  });

  it("re-arms the escalation guard on project switch so a re-opened repo can re-notify", async () => {
    service["handleAuthFailureConfirmed"]("/repoA/.git", "auth-failed");
    service["handleAuthFailureConfirmed"]("/repoA/.git", "auth-failed");
    expect(
      mockSendEvent.mock.calls.filter((c) => c[0]?.type === "fetch-auth-failure-confirmed").length
    ).toBe(1);

    await service.onProjectSwitch("req-1");

    service["handleAuthFailureConfirmed"]("/repoA/.git", "auth-failed");
    expect(
      mockSendEvent.mock.calls.filter((c) => c[0]?.type === "fetch-auth-failure-confirmed").length
    ).toBe(2);
  });
});
