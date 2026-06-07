import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Issue } from "../../../../shared/types/forge.js";

const {
  hasActivatedForgeProviderMock,
  resolveForCwdMock,
  getIssueMock,
  getWorkspaceClientMock,
  getRepositoryRootMock,
  listBranchesMock,
  findAvailableBranchNameMock,
  findAvailablePathMock,
  generateWorktreePathMock,
  validatePathPatternMock,
  resolveWorktreePatternMock,
} = vi.hoisted(() => ({
  hasActivatedForgeProviderMock: vi.fn(),
  resolveForCwdMock: vi.fn(),
  getIssueMock: vi.fn(),
  getWorkspaceClientMock: vi.fn(),
  getRepositoryRootMock: vi.fn(),
  listBranchesMock: vi.fn(),
  findAvailableBranchNameMock: vi.fn(),
  findAvailablePathMock: vi.fn(),
  generateWorktreePathMock: vi.fn(),
  validatePathPatternMock: vi.fn(),
  resolveWorktreePatternMock: vi.fn(),
}));

vi.mock("../../forgeProviderRegistry.js", () => ({
  hasActivatedForgeProvider: hasActivatedForgeProviderMock,
}));

vi.mock("../../../ipc/handlers/forgeResolution.js", () => ({
  resolveForCwd: resolveForCwdMock,
}));

vi.mock("../../forge/forgeAuditService.js", () => ({
  auditForgeCall: (_meta: unknown, run: () => unknown) => run(),
  summarizeForgeArgs: () => "",
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

vi.mock("../../../../shared/utils/pathPattern.js", () => ({
  DEFAULT_WORKTREE_PATH_PATTERN: "{repo}/{branch}",
  generateWorktreePath: generateWorktreePathMock,
  validatePathPattern: validatePathPatternMock,
  validateBranchName: vi.fn(() => ({ valid: true })),
}));

vi.mock("../../../utils/worktreePattern.js", () => ({
  resolveWorktreePattern: resolveWorktreePatternMock,
}));

import { githubWorkIssueCommand } from "../githubWorkIssue.js";

/** Build a minimal forge Issue with sensible defaults for tests. */
function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 55,
    title: "!!!",
    url: "https://github.com/daintree/app/issues/55",
    state: "open",
    ...overrides,
  } as Issue;
}

describe("githubWorkIssueCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hasActivatedForgeProviderMock.mockReturnValue(true);
    getIssueMock.mockResolvedValue(makeIssue());
    resolveForCwdMock.mockResolvedValue({
      namespaceId: "builtin.github/github",
      providerId: "github",
      repoRef: { owner: "daintree", repo: "app" },
      impl: { getIssue: getIssueMock },
    });
    getRepositoryRootMock.mockResolvedValue("/repo");
    listBranchesMock.mockResolvedValue([{ name: "main", remote: false }]);
    findAvailableBranchNameMock.mockImplementation(async (name: string) => name);
    findAvailablePathMock.mockImplementation((worktreePath: string) => worktreePath);
    validatePathPatternMock.mockReturnValue({ valid: true });
    resolveWorktreePatternMock.mockResolvedValue("{repo}/{branch}");
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

  it("resolves the forge provider against the repository root", async () => {
    await githubWorkIssueCommand.execute({ cwd: "/repo/sub" } as never, {
      issueNumber: 55,
    });

    expect(resolveForCwdMock).toHaveBeenCalledTimes(1);
    expect(resolveForCwdMock).toHaveBeenCalledWith("/repo");
    expect(getIssueMock).toHaveBeenCalledWith({ owner: "daintree", repo: "app" }, 55);
  });

  it("routes through a non-GitHub provider end-to-end", async () => {
    resolveForCwdMock.mockResolvedValue({
      namespaceId: "builtin.gitlab/gitlab",
      providerId: "gitlab",
      repoRef: { owner: "group", repo: "proj" },
      impl: { getIssue: getIssueMock },
    });
    getIssueMock.mockResolvedValue(
      makeIssue({
        number: 12,
        title: "Add widget",
        url: "https://gitlab.com/group/proj/-/issues/12",
      })
    );

    const result = await githubWorkIssueCommand.execute({ cwd: "/repo" } as never, {
      issueNumber: 12,
    });

    expect(result.success).toBe(true);
    expect(getIssueMock).toHaveBeenCalledWith({ owner: "group", repo: "proj" }, 12);
    expect(result.data?.issueUrl).toBe("https://gitlab.com/group/proj/-/issues/12");
    const workspaceClient = getWorkspaceClientMock.mock.results[0]?.value as {
      createWorktree: ReturnType<typeof vi.fn>;
    };
    expect(workspaceClient.createWorktree).toHaveBeenCalledWith(
      "/repo",
      expect.objectContaining({ newBranch: "issue-12-add-widget" })
    );
  });

  it("is enabled when a forge provider is active and disabled otherwise", () => {
    hasActivatedForgeProviderMock.mockReturnValue(true);
    expect(githubWorkIssueCommand.isEnabled?.({} as never)).toBe(true);
    expect(githubWorkIssueCommand.disabledReason?.({} as never)).toBeUndefined();

    hasActivatedForgeProviderMock.mockReturnValue(false);
    expect(githubWorkIssueCommand.isEnabled?.({} as never)).toBe(false);
    expect(githubWorkIssueCommand.disabledReason?.({} as never)).toMatch(/forge provider/i);
  });

  it("uses the issue URL returned by the forge provider", async () => {
    getIssueMock.mockResolvedValue(
      makeIssue({ url: "https://gitlab.com/daintree/app/-/issues/55" })
    );

    const result = await githubWorkIssueCommand.execute({ cwd: "/repo" } as never, {
      issueNumber: 55,
    });

    expect(result.success).toBe(true);
    expect(result.data?.issueUrl).toBe("https://gitlab.com/daintree/app/-/issues/55");
  });

  it("returns ISSUE_NOT_FOUND when the provider reports no issue", async () => {
    getIssueMock.mockResolvedValue(null);

    const result = await githubWorkIssueCommand.execute({ cwd: "/repo" } as never, {
      issueNumber: 55,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("ISSUE_NOT_FOUND");
  });

  it("returns FORGE_PROVIDER_ERROR with no worktree side-effects when resolution fails", async () => {
    resolveForCwdMock.mockRejectedValue(new Error("No remote URL found for this repository"));

    const result = await githubWorkIssueCommand.execute({ cwd: "/repo" } as never, {
      issueNumber: 55,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("FORGE_PROVIDER_ERROR");
    expect(getIssueMock).not.toHaveBeenCalled();
    expect(findAvailableBranchNameMock).not.toHaveBeenCalled();
    expect(getWorkspaceClientMock).not.toHaveBeenCalled();
  });

  it("normalizes accented Latin characters in slugified branch names", async () => {
    getIssueMock.mockResolvedValue(makeIssue({ title: "Café résumé" }));

    const result = await githubWorkIssueCommand.execute({ cwd: "/repo" } as never, {
      issueNumber: 55,
    });

    expect(result.success).toBe(true);
    expect(findAvailableBranchNameMock).toHaveBeenCalledWith("issue-55-cafe-resume");
  });

  it("normalizes naïve to naive in slugified branch names", async () => {
    getIssueMock.mockResolvedValue(makeIssue({ number: 7, title: "Fix naïve approach" }));

    const result = await githubWorkIssueCommand.execute({ cwd: "/repo" } as never, {
      issueNumber: 7,
    });

    expect(result.success).toBe(true);
    expect(findAvailableBranchNameMock).toHaveBeenCalledWith("issue-7-fix-naive-approach");
  });

  it("prefers trunk over main when develop is absent", async () => {
    listBranchesMock.mockResolvedValue([
      { name: "trunk", remote: false },
      { name: "main", remote: false },
    ]);

    const result = await githubWorkIssueCommand.execute({ cwd: "/repo" } as never, {
      issueNumber: 55,
    });

    expect(result.success).toBe(true);
    const workspaceClient = getWorkspaceClientMock.mock.results[0]?.value as {
      createWorktree: ReturnType<typeof vi.fn>;
    };
    expect(workspaceClient.createWorktree).toHaveBeenCalledWith(
      "/repo",
      expect.objectContaining({ baseBranch: "trunk" })
    );
  });

  it("maps provider TimeoutError to GITHUB_ERROR with timeout message", async () => {
    const timeoutError = new Error("The operation was aborted due to timeout");
    timeoutError.name = "TimeoutError";
    getIssueMock.mockRejectedValue(timeoutError);

    const result = await githubWorkIssueCommand.execute({ cwd: "/repo" } as never, {
      issueNumber: 55,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("GITHUB_ERROR");
    expect(result.error?.message).toContain("Timed out");
  });

  it("maps provider fetch errors with cause.code to GITHUB_ERROR with network message", async () => {
    const transportError = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    });
    getIssueMock.mockRejectedValue(transportError);

    const result = await githubWorkIssueCommand.execute({ cwd: "/repo" } as never, {
      issueNumber: 55,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("GITHUB_ERROR");
    expect(result.error?.message).toContain("Network error");
  });
});
