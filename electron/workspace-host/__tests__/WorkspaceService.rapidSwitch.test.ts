import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WorkspaceService } from "../WorkspaceService.js";
import type { Worktree } from "../../../shared/types/worktree.js";

const mockSimpleGit = {
  raw: vi.fn().mockResolvedValue(""),
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
  getGitDir: vi.fn().mockReturnValue("/test/.git"),
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

vi.mock("../../services/events.js", () => {
  const { EventEmitter } = require("events");
  return { events: new EventEmitter() };
});

vi.mock("../../utils/gitFileWatcher.js", () => ({
  GitFileWatcher: class {
    start() {
      return false;
    }
    dispose() {}
  },
}));

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

// Two fake projects with different worktrees
const PROJECT_A_PATH = "/projects/alpha";
const PROJECT_B_PATH = "/projects/beta";

const WORKTREES_A: Worktree[] = [
  {
    id: PROJECT_A_PATH,
    path: PROJECT_A_PATH,
    name: "alpha",
    branch: "main",
    isCurrent: true,
    isMainWorktree: true,
    gitDir: `${PROJECT_A_PATH}/.git`,
  },
];

const WORKTREES_B: Worktree[] = [
  {
    id: PROJECT_B_PATH,
    path: PROJECT_B_PATH,
    name: "beta",
    branch: "dev",
    isCurrent: true,
    isMainWorktree: true,
    gitDir: `${PROJECT_B_PATH}/.git`,
  },
  {
    id: `${PROJECT_B_PATH}-feature`,
    path: "/projects/beta-feature",
    name: "feature/test",
    branch: "feature/test",
    isCurrent: false,
    isMainWorktree: false,
    gitDir: "/projects/beta-feature/.git",
  },
];

describe("WorkspaceService rapid project switching", () => {
  let service: WorkspaceService;
  let mockSendEvent: ReturnType<typeof vi.fn>;
  let listServiceListMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSendEvent = vi.fn();

    const WorkspaceServiceModule = await import("../WorkspaceService.js");
    service = new WorkspaceServiceModule.WorkspaceService(mockSendEvent as any);

    // Mock the listService.list() to return different worktrees per project
    listServiceListMock = vi.fn().mockImplementation(() => {
      const currentPath = service["projectRootPath"];
      if (currentPath === PROJECT_A_PATH) {
        return Promise.resolve(
          WORKTREES_A.map((wt) => ({
            path: wt.path,
            branch: wt.branch || "",
            bare: false,
            isMainWorktree: wt.isMainWorktree,
          }))
        );
      }
      return Promise.resolve(
        WORKTREES_B.map((wt) => ({
          path: wt.path,
          branch: wt.branch || "",
          bare: false,
          isMainWorktree: wt.isMainWorktree,
        }))
      );
    });

    service["listService"].list = listServiceListMock;
  });

  afterEach(() => {
    // Stop all monitors
    for (const monitor of service["monitors"].values()) {
      monitor.stop();
    }
    vi.restoreAllMocks();
  });

  it("correctly switches monitors between two projects", async () => {
    // Load project A
    await service.loadProject("req-1", PROJECT_A_PATH, "scope-a");

    expect(service["monitors"].size).toBe(1);
    expect(service["monitors"].has(PROJECT_A_PATH)).toBe(true);

    // Switch to project B
    await service.loadProject("req-2", PROJECT_B_PATH, "scope-b");

    expect(service["monitors"].size).toBe(2);
    expect(service["monitors"].has(PROJECT_B_PATH)).toBe(true);
    expect(service["monitors"].has(`${PROJECT_B_PATH}-feature`)).toBe(true);
    // Project A's monitor should be removed
    expect(service["monitors"].has(PROJECT_A_PATH)).toBe(false);
  });

  it("no cross-contamination after 20 rapid switch cycles", async () => {
    const CYCLES = 20;

    for (let i = 0; i < CYCLES; i++) {
      // Switch to A
      await service.loadProject(`req-a-${i}`, PROJECT_A_PATH, `scope-a-${i}`);

      // Verify only A's worktrees are monitored
      const monitorIdsAfterA = Array.from(service["monitors"].keys());
      const hasOnlyA = monitorIdsAfterA.every((id) => id.startsWith("/projects/alpha"));
      expect(hasOnlyA).toBe(true);
      expect(service["monitors"].size).toBe(1);

      // Switch to B
      await service.loadProject(`req-b-${i}`, PROJECT_B_PATH, `scope-b-${i}`);

      // Verify only B's worktrees are monitored
      const monitorIdsAfterB = Array.from(service["monitors"].keys());
      const hasOnlyB = monitorIdsAfterB.every((id) => id.startsWith("/projects/beta"));
      expect(hasOnlyB).toBe(true);
      expect(service["monitors"].size).toBe(2);
    }

    // Final check: end on project A
    await service.loadProject("req-final", PROJECT_A_PATH, "scope-final");
    expect(service["monitors"].size).toBe(1);
    expect(service["monitors"].has(PROJECT_A_PATH)).toBe(true);
    expect(service["monitors"].has(PROJECT_B_PATH)).toBe(false);
  });

  it("main worktree of old project is properly cleaned up on switch", async () => {
    // Load project A (main worktree)
    await service.loadProject("req-1", PROJECT_A_PATH, "scope-a");
    expect(service["monitors"].size).toBe(1);

    const alphaMonitor = service["monitors"].get(PROJECT_A_PATH);
    expect(alphaMonitor?.isMainWorktree).toBe(true);

    // Switch to B — A's main worktree monitor must be removed
    await service.loadProject("req-2", PROJECT_B_PATH, "scope-b");

    expect(service["monitors"].has(PROJECT_A_PATH)).toBe(false);
    expect(service["monitors"].size).toBe(2);
  });

  it("emits worktree-removed for old project monitors on switch", async () => {
    await service.loadProject("req-1", PROJECT_A_PATH, "scope-a");
    mockSendEvent.mockClear();

    await service.loadProject("req-2", PROJECT_B_PATH, "scope-b");

    const removeEvents = mockSendEvent.mock.calls.filter(
      ([event]: [{ type: string }]) => event.type === "worktree-removed"
    );
    expect(removeEvents.length).toBe(1);
    expect(removeEvents[0][0].worktreeId).toBe(PROJECT_A_PATH);
  });

  it("concurrent loadProject calls don't create duplicate monitors", async () => {
    // Fire both without awaiting
    const p1 = service.loadProject("req-1", PROJECT_A_PATH, "scope-a-1");
    const p2 = service.loadProject("req-2", PROJECT_A_PATH, "scope-a-2");

    await Promise.all([p1, p2]);

    // Should have exactly 1 monitor for A, not duplicates
    expect(service["monitors"].size).toBe(1);
    expect(service["monitors"].has(PROJECT_A_PATH)).toBe(true);
  });
});
