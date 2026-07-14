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

  it("forces a status refresh on every running sibling sharing the common dir", async () => {
    const m1 = registerMonitor("/test/wt-1");
    const m2 = registerMonitor("/test/wt-2");
    const other = registerMonitor("/test/other");
    const s1 = vi.spyOn(m1, "triggerRefreshIfUpdating").mockImplementation(() => {});
    const s2 = vi.spyOn(m2, "triggerRefreshIfUpdating").mockImplementation(() => {});
    const sOther = vi.spyOn(other, "triggerRefreshIfUpdating").mockImplementation(() => {});
    // wt-1 and wt-2 are linked worktrees of one repo; "other" is a separate repo.
    mockGetGitCommonDir.mockImplementation((path: string) =>
      path === "/test/other" ? "/test/other/.git" : "/test/shared/.git"
    );

    await service["refreshStatusForFetchSiblings"]("/test/wt-1");

    expect(s1).toHaveBeenCalledTimes(1);
    expect(s2).toHaveBeenCalledTimes(1);
    expect(sOther).not.toHaveBeenCalled();
  });

  it("skips stopped monitors sharing the common dir", async () => {
    const m1 = registerMonitor("/test/wt-1");
    const m2 = registerMonitor("/test/wt-2");
    const s1 = vi.spyOn(m1, "triggerRefreshIfUpdating").mockImplementation(() => {});
    const s2 = vi.spyOn(m2, "triggerRefreshIfUpdating").mockImplementation(() => {});
    mockGetGitCommonDir.mockResolvedValue("/test/shared/.git");
    m2.stop();

    await service["refreshStatusForFetchSiblings"]("/test/wt-1");

    expect(s1).toHaveBeenCalledTimes(1);
    expect(s2).not.toHaveBeenCalled();
  });

  it("refreshes only the triggering monitor when the common dir can't be resolved", async () => {
    const m1 = registerMonitor("/test/wt-1");
    const m2 = registerMonitor("/test/wt-2");
    const s1 = vi.spyOn(m1, "triggerRefreshIfUpdating").mockImplementation(() => {});
    const s2 = vi.spyOn(m2, "triggerRefreshIfUpdating").mockImplementation(() => {});
    mockGetGitCommonDir.mockResolvedValue(null);

    await service["refreshStatusForFetchSiblings"]("/test/wt-1");

    expect(s1).toHaveBeenCalledTimes(1);
    expect(s2).not.toHaveBeenCalled();
  });

  it("no-ops without throwing when the triggering monitor is gone", async () => {
    registerMonitor("/test/wt-1");
    mockGetGitCommonDir.mockResolvedValue("/test/shared/.git");

    await expect(
      service["refreshStatusForFetchSiblings"]("/test/missing")
    ).resolves.toBeUndefined();
  });
});
