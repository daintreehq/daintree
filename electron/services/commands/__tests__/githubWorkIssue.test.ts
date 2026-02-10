import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  hasGitHubTokenMock,
  getRepoContextMock,
  getIssueUrlMock,
  createClientMock,
  getWorkspaceClientMock,
  getRepositoryRootMock,
  listBranchesMock,
  findAvailableBranchNameMock,
  findAvailablePathMock,
  storeGetMock,
  generateWorktreePathMock,
  validatePathPatternMock,
} = vi.hoisted(() => ({
  hasGitHubTokenMock: vi.fn(),
  getRepoContextMock: vi.fn(),
  getIssueUrlMock: vi.fn(),
  createClientMock: vi.fn(),
  getWorkspaceClientMock: vi.fn(),
  getRepositoryRootMock: vi.fn(),
  listBranchesMock: vi.fn(),
  findAvailableBranchNameMock: vi.fn(),
  findAvailablePathMock: vi.fn(),
  storeGetMock: vi.fn(),
  generateWorktreePathMock: vi.fn(),
  validatePathPatternMock: vi.fn(),
}));

vi.mock("../../GitHubService.js", () => ({
  hasGitHubToken: hasGitHubTokenMock,
  getRepoContext: getRepoContextMock,
  getIssueUrl: getIssueUrlMock,
}));

vi.mock("../../github/index.js", () => ({
  GitHubAuth: { createClient: createClientMock },
  GET_ISSUE_QUERY: "query",
}));

vi.mock("../../WorkspaceClient.js", () => ({
  getWorkspaceClient: getWorkspaceClientMock,
}));

vi.mock("../../GitService.js", () => ({
  GitService: class MockGitService {
    getRepositoryRoot = getRepositoryRootMock;
    listBranches = listBranchesMock;
    findAvailableBranchName = findAvailableBranchNameMock;
    findAvailablePath = findAvailablePathMock;
  },
}));

vi.mock("../../../store.js", () => ({
  store: {
    get: storeGetMock,
  },
}));

vi.mock("../../../../shared/utils/pathPattern.js", () => ({
  DEFAULT_WORKTREE_PATH_PATTERN: "{repo}/{branch}",
  generateWorktreePath: generateWorktreePathMock,
  validatePathPattern: validatePathPatternMock,
}));

import { githubWorkIssueCommand } from "../githubWorkIssue.js";

describe("githubWorkIssueCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hasGitHubTokenMock.mockReturnValue(true);
    getRepoContextMock.mockResolvedValue({ owner: "canopy", repo: "app" });
    getIssueUrlMock.mockResolvedValue("https://github.com/canopy/app/issues/55");
    createClientMock.mockReturnValue(
      vi.fn().mockResolvedValue({
        repository: {
          issue: {
            number: 55,
            title: "!!!",
            url: "https://github.com/canopy/app/issues/55",
            state: "OPEN",
          },
        },
      })
    );
    getRepositoryRootMock.mockResolvedValue("/repo");
    listBranchesMock.mockResolvedValue([{ name: "main", remote: false }]);
    findAvailableBranchNameMock.mockImplementation(async (name: string) => name);
    findAvailablePathMock.mockImplementation((worktreePath: string) => worktreePath);
    storeGetMock.mockReturnValue(undefined);
    validatePathPatternMock.mockReturnValue({ valid: true });
    generateWorktreePathMock.mockImplementation((_root: string, branchName: string) => {
      return `/tmp/${branchName}`;
    });

    const workspaceClient = {
      isReady: vi.fn().mockReturnValue(true),
      createWorktree: vi.fn().mockResolvedValue("worktree-55"),
      setActiveWorktree: vi.fn().mockResolvedValue(undefined),
    };
    getWorkspaceClientMock.mockReturnValue(workspaceClient);
  });

  it("falls back to issue-N branch format when title slug is empty", async () => {
    const result = await githubWorkIssueCommand.execute({ cwd: "/repo" } as never, {
      issueNumber: 55,
    });

    expect(result.success).toBe(true);
    expect(findAvailableBranchNameMock).toHaveBeenCalledWith("issue-55");

    const workspaceClient = getWorkspaceClientMock.mock.results[0]?.value as {
      createWorktree: ReturnType<typeof vi.fn>;
    };
    expect(workspaceClient.createWorktree).toHaveBeenCalledWith(
      "/repo",
      expect.objectContaining({
        newBranch: "issue-55",
      })
    );
  });

  it("uses fetched issue URL when getIssueUrl throws", async () => {
    getIssueUrlMock.mockRejectedValue(new Error("url lookup failed"));

    const result = await githubWorkIssueCommand.execute({ cwd: "/repo" } as never, {
      issueNumber: 55,
    });

    expect(result.success).toBe(true);
    expect(result.data?.issueUrl).toBe("https://github.com/canopy/app/issues/55");
  });
});
