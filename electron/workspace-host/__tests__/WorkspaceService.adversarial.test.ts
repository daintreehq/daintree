import { EventEmitter } from "events";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { WorkspaceService } from "../WorkspaceService.js";
import type { WorkspaceHostEvent } from "../../../shared/types/workspace-host.js";

const mockSimpleGit = {
  raw: vi.fn(),
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
}));

vi.mock("../../utils/git.js", () => ({
  invalidateGitStatusCache: vi.fn(),
}));

vi.mock("../../utils/gitUtils.js", () => ({
  getGitDir: vi.fn().mockReturnValue("/test/worktree/.git"),
  clearGitDirCache: vi.fn(),
}));

vi.mock("../../services/issueExtractor.js", () => ({
  extractIssueNumberSync: vi.fn().mockReturnValue(null),
  extractIssueNumber: vi.fn().mockResolvedValue(null),
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

vi.mock("../../services/events.js", () => ({
  events: new EventEmitter(),
}));

vi.mock("fs/promises", () => ({
  stat: vi.fn().mockRejectedValue(new Error("ENOENT")),
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
  cp: vi.fn().mockResolvedValue(undefined),
}));

describe("WorkspaceService adversarial", () => {
  let service: WorkspaceService;
  let sentEvents: WorkspaceHostEvent[];

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSimpleGit.raw.mockResolvedValue(undefined);
    waitForPathExistsMock.mockResolvedValue(undefined);

    sentEvents = [];
    const workspaceModule = await import("../WorkspaceService.js");
    service = new workspaceModule.WorkspaceService((event: WorkspaceHostEvent) => {
      sentEvents.push(event);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fails loadProject cleanly when worktree metadata mapping is corrupted", async () => {
    const listService = service["listService"] as unknown as {
      list: Mock;
      mapToWorktrees: Mock;
    };

    listService.list = vi.fn().mockResolvedValue([{ path: "/broken" }]);
    listService.mapToWorktrees = vi.fn(() => {
      throw new Error("Corrupted worktree metadata");
    });

    await service.loadProject("req-load", "/repo");

    expect(sentEvents).toContainEqual(
      expect.objectContaining({
        type: "load-project-result",
        requestId: "req-load",
        success: false,
        error: "Corrupted worktree metadata",
      })
    );
  });

  it("returns a failure when git worktree add hits index.lock contention", async () => {
    mockSimpleGit.raw.mockRejectedValueOnce(
      new Error("fatal: Unable to create '/repo/.git/index.lock': File exists.")
    );

    await service.createWorktree("req-create", "/repo", {
      baseBranch: "main",
      newBranch: "feature/lock",
      path: "/repo/wt-lock",
    });

    expect(sentEvents).toContainEqual(
      expect.objectContaining({
        type: "create-worktree-result",
        requestId: "req-create",
        success: false,
        error: expect.stringContaining("index.lock"),
      })
    );
  });

  it("fails createWorktree if the worktree disappears before discovery completes", async () => {
    const listService = service["listService"] as unknown as {
      invalidateCache: Mock;
      list: Mock;
      mapToWorktrees: Mock;
    };

    listService.invalidateCache = vi.fn();
    listService.list = vi.fn().mockResolvedValue([]);
    listService.mapToWorktrees = vi.fn().mockReturnValue([]);

    await service.createWorktree("req-missing", "/repo", {
      baseBranch: "main",
      newBranch: "feature/missing",
      path: "/repo/wt-missing",
    });

    expect(sentEvents).toContainEqual(
      expect.objectContaining({
        type: "create-worktree-result",
        requestId: "req-missing",
        success: false,
      })
    );
  });

  it("does not accumulate duplicate monitors when delete and create overlap on the same path", async () => {
    const listService = service["listService"] as unknown as {
      invalidateCache: Mock;
      list: Mock;
      mapToWorktrees: Mock;
    };

    const createdWorktree = {
      id: "/repo/wt-race",
      path: "/repo/wt-race",
      name: "feature/race",
      branch: "feature/race",
      isCurrent: false,
      isMainWorktree: false,
      gitDir: "/repo/wt-race/.git",
    };

    let releaseGit!: () => void;
    mockSimpleGit.raw.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseGit = resolve;
        })
    );

    listService.invalidateCache = vi.fn();
    listService.list = vi.fn().mockResolvedValue([createdWorktree]);
    listService.mapToWorktrees = vi.fn().mockReturnValue([createdWorktree]);

    const createPromise = service.createWorktree("req-race-create", "/repo", {
      baseBranch: "main",
      newBranch: "feature/race",
      path: "/repo/wt-race",
    });

    const deletePromise = service.deleteWorktree("req-race-delete", "/repo/wt-race");

    releaseGit();
    await Promise.allSettled([createPromise, deletePromise]);

    const monitorEntries = Array.from(service["monitors"].keys()).filter(
      (worktreeId) => worktreeId === "/repo/wt-race"
    );
    expect(monitorEntries).toHaveLength(1);
  });
});
