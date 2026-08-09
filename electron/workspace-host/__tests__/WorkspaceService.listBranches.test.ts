import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import type { WorkspaceService } from "../WorkspaceService.js";
import type { BranchInfo, WorkspaceHostEvent } from "../../../shared/types/workspace-host.js";

const mockSimpleGit = {
  raw: vi.fn().mockResolvedValue(undefined),
  branch: vi.fn().mockResolvedValue({ branches: {} }),
};

vi.mock("simple-git", () => ({
  simpleGit: vi.fn(() => mockSimpleGit),
}));

vi.mock("../../utils/fs.js", () => ({
  waitForPathExists: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../utils/hardenedGit.js", () => ({
  createHardenedGit: vi.fn(() => mockSimpleGit),
  createAuthenticatedGit: vi.fn(() => mockSimpleGit),
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

vi.mock("../../services/events.js", () => ({
  events: new EventEmitter(),
}));

vi.mock("../../utils/gitFileWatcher.js", () => ({
  GitFileWatcher: class {
    start() {
      return Promise.resolve(false);
    }
    dispose() {}
  },
}));

vi.mock("fs/promises", () => ({
  stat: vi.fn().mockRejectedValue(new Error("ENOENT")),
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
}));

/**
 * The workspace host is the producer the New Worktree dialog actually reads
 * through (`WorkspaceClient.listBranches` -> `list-branches`), so the branch
 * recency contract has to hold here and not only in `GitService`.
 */
describe("WorkspaceService.listBranches", () => {
  let service: WorkspaceService;
  let mockSendEvent: ReturnType<typeof vi.fn>;

  function listBranchesResult(): { branches: BranchInfo[]; error?: string } {
    const event = mockSendEvent.mock.calls
      .map((call) => call[0] as WorkspaceHostEvent)
      .find((e) => e.type === "list-branches-result");
    if (!event) throw new Error("no list-branches-result was emitted");
    return event as { branches: BranchInfo[]; error?: string };
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSendEvent = vi.fn();
    mockSimpleGit.raw.mockResolvedValue(undefined);
    mockSimpleGit.branch.mockResolvedValue({
      branches: {
        main: { current: true, commit: "1" },
        "remotes/origin/main": { current: false, commit: "1" },
      },
    });

    const WorkspaceServiceModule = await import("../WorkspaceService.js");
    service = new WorkspaceServiceModule.WorkspaceService(
      mockSendEvent as unknown as (event: WorkspaceHostEvent) => void
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("carries each branch's tip date through to the renderer", async () => {
    mockSimpleGit.raw.mockResolvedValue(
      [
        "refs/heads/main\t2026-08-01T10:00:00+00:00",
        "refs/remotes/origin/main\t2026-07-30T09:00:00+00:00",
      ].join("\n")
    );

    await service.listBranches("req-1", "/test/root");

    const { branches, error } = listBranchesResult();
    expect(error).toBeUndefined();
    expect(Object.fromEntries(branches.map((b) => [b.name, b.committerDate]))).toEqual({
      main: "2026-08-01T10:00:00+00:00",
      "origin/main": "2026-07-30T09:00:00+00:00",
    });
  });

  it("emits the branch list without dates when the date pass fails", async () => {
    mockSimpleGit.raw.mockRejectedValue(new Error("for-each-ref exploded"));

    await service.listBranches("req-2", "/test/root");

    const { branches, error } = listBranchesResult();
    // A metadata failure is not a list failure.
    expect(error).toBeUndefined();
    expect(branches.map((b) => b.name)).toEqual(["main", "origin/main"]);
    expect(branches.every((b) => b.committerDate === undefined)).toBe(true);
  });

  it("still reports a real branch-listing failure", async () => {
    mockSimpleGit.branch.mockRejectedValue(new Error("fatal: not a git repository"));

    await service.listBranches("req-3", "/test/root");

    const { branches, error } = listBranchesResult();
    expect(error).toContain("not a git repository");
    expect(branches).toEqual([]);
  });

  it("filters pseudo HEAD references", async () => {
    mockSimpleGit.branch.mockResolvedValue({
      branches: {
        main: { current: true, commit: "1" },
        "remotes/origin/main": { current: false, commit: "1" },
        "HEAD -> origin/main": { current: false, commit: "1" },
        "remotes/origin/HEAD": { current: false, commit: "1" },
        "(detached from abc123)": { current: false, commit: "1" },
      },
    });

    await service.listBranches("req-4", "/test/root");

    expect(listBranchesResult().branches.map((b) => b.name)).toEqual(["main", "origin/main"]);
  });
});
