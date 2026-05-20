import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetRemoteUrl = vi.fn();
const mockGetRepositoryRoot = vi.fn();
const mockListRemotes = vi.fn();
const mockGraphqlClient = vi.fn();

vi.mock("../GitService.js", () => {
  class MockGitService {
    getRemoteUrl = mockGetRemoteUrl;
    getRepositoryRoot = mockGetRepositoryRoot;
    listRemotes = mockListRemotes;
  }
  return { GitService: MockGitService };
});

vi.mock("../ProjectStore.js", () => ({
  projectStore: {
    getProjectByPath: vi.fn().mockResolvedValue(null),
    getProjectSettings: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("../../../plugins/builtin/github/main/GitHubAuth.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../plugins/builtin/github/main/GitHubAuth.js")>();
  return {
    ...actual,
    GitHubAuth: {
      createClient: () => mockGraphqlClient,
      getToken: () => "fake-token",
      hasToken: () => true,
      getConfig: () => ({ token: "fake-token" }),
      getConfigAsync: () => Promise.resolve({ token: "fake-token" }),
      setToken: () => {},
      clearToken: () => {},
      validate: () => Promise.resolve({ valid: true, scopes: [] }),
    },
  };
});

vi.mock(
  "../../../plugins/builtin/github/main/GitHubRateLimitService.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../plugins/builtin/github/main/GitHubRateLimitService.js")
      >();
    return {
      ...actual,
      gitHubRateLimitService: {
        shouldBlockRequest: () => ({ blocked: false }),
        update: () => {},
        updateFromGraphQL: () => {},
        getState: () => ({ blocked: false }),
        onStateChange: () => () => {},
      },
    };
  }
);

vi.mock("../GitHubStatsCache.js", () => ({
  GitHubStatsCache: {
    getInstance: () => ({
      get: () => null,
      set: () => {},
      clear: () => {},
      resetInstance: () => {},
    }),
  },
}));

import { getProjectHealth, clearGitHubCaches } from "../../../plugins/builtin/github/main/index.js";
import { velocityCache } from "../../../plugins/builtin/github/main/GitHubCaches.js";
import { buildVelocityCacheKey } from "../../../plugins/builtin/github/main/GitHubHealth.js";

beforeEach(() => {
  clearGitHubCaches();
  vi.restoreAllMocks();
  mockGetRemoteUrl.mockReset();
  mockGraphqlClient.mockReset();
  // Pre-warm the velocity cache for every repo these tests resolve to. The
  // slow-cadence merged-PR velocity query (issue #8757) then makes no GraphQL
  // call, so the retry-guard call counts below count only the health query.
  for (const owner of [
    "old-owner",
    "new-owner",
    "owner-a",
    "owner-b",
    "owner-c",
    "same-owner",
    "owner",
  ]) {
    velocityCache.set(buildVelocityCacheKey(`${owner}/repo`, new Date()), {
      60: 0,
      120: 0,
      180: 0,
    });
  }
});

describe("getProjectHealth retry guard", () => {
  it("retries once when context changes after repo-not-found error", async () => {
    mockGetRemoteUrl
      .mockResolvedValueOnce("https://github.com/old-owner/repo")
      .mockResolvedValueOnce("https://github.com/new-owner/repo")
      .mockResolvedValueOnce("https://github.com/new-owner/repo");

    const healthData = {
      repository: {
        name: "repo",
        owner: { login: "new-owner" },
        description: "test",
        url: "https://github.com/new-owner/repo",
        defaultBranchRef: { name: "main" },
        isArchived: false,
        isFork: false,
        stargazerCount: 10,
        forkCount: 2,
        issues: { totalCount: 5 },
        pullRequests: { totalCount: 3 },
        releases: { nodes: [] },
        licenseInfo: null,
        primaryLanguage: null,
        languages: { nodes: [] },
        repositoryTopics: { nodes: [] },
      },
    };

    mockGraphqlClient
      .mockRejectedValueOnce(new Error("Could not resolve to a Repository"))
      .mockResolvedValueOnce(healthData);

    const result = await getProjectHealth("/test/cwd");

    expect(result.health).not.toBeNull();
    expect(result.error).toBeUndefined();
    expect(mockGraphqlClient).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a second time even if context changes again", async () => {
    mockGetRemoteUrl
      .mockResolvedValueOnce("https://github.com/owner-a/repo")
      .mockResolvedValueOnce("https://github.com/owner-b/repo")
      .mockResolvedValueOnce("https://github.com/owner-c/repo");

    mockGraphqlClient
      .mockRejectedValueOnce(new Error("Could not resolve to a Repository"))
      .mockRejectedValueOnce(new Error("Could not resolve to a Repository"));

    const result = await getProjectHealth("/test/cwd");

    expect(mockGraphqlClient).toHaveBeenCalledTimes(2);
    expect(result.health).toBeNull();
    expect(result.error).toBeDefined();
  });

  it("does NOT retry when fresh context matches original", async () => {
    mockGetRemoteUrl.mockResolvedValue("https://github.com/same-owner/repo");

    mockGraphqlClient.mockRejectedValueOnce(new Error("not found"));

    const result = await getProjectHealth("/test/cwd");

    expect(mockGraphqlClient).toHaveBeenCalledTimes(1);
    expect(result.health).toBeNull();
    expect(result.error).toBeDefined();
  });

  it("partial-data recovery path is not affected by retry guard", async () => {
    mockGetRemoteUrl.mockResolvedValue("https://github.com/owner/repo");

    const partialError = new Error("vulnerabilityAlerts FORBIDDEN") as Error & {
      data: Record<string, unknown>;
    };
    partialError.data = {
      repository: {
        name: "repo",
        owner: { login: "owner" },
        description: "test",
        url: "https://github.com/owner/repo",
        defaultBranchRef: { name: "main" },
        isArchived: false,
        isFork: false,
        stargazerCount: 10,
        forkCount: 2,
        issues: { totalCount: 5 },
        pullRequests: { totalCount: 3 },
        releases: { nodes: [] },
        licenseInfo: null,
        primaryLanguage: null,
        languages: { nodes: [] },
        repositoryTopics: { nodes: [] },
      },
    };

    mockGraphqlClient.mockRejectedValueOnce(partialError);

    const result = await getProjectHealth("/test/cwd");

    expect(mockGraphqlClient).toHaveBeenCalledTimes(1);
    expect(result.health).not.toBeNull();
    expect(result.error).toBeUndefined();
  });
});
