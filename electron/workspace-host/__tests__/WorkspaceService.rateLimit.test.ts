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

// Base fetch intervals — match WorkspaceService defaults.
const BASE_ACTIVE_MS = 30_000;
const BASE_BACKGROUND_MS = 5 * 60_000;

describe("WorkspaceService.applyFetchThrottle", () => {
  let service: WorkspaceService;
  let WorktreeMonitorClass: typeof WorktreeMonitor;

  beforeEach(async () => {
    vi.clearAllMocks();

    const WorkspaceServiceModule = await import("../WorkspaceService.js");
    service = new WorkspaceServiceModule.WorkspaceService(vi.fn() as any);

    const WorktreeMonitorModule = await import("../WorktreeMonitor.js");
    WorktreeMonitorClass = WorktreeMonitorModule.WorktreeMonitor;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function registerMonitor(id: string): WorktreeMonitor {
    const wt = createTestWorktree({ id, path: id });
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
    service["monitors"].set(id, monitor);
    return monitor;
  }

  it("scales every monitor's fetch intervals by the multiplier", () => {
    const a = registerMonitor("/wt/a");
    const b = registerMonitor("/wt/b");
    const updateA = vi.spyOn(a, "updateConfig");
    const updateB = vi.spyOn(b, "updateConfig");

    service.applyFetchThrottle(3);

    expect(updateA).toHaveBeenCalledWith({
      fetchIntervalActiveMs: BASE_ACTIVE_MS * 3,
      fetchIntervalBackgroundMs: BASE_BACKGROUND_MS * 3,
    });
    expect(updateB).toHaveBeenCalledWith({
      fetchIntervalActiveMs: BASE_ACTIVE_MS * 3,
      fetchIntervalBackgroundMs: BASE_BACKGROUND_MS * 3,
    });
  });

  it("does not compound when the same multiplier is applied twice", () => {
    const a = registerMonitor("/wt/a");
    const updateA = vi.spyOn(a, "updateConfig");

    service.applyFetchThrottle(3);
    service.applyFetchThrottle(3);

    // Both calls scale from the base intervals — never from 3x → 9x.
    for (const call of updateA.mock.calls) {
      expect(call[0]).toEqual({
        fetchIntervalActiveMs: BASE_ACTIVE_MS * 3,
        fetchIntervalBackgroundMs: BASE_BACKGROUND_MS * 3,
      });
    }
  });

  it("snaps back to base intervals and re-arms fetch on recovery to multiplier 1", () => {
    const a = registerMonitor("/wt/a");
    const updateA = vi.spyOn(a, "updateConfig");
    const rescheduleA = vi.spyOn(a, "rescheduleFetch");

    service.applyFetchThrottle(4);
    updateA.mockClear();
    rescheduleA.mockClear();

    service.applyFetchThrottle(1);

    expect(updateA).toHaveBeenCalledWith({
      fetchIntervalActiveMs: BASE_ACTIVE_MS,
      fetchIntervalBackgroundMs: BASE_BACKGROUND_MS,
    });
    expect(rescheduleA).toHaveBeenCalledWith(true);
  });

  it("does not re-arm fetch when the multiplier was already 1", () => {
    const a = registerMonitor("/wt/a");
    const rescheduleA = vi.spyOn(a, "rescheduleFetch");

    service.applyFetchThrottle(1);

    expect(rescheduleA).not.toHaveBeenCalled();
  });

  it("clamps an invalid multiplier (< 1, NaN) to 1", () => {
    const a = registerMonitor("/wt/a");
    const updateA = vi.spyOn(a, "updateConfig");

    service.applyFetchThrottle(0);
    service.applyFetchThrottle(Number.NaN);

    for (const call of updateA.mock.calls) {
      expect(call[0]).toEqual({
        fetchIntervalActiveMs: BASE_ACTIVE_MS,
        fetchIntervalBackgroundMs: BASE_BACKGROUND_MS,
      });
    }
  });

  it("preserves the active throttle across an unrelated monitor-config push", () => {
    const a = registerMonitor("/wt/a");
    service.applyFetchThrottle(4);

    const updateA = vi.spyOn(a, "updateConfig");
    // A config push that does not touch fetch intervals must still write the
    // *throttled* cadence — never clobber it back to the raw base.
    service.updateMonitorConfig({} as any);

    expect(updateA).toHaveBeenCalledWith(
      expect.objectContaining({
        fetchIntervalActiveMs: BASE_ACTIVE_MS * 4,
        fetchIntervalBackgroundMs: BASE_BACKGROUND_MS * 4,
      })
    );
  });
});
