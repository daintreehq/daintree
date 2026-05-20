import { beforeEach, describe, expect, it, vi } from "vitest";

// `getRepoStatsAndPage` is an orchestration boundary — mock the
// network/auth/repo dependencies and leave the real caches in place so the
// activity-probe gate is exercised end to end. See issue #8757.

const mockClient = vi.fn();

vi.mock("../GitHubAuth.js", () => ({
  GitHubAuth: {
    getToken: vi.fn(() => "test-token"),
    createClient: vi.fn(() => mockClient),
  },
  GITHUB_API_TIMEOUT_MS: 5000,
}));

vi.mock("../GitHubRateLimitService.js", () => ({
  gitHubRateLimitService: {
    updateFromGraphQL: vi.fn(),
    shouldBlockRequest: vi.fn(() => ({ blocked: false, reason: null })),
    getState: vi.fn(() => ({ blocked: false })),
  },
}));

const mockGetRepoContext = vi.fn();
vi.mock("../GitHubRepoContext.js", () => ({
  getRepoContext: (cwd: string) => mockGetRepoContext(cwd),
  isRepoNotFoundError: vi.fn(() => false),
  withRepoContextRetry: vi.fn(),
}));

vi.mock("../GitHubErrors.js", () => ({
  rateLimitMessage: vi.fn(() => "rate limited"),
  parseGitHubError: (e: unknown) => (e instanceof Error ? e.message : "error"),
}));

const mockStatsCache = {
  get: vi.fn(() => undefined),
  set: vi.fn(),
  clear: vi.fn(),
  getForBootstrap: vi.fn(() => undefined),
};
vi.mock("../../../../../electron/services/GitHubStatsCache.js", () => ({
  GitHubStatsCache: { getInstance: () => mockStatsCache },
}));

const mockFirstPageCache = { get: vi.fn(() => undefined), set: vi.fn(), clear: vi.fn() };
vi.mock("../../../../../electron/services/GitHubFirstPageCache.js", () => ({
  GitHubFirstPageCache: { getInstance: () => mockFirstPageCache },
}));

import { getRepoStatsAndPage } from "../GitHubStats.js";
import {
  repoStatsCache,
  issueListCache,
  prListCache,
  repoActivityProbeCache,
  repoStatsAndPageSnapshotCache,
} from "../GitHubCaches.js";

const CACHE_KEY = "testowner/testrepo";

function statsResponse(issueCount = 5, prCount = 3): Record<string, unknown> {
  return {
    repository: {
      issues: {
        totalCount: issueCount,
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [],
      },
      pullRequests: {
        totalCount: prCount,
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [],
      },
    },
    rateLimit: {},
  };
}

function probeResponse(pushedAt: string, issueAt: string, prAt: string): Record<string, unknown> {
  return {
    repository: {
      pushedAt,
      issues: { nodes: [{ updatedAt: issueAt }] },
      pullRequests: { nodes: [{ updatedAt: prAt }] },
    },
    rateLimit: {},
  };
}

function statsQueryCount(): number {
  return mockClient.mock.calls.filter((c) => String(c[0]).includes("GetRepoStatsAndPage")).length;
}

function probeQueryCount(): number {
  return mockClient.mock.calls.filter((c) => String(c[0]).includes("GetRepoActivityProbe")).length;
}

/** Expire the 60s memory caches so the probe gate is reached on the next call. */
function expireMemoryCaches(): void {
  repoStatsCache.clear();
  issueListCache.clear();
  prListCache.clear();
}

describe("getRepoStatsAndPage — activity-probe gate (issue #8757)", () => {
  beforeEach(() => {
    mockClient.mockReset();
    mockGetRepoContext.mockReset();
    mockGetRepoContext.mockResolvedValue({ owner: "testowner", repo: "testrepo" });
    mockStatsCache.get.mockReset();
    mockStatsCache.get.mockReturnValue(undefined);
    repoStatsCache.clear();
    issueListCache.clear();
    prListCache.clear();
    repoActivityProbeCache.clear();
    repoStatsAndPageSnapshotCache.clear();
  });

  it("runs the full stats query and records the probe + snapshot on first fetch", async () => {
    mockClient.mockImplementation(async (query: string) => {
      if (query.includes("GetRepoActivityProbe")) return probeResponse("p1", "i1", "r1");
      return statsResponse(5, 3);
    });

    const result = await getRepoStatsAndPage("/test", false);

    expect(result.source).toBe("network");
    expect(result.stats?.issueCount).toBe(5);
    expect(statsQueryCount()).toBe(1);
    expect(repoActivityProbeCache.get(CACHE_KEY)).toEqual({
      pushedAt: "p1",
      issueUpdatedAt: "i1",
      prUpdatedAt: "r1",
    });
    expect(repoStatsAndPageSnapshotCache.get(CACHE_KEY)).not.toBeUndefined();
  });

  it("skips the full stats query when the probe matches the previous run", async () => {
    mockClient.mockImplementation(async (query: string) => {
      if (query.includes("GetRepoActivityProbe")) return probeResponse("p1", "i1", "r1");
      return statsResponse(5, 3);
    });

    await getRepoStatsAndPage("/test", false);
    expireMemoryCaches();
    const result = await getRepoStatsAndPage("/test", false);

    expect(result.source).toBe("network");
    expect(result.stats?.issueCount).toBe(5);
    // The probe ran twice; the expensive stats query ran only once.
    expect(probeQueryCount()).toBe(2);
    expect(statsQueryCount()).toBe(1);
  });

  it("returns complete stats/issues/prs on a probe-validated cache hit", async () => {
    mockClient.mockImplementation(async (query: string) => {
      if (query.includes("GetRepoActivityProbe")) return probeResponse("p1", "i1", "r1");
      return statsResponse(8, 4);
    });

    await getRepoStatsAndPage("/test", false);
    expireMemoryCaches();
    const result = await getRepoStatsAndPage("/test", false);

    expect(result.stats?.issueCount).toBe(8);
    expect(result.stats?.prCount).toBe(4);
    expect(result.issues).not.toBeNull();
    expect(result.prs).not.toBeNull();
    expect(result.issues?.totalCount).toBe(8);
    expect(result.prs?.totalCount).toBe(4);
  });

  it.each([
    ["pushedAt", probeResponse("p2", "i1", "r1")],
    ["issue updatedAt", probeResponse("p1", "i2", "r1")],
    ["PR updatedAt", probeResponse("p1", "i1", "r2")],
  ])("re-runs the full stats query when %s changed", async (_label, secondProbe) => {
    let probe = probeResponse("p1", "i1", "r1");
    mockClient.mockImplementation(async (query: string) => {
      if (query.includes("GetRepoActivityProbe")) return probe;
      return statsResponse(5, 3);
    });

    await getRepoStatsAndPage("/test", false);
    expireMemoryCaches();
    probe = secondProbe;
    await getRepoStatsAndPage("/test", false);

    expect(statsQueryCount()).toBe(2);
  });

  it("falls through to the full query when the probe request fails", async () => {
    mockClient.mockImplementation(async (query: string) => {
      if (query.includes("GetRepoActivityProbe")) throw new Error("probe boom");
      return statsResponse(5, 3);
    });

    await getRepoStatsAndPage("/test", false);
    expireMemoryCaches();
    const result = await getRepoStatsAndPage("/test", false);

    expect(result.source).toBe("network");
    // Probe failure never gates — both calls ran the expensive query.
    expect(statsQueryCount()).toBe(2);
  });

  it("skips the probe entirely on bypassCache and runs the full query", async () => {
    mockClient.mockImplementation(async (query: string) => {
      if (query.includes("GetRepoActivityProbe")) return probeResponse("p1", "i1", "r1");
      return statsResponse(5, 3);
    });

    await getRepoStatsAndPage("/test", true);

    expect(probeQueryCount()).toBe(0);
    expect(statsQueryCount()).toBe(1);
  });

  it("does not advance the probe or snapshot cache when the full query fails", async () => {
    mockClient.mockImplementation(async (query: string) => {
      if (query.includes("GetRepoActivityProbe")) return probeResponse("p1", "i1", "r1");
      throw new Error("stats boom");
    });

    await getRepoStatsAndPage("/test", false);

    expect(repoActivityProbeCache.get(CACHE_KEY)).toBeUndefined();
    expect(repoStatsAndPageSnapshotCache.get(CACHE_KEY)).toBeUndefined();
  });
});
