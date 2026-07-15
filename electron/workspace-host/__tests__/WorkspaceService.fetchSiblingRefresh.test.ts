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

// Controllable per-path common-dir resolution — this is what decides which
// monitors count as fetch siblings.
const mockGetGitCommonDir = vi.fn();
vi.mock("../../utils/gitUtils.js", () => ({
  getGitDir: vi.fn().mockReturnValue("/test/worktree/.git"),
  getGitCommonDir: (...args: unknown[]) => mockGetGitCommonDir(...args),
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

describe("WorkspaceService fetch-sibling status refresh (#11151)", () => {
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
    for (const monitor of service["monitors"].values()) {
      monitor.stop();
    }
    vi.restoreAllMocks();
  });

  function registerMonitor(id: string, opts: { isMainWorktree?: boolean } = {}): WorktreeMonitor {
    const monitor = new WorktreeMonitorClass(
      createTestWorktree({
        id,
        path: id,
        gitDir: `${id}/.git`,
        isMainWorktree: opts.isMainWorktree ?? false,
      }),
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

  it("refreshes the triggering worktree and the main worktree, but not other siblings", async () => {
    const feature = registerMonitor("/test/feature");
    const main = registerMonitor("/test/main", { isMainWorktree: true });
    const otherFeature = registerMonitor("/test/feature-2");
    const sFeature = vi.spyOn(feature, "triggerRefreshIfUpdating").mockImplementation(() => {});
    const sMain = vi.spyOn(main, "triggerRefreshIfUpdating").mockImplementation(() => {});
    const sOther = vi.spyOn(otherFeature, "triggerRefreshIfUpdating").mockImplementation(() => {});
    // All three are linked worktrees of the same repo (shared common dir).
    mockGetGitCommonDir.mockResolvedValue("/test/shared/.git");

    await service["refreshStatusForFetchSiblings"]("/test/feature");

    // Trigger + main refresh; the non-main sibling is deliberately left out so
    // one fetch can't fan into an N-way status storm on a many-worktree repo.
    expect(sFeature).toHaveBeenCalledTimes(1);
    expect(sMain).toHaveBeenCalledTimes(1);
    expect(sOther).not.toHaveBeenCalled();
  });

  it("refreshes only the triggering worktree once when it is itself the main worktree", async () => {
    const main = registerMonitor("/test/main", { isMainWorktree: true });
    const feature = registerMonitor("/test/feature");
    const sMain = vi.spyOn(main, "triggerRefreshIfUpdating").mockImplementation(() => {});
    const sFeature = vi.spyOn(feature, "triggerRefreshIfUpdating").mockImplementation(() => {});
    mockGetGitCommonDir.mockResolvedValue("/test/shared/.git");

    await service["refreshStatusForFetchSiblings"]("/test/main");

    // No double-refresh: the trigger is the main worktree.
    expect(sMain).toHaveBeenCalledTimes(1);
    expect(sFeature).not.toHaveBeenCalled();
  });

  it("skips the main worktree when it is stopped", async () => {
    const feature = registerMonitor("/test/feature");
    const main = registerMonitor("/test/main", { isMainWorktree: true });
    const sFeature = vi.spyOn(feature, "triggerRefreshIfUpdating").mockImplementation(() => {});
    const sMain = vi.spyOn(main, "triggerRefreshIfUpdating").mockImplementation(() => {});
    mockGetGitCommonDir.mockResolvedValue("/test/shared/.git");
    main.stop();

    await service["refreshStatusForFetchSiblings"]("/test/feature");

    expect(sFeature).toHaveBeenCalledTimes(1);
    expect(sMain).not.toHaveBeenCalled();
  });

  it("skips the main worktree when it does not share the fetched repo's common dir", async () => {
    const feature = registerMonitor("/test/feature");
    const main = registerMonitor("/test/main", { isMainWorktree: true });
    const sFeature = vi.spyOn(feature, "triggerRefreshIfUpdating").mockImplementation(() => {});
    const sMain = vi.spyOn(main, "triggerRefreshIfUpdating").mockImplementation(() => {});
    // The main worktree belongs to a different repo than the fetched one.
    mockGetGitCommonDir.mockImplementation((path: string) =>
      path === "/test/main" ? "/test/other/.git" : "/test/shared/.git"
    );

    await service["refreshStatusForFetchSiblings"]("/test/feature");

    expect(sFeature).toHaveBeenCalledTimes(1);
    expect(sMain).not.toHaveBeenCalled();
  });

  it("no-ops without throwing when the triggering monitor is gone", async () => {
    registerMonitor("/test/main", { isMainWorktree: true });
    mockGetGitCommonDir.mockResolvedValue("/test/shared/.git");

    await expect(
      service["refreshStatusForFetchSiblings"]("/test/missing")
    ).resolves.toBeUndefined();
  });
});
