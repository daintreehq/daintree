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
  gitHubRateLimitService: {
    onStateChange: vi.fn().mockReturnValue(() => {}),
    shouldBlockRequest: vi.fn().mockReturnValue({ blocked: false, reason: null }),
    getState: vi.fn().mockReturnValue({ blocked: false, kind: null }),
    clear: vi.fn(),
    applyRemoteState: vi.fn(),
    update: vi.fn(),
  },
  GitHubRateLimitError: class GitHubRateLimitError extends Error {
    kind: "primary" | "secondary";
    resumeAt: number;
    constructor(kind: "primary" | "secondary", resumeAt: number) {
      super("rate limited");
      this.kind = kind;
      this.resumeAt = resumeAt;
      this.name = "GitHubRateLimitError";
    }
  },
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

function createETagResponse(status: number, etag?: string): Response {
  const headers = new Headers();
  if (etag) headers.set("etag", etag);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 304 ? "Not Modified" : "OK",
    headers,
  } as unknown as Response;
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

  it("LISTISSUES_SEARCH_OMITTED_SORTORDER_USES_CREATED_DESC", async () => {
    shared.graphqlClient.mockResolvedValueOnce({
      search: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    });

    await github.listIssues({ cwd: "/repo", search: "label:bug" });

    const searchQuery = shared.graphqlClient.mock.calls[0]?.[1]?.searchQuery as string;
    expect(searchQuery).toContain("sort:created-desc");
    expect(searchQuery).not.toContain("sort:updated-desc");
  });

  it("LISTISSUES_SEARCH_CREATED_SORTORDER_USES_CREATED_DESC", async () => {
    shared.graphqlClient.mockResolvedValueOnce({
      search: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    });

    await github.listIssues({ cwd: "/repo", search: "label:bug", sortOrder: "created" });

    const searchQuery = shared.graphqlClient.mock.calls[0]?.[1]?.searchQuery as string;
    expect(searchQuery).toContain("sort:created-desc");
    expect(searchQuery).not.toContain("sort:updated-desc");
  });

  it("LISTISSUES_SEARCH_UPDATED_SORTORDER_USES_UPDATED_DESC", async () => {
    shared.graphqlClient.mockResolvedValueOnce({
      search: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    });

    await github.listIssues({ cwd: "/repo", search: "label:bug", sortOrder: "updated" });

    const searchQuery = shared.graphqlClient.mock.calls[0]?.[1]?.searchQuery as string;
    expect(searchQuery).toContain("sort:updated-desc");
    expect(searchQuery).not.toContain("sort:created-desc");
  });

  it("LISTPRS_SEARCH_OMITTED_SORTORDER_USES_CREATED_DESC", async () => {
    shared.graphqlClient.mockResolvedValueOnce({
      search: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    });

    await github.listPullRequests({ cwd: "/repo", search: "label:bug" });

    const searchQuery = shared.graphqlClient.mock.calls[0]?.[1]?.searchQuery as string;
    expect(searchQuery).toContain("sort:created-desc");
    expect(searchQuery).not.toContain("sort:updated-desc");
  });

  it("LISTPRS_SEARCH_UPDATED_SORTORDER_USES_UPDATED_DESC", async () => {
    shared.graphqlClient.mockResolvedValueOnce({
      search: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    });

    await github.listPullRequests({ cwd: "/repo", search: "label:bug", sortOrder: "updated" });

    const searchQuery = shared.graphqlClient.mock.calls[0]?.[1]?.searchQuery as string;
    expect(searchQuery).toContain("sort:updated-desc");
    expect(searchQuery).not.toContain("sort:created-desc");
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

  it("BATCHCHECK_ALL_UNCHANGED_304_SKIPS_GRAPHQL", async () => {
    // Cycle 1: probe returns 200 with ETag, GraphQL runs, ETag cached.
    vi.mocked(global.fetch).mockResolvedValueOnce(createETagResponse(200, 'W/"abc123"'));
    shared.graphqlClient.mockResolvedValueOnce({
      wt_0_branch: {
        pullRequests: {
          nodes: [
            {
              number: 42,
              title: "PR 42",
              url: "https://github.com/owner/repo/pull/42",
              state: "OPEN",
              isDraft: false,
              merged: false,
            },
          ],
        },
      },
    });

    const first = await github.batchCheckLinkedPRs("/repo", [
      { worktreeId: "wt-1", branchName: "feature/x", knownPRNumber: 42 },
    ]);
    expect(first.results.size).toBe(1);
    expect(shared.graphqlClient).toHaveBeenCalledTimes(1);

    // Cycle 2: probe returns 304 (unchanged), GraphQL must NOT be called.
    vi.mocked(global.fetch).mockResolvedValueOnce(createETagResponse(304));
    shared.graphqlClient.mockClear();

    const second = await github.batchCheckLinkedPRs("/repo", [
      { worktreeId: "wt-1", branchName: "feature/x", knownPRNumber: 42 },
    ]);
    expect(second.results.size).toBe(0);
    expect(shared.graphqlClient).not.toHaveBeenCalled();
  });

  it("BATCHCHECK_ANY_CHANGED_FALLS_THROUGH_TO_GRAPHQL", async () => {
    // Two PRs: one unchanged, one changed. Must still call GraphQL for both.
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(createETagResponse(304))
      .mockResolvedValueOnce(createETagResponse(200, 'W/"new-etag"'));
    shared.graphqlClient.mockResolvedValueOnce({
      wt_0_branch: { pullRequests: { nodes: [] } },
      wt_1_branch: { pullRequests: { nodes: [] } },
    });

    const result = await github.batchCheckLinkedPRs("/repo", [
      { worktreeId: "wt-1", branchName: "feature/a", knownPRNumber: 1 },
      { worktreeId: "wt-2", branchName: "feature/b", knownPRNumber: 2 },
    ]);
    expect(result.results.size).toBe(2);
    expect(shared.graphqlClient).toHaveBeenCalledTimes(1);
  });

  it("BATCHCHECK_PROBE_ERROR_FALLS_THROUGH_TO_GRAPHQL", async () => {
    vi.mocked(global.fetch).mockRejectedValueOnce(new Error("network down"));
    shared.graphqlClient.mockResolvedValueOnce({
      wt_0_branch: { pullRequests: { nodes: [] } },
    });

    const result = await github.batchCheckLinkedPRs("/repo", [
      { worktreeId: "wt-1", branchName: "feature/x", knownPRNumber: 42 },
    ]);
    expect(result.results.size).toBe(1);
    expect(shared.graphqlClient).toHaveBeenCalledTimes(1);
  });

  it("BATCHCHECK_DISCOVERY_WITHOUT_KNOWNPR_SKIPS_ETAG_PROBE", async () => {
    // Discovery path: no knownPRNumber → ETag probe must not run.
    shared.graphqlClient.mockResolvedValueOnce({
      wt_0_branch: { pullRequests: { nodes: [] } },
    });

    await github.batchCheckLinkedPRs("/repo", [
      { worktreeId: "wt-1", branchName: "feature/discovery" },
    ]);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(shared.graphqlClient).toHaveBeenCalledTimes(1);
  });

  it("BATCHCHECK_SECOND_PROBE_SENDS_IF_NONE_MATCH", async () => {
    // Cycle 1 populates the ETag cache.
    vi.mocked(global.fetch).mockResolvedValueOnce(createETagResponse(200, 'W/"xyz-789"'));
    shared.graphqlClient.mockResolvedValueOnce({
      wt_0_branch: { pullRequests: { nodes: [] } },
    });
    await github.batchCheckLinkedPRs("/repo", [
      { worktreeId: "wt-1", branchName: "feature/x", knownPRNumber: 42 },
    ]);

    // Cycle 2 must send the If-None-Match header and target the correct URL.
    let capturedUrl: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;
    vi.mocked(global.fetch).mockImplementationOnce(async (url, init) => {
      capturedUrl = typeof url === "string" ? url : String(url);
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return createETagResponse(304);
    });

    await github.batchCheckLinkedPRs("/repo", [
      { worktreeId: "wt-1", branchName: "feature/x", knownPRNumber: 42 },
    ]);

    expect(capturedUrl).toBe("https://api.github.com/repos/owner/repo/pulls/42");
    expect(capturedHeaders?.["If-None-Match"]).toBe('W/"xyz-789"');
  });

  it("BATCHCHECK_MIXED_DISCOVERY_AND_REVALIDATION_BYPASSES_FAST_PATH", async () => {
    // One candidate with knownPRNumber, one without → fast path must be
    // skipped and GraphQL must run for both.
    shared.graphqlClient.mockResolvedValueOnce({
      wt_0_branch: { pullRequests: { nodes: [] } },
      wt_1_branch: { pullRequests: { nodes: [] } },
    });

    const result = await github.batchCheckLinkedPRs("/repo", [
      { worktreeId: "wt-1", branchName: "feature/known", knownPRNumber: 42 },
      { worktreeId: "wt-2", branchName: "feature/discovery" },
    ]);

    expect(global.fetch).not.toHaveBeenCalled();
    expect(shared.graphqlClient).toHaveBeenCalledTimes(1);
    expect(result.results.size).toBe(2);
  });

  it("BATCHCHECK_DUPLICATE_PR_NUMBERS_PROBED_ONCE", async () => {
    // Two candidates pointing at the same PR number must dedupe to a single
    // REST probe — avoids wasteful duplicate requests when multiple worktrees
    // share a PR.
    vi.mocked(global.fetch).mockResolvedValue(createETagResponse(304));

    await github.batchCheckLinkedPRs("/repo", [
      { worktreeId: "wt-1", branchName: "feature/a", knownPRNumber: 42 },
      { worktreeId: "wt-2", branchName: "feature/b", knownPRNumber: 42 },
    ]);

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("BATCHCHECK_200_WITHOUT_ETAG_CLEARS_STALE_VALIDATOR", async () => {
    // Cycle 1: populate ETag.
    vi.mocked(global.fetch).mockResolvedValueOnce(createETagResponse(200, 'W/"initial"'));
    shared.graphqlClient.mockResolvedValueOnce({
      wt_0_branch: { pullRequests: { nodes: [] } },
    });
    await github.batchCheckLinkedPRs("/repo", [
      { worktreeId: "wt-1", branchName: "feature/x", knownPRNumber: 42 },
    ]);

    // Cycle 2: 200 without ETag → cached validator must be dropped.
    vi.mocked(global.fetch).mockResolvedValueOnce(createETagResponse(200));
    shared.graphqlClient.mockResolvedValueOnce({
      wt_0_branch: { pullRequests: { nodes: [] } },
    });
    await github.batchCheckLinkedPRs("/repo", [
      { worktreeId: "wt-1", branchName: "feature/x", knownPRNumber: 42 },
    ]);

    // Cycle 3: probe must NOT send If-None-Match because the stale validator
    // was dropped in cycle 2.
    let capturedHeaders: Record<string, string> | undefined;
    vi.mocked(global.fetch).mockImplementationOnce(async (_url, init) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return createETagResponse(200, 'W/"fresh"');
    });
    shared.graphqlClient.mockResolvedValueOnce({
      wt_0_branch: { pullRequests: { nodes: [] } },
    });
    await github.batchCheckLinkedPRs("/repo", [
      { worktreeId: "wt-1", branchName: "feature/x", knownPRNumber: 42 },
    ]);

    expect(capturedHeaders?.["If-None-Match"]).toBeUndefined();
  });

  it("BATCHCHECK_ETAG_CLEARED_ON_TOKEN_ROTATION", async () => {
    // Cycle 1: populate ETag cache.
    vi.mocked(global.fetch).mockResolvedValueOnce(createETagResponse(200, 'W/"v1"'));
    shared.graphqlClient.mockResolvedValueOnce({
      wt_0_branch: { pullRequests: { nodes: [] } },
    });
    await github.batchCheckLinkedPRs("/repo", [
      { worktreeId: "wt-1", branchName: "feature/x", knownPRNumber: 42 },
    ]);

    // Rotate token — ETag cache must be cleared.
    github.setGitHubToken("ghp_rotated");

    // Cycle 2: probe should send unconditional GET (no If-None-Match) and
    // treat the 200 response as "changed" (no stored ETag to match against).
    let capturedHeaders: Record<string, string> | undefined;
    vi.mocked(global.fetch).mockImplementationOnce(async (_url, init) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return createETagResponse(200, 'W/"v2"');
    });
    shared.graphqlClient.mockResolvedValueOnce({
      wt_0_branch: { pullRequests: { nodes: [] } },
    });
    await github.batchCheckLinkedPRs("/repo", [
      { worktreeId: "wt-1", branchName: "feature/x", knownPRNumber: 42 },
    ]);

    expect(capturedHeaders?.["If-None-Match"]).toBeUndefined();
  });
});
