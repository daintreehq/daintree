import { beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({
  tokenState: {
    token: undefined as string | undefined,
  },
  remoteUrl: vi.fn(),
  repositoryRoot: vi.fn(),
  listRemotes: vi.fn(),
  projectByPath: vi.fn(),
  projectSettings: vi.fn(),
  graphqlClient: vi.fn(),
  createClient: vi.fn(),
  diskCache: new Map<string, { issueCount: number; prCount: number; lastUpdated: number }>(),
}));

vi.mock("../GitService.js", () => {
  class MockGitService {
    getRemoteUrl = shared.remoteUrl;
    getRepositoryRoot = shared.repositoryRoot;
    listRemotes = shared.listRemotes;
  }

  return {
    GitService: MockGitService,
  };
});

vi.mock("../ProjectStore.js", () => ({
  projectStore: {
    getProjectByPath: shared.projectByPath,
    getProjectSettings: shared.projectSettings,
  },
}));

vi.mock("../github/index.js", () => ({
  GitHubAuth: {
    createClient: shared.createClient,
    getToken: () => shared.tokenState.token,
    hasToken: () => !!shared.tokenState.token,
    setToken: (token: string) => {
      shared.tokenState.token = token;
    },
    clearToken: () => {
      shared.tokenState.token = undefined;
    },
    getConfig: () => ({ token: shared.tokenState.token }),
    getConfigAsync: () => Promise.resolve({ token: shared.tokenState.token }),
    validate: vi.fn(),
  },
  GITHUB_API_TIMEOUT_MS: 15_000,
  REPO_STATS_QUERY: "REPO_STATS_QUERY",
  PROJECT_HEALTH_QUERY: "PROJECT_HEALTH_QUERY",
  LIST_ISSUES_QUERY: "LIST_ISSUES_QUERY",
  LIST_PRS_QUERY: "LIST_PRS_QUERY",
  SEARCH_QUERY: "SEARCH_QUERY",
  GET_ISSUE_QUERY: "GET_ISSUE_QUERY",
  GET_PR_QUERY: "GET_PR_QUERY",
  buildBatchPRQuery: vi.fn(),
}));

vi.mock("../GitHubStatsCache.js", () => ({
  GitHubStatsCache: {
    getInstance: () => ({
      get: (key: string) => shared.diskCache.get(key) ?? null,
      set: (key: string, value: { issueCount: number; prCount: number; lastUpdated?: number }) => {
        shared.diskCache.set(key, {
          issueCount: value.issueCount,
          prCount: value.prCount,
          lastUpdated: value.lastUpdated ?? Date.now(),
        });
      },
      resetInstance: () => {
        shared.diskCache.clear();
      },
    }),
  },
}));

type GitHubServiceModule = typeof import("../GitHubService.js");

function timeoutError(message: string): Error {
  const error = new Error(message);
  error.name = "TimeoutError";
  return error;
}

function createResponse(options: {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
}): Response {
  return {
    ok: options.ok,
    status: options.status,
    statusText: options.statusText,
    json: options.json,
  } as Response;
}

function buildIssueNode(
  overrides?: Partial<{ assignees: Array<{ login: string; avatarUrl: string }> }>
) {
  return {
    number: 7,
    title: "Issue 7",
    url: "https://github.com/owner/repo/issues/7",
    state: "OPEN",
    updatedAt: "2026-01-01T00:00:00Z",
    author: { login: "alice", avatarUrl: "https://avatars.example/alice" },
    assignees: { nodes: overrides?.assignees ?? [] },
    comments: { totalCount: 0 },
    labels: { nodes: [] },
    timelineItems: { nodes: [] },
  };
}

describe("GitHubService adversarial", () => {
  let github: GitHubServiceModule;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    shared.tokenState.token = "ghp_test_token";
    shared.remoteUrl.mockResolvedValue("https://github.com/owner/repo");
    shared.repositoryRoot.mockResolvedValue("/repo");
    shared.listRemotes.mockResolvedValue([]);
    shared.projectByPath.mockResolvedValue(null);
    shared.projectSettings.mockResolvedValue({});
    shared.createClient.mockImplementation(() =>
      shared.tokenState.token ? shared.graphqlClient : null
    );
    shared.graphqlClient.mockReset();
    shared.diskCache.clear();
    vi.stubGlobal("fetch", vi.fn());

    github = await import("../GitHubService.js");
    github.clearGitHubCaches();
  });

  it("GETREPOSTATS_429_RETURNS_STALE_CACHE", async () => {
    shared.diskCache.set("owner/repo", {
      issueCount: 11,
      prCount: 5,
      lastUpdated: 123,
    });
    shared.graphqlClient.mockRejectedValueOnce(new Error("API rate limit exceeded"));

    await expect(github.getRepoStats("/repo")).resolves.toEqual({
      stats: {
        issueCount: 11,
        prCount: 5,
        stale: true,
        lastUpdated: 123,
      },
      error: "GitHub rate limit exceeded. Try again in a few minutes.",
    });
  });

  it("LISTISSUES_TIMEOUT_MAPS_TO_NETWORK_ERROR", async () => {
    shared.graphqlClient.mockRejectedValueOnce(timeoutError("request timed out"));

    await expect(github.listIssues({ cwd: "/repo" })).rejects.toThrow(
      "Cannot reach GitHub. Check your internet connection."
    );
  });

  it("LISTPRS_MISSING_REPOSITORY_FAILS_NOT_EMPTY", async () => {
    shared.graphqlClient.mockResolvedValueOnce({});

    await expect(github.listPullRequests({ cwd: "/repo" })).rejects.toThrow(
      "Repository not found or token lacks access."
    );
  });

  it("ASSIGNISSUE_MALFORMED_JSON_NO_CACHE_UPDATE", async () => {
    shared.graphqlClient.mockResolvedValueOnce({
      repository: {
        issues: {
          nodes: [buildIssueNode()],
          totalCount: 1,
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    });

    const cachedBefore = await github.listIssues({ cwd: "/repo" });

    vi.mocked(global.fetch).mockResolvedValueOnce(
      createResponse({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.reject(new Error("Unexpected end of JSON input")),
      })
    );

    await expect(github.assignIssue("/repo", 7, "bob")).rejects.toThrow(
      "GitHub API error: Unexpected end of JSON input"
    );

    const cachedAfter = await github.listIssues({ cwd: "/repo" });
    expect(cachedAfter.items[0]?.assignees).toEqual(cachedBefore.items[0]?.assignees);
    expect(shared.graphqlClient).toHaveBeenCalledTimes(1);
  });

  it("ASSIGNISSUE_MISSING_ASSIGNEE_FAILS_LOUD", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      createResponse({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () =>
          Promise.resolve({
            assignees: [],
          }),
      })
    );

    await expect(github.assignIssue("/repo", 7, "bob")).rejects.toThrow(
      'Assignment succeeded but user "bob" not found in response'
    );
  });

  it("AUTH_FAILURE_NOT_CACHED_ACROSS_RECOVERY", async () => {
    shared.tokenState.token = undefined;

    await expect(github.getRepoStats("/repo")).resolves.toEqual({
      stats: null,
      error: "GitHub token not configured. Set it in Settings.",
    });

    github.setGitHubToken("ghp_recovered");
    shared.graphqlClient.mockResolvedValueOnce({
      repository: {
        issues: { totalCount: 3 },
        pullRequests: { totalCount: 2 },
      },
    });

    await expect(github.getRepoStats("/repo", true)).resolves.toEqual({
      stats: {
        issueCount: 3,
        prCount: 2,
        lastUpdated: expect.any(Number),
      },
    });
  });

  it("401_VS_403_DISTINCT_MESSAGES", async () => {
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(
        createResponse({
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          json: () => Promise.resolve({}),
        })
      )
      .mockResolvedValueOnce(
        createResponse({
          ok: false,
          status: 403,
          statusText: "Forbidden",
          json: () => Promise.resolve({}),
        })
      );

    await expect(github.assignIssue("/repo", 7, "bob")).rejects.toThrow(
      "Invalid GitHub token. Please update in Settings."
    );
    await expect(github.assignIssue("/repo", 7, "bob")).rejects.toThrow(
      "Token lacks required permissions. Required scopes: repo, read:org"
    );
  });

  it("NULLABLE_MISSING_FIELDS_SAFE_DEFAULTS", async () => {
    shared.graphqlClient
      .mockResolvedValueOnce({
        repository: {},
      })
      .mockResolvedValueOnce({
        repository: {
          defaultBranchRef: null,
          latestRelease: null,
          vulnerabilityAlerts: null,
        },
      });

    const repoStats = await github.getRepoStats("/repo", true);
    const projectHealth = await github.getProjectHealth("/repo", true);

    expect(repoStats).toEqual({
      stats: {
        issueCount: 0,
        prCount: 0,
        lastUpdated: expect.any(Number),
      },
    });
    expect(projectHealth).toEqual({
      health: {
        ciStatus: "none",
        issueCount: 0,
        prCount: 0,
        latestRelease: null,
        securityAlerts: {
          visible: false,
          count: 0,
        },
        mergeVelocity: {
          mergedCounts: {
            60: 0,
            120: 0,
            180: 0,
          },
        },
        repoUrl: "https://github.com/owner/repo",
        lastUpdated: expect.any(Number),
      },
    });
  });
});
