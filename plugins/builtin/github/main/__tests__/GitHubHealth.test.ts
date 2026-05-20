import { beforeEach, describe, expect, it, vi } from "vitest";

// `getProjectHealth` is an orchestration boundary — mock the network/auth/repo
// dependencies and leave the real caches (`GitHubCaches`) and query strings
// (`GitHubQueries`) in place so the dedup/velocity behavior is exercised end
// to end. See issue #8757.

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

import { getProjectHealth, buildVelocityCacheKey } from "../GitHubHealth.js";
import { repoStatsCache, velocityCache, projectHealthCache } from "../GitHubCaches.js";

const CACHE_KEY = "testowner/testrepo";

function healthResponse(ciState: string | null = null): Record<string, unknown> {
  return {
    repository: {
      defaultBranchRef: ciState ? { target: { statusCheckRollup: { state: ciState } } } : null,
      latestRelease: null,
      vulnerabilityAlerts: null,
    },
    rateLimit: {},
  };
}

function velocityResponse(c60: number, c120: number, c180: number): Record<string, unknown> {
  return {
    mergedPRs60: { issueCount: c60 },
    mergedPRs120: { issueCount: c120 },
    mergedPRs180: { issueCount: c180 },
    rateLimit: {},
  };
}

function warmVelocity(counts: Record<60 | 120 | 180, number> = { 60: 0, 120: 0, 180: 0 }): void {
  velocityCache.set(buildVelocityCacheKey(CACHE_KEY, new Date()), counts);
}

function velocityQueryCount(): number {
  return mockClient.mock.calls.filter((c) => String(c[0]).includes("GetMergeVelocity")).length;
}

describe("getProjectHealth — issue/PR count dedup", () => {
  beforeEach(() => {
    mockClient.mockReset();
    mockGetRepoContext.mockReset();
    mockGetRepoContext.mockResolvedValue({ owner: "testowner", repo: "testrepo" });
    mockStatsCache.get.mockReset();
    mockStatsCache.get.mockReturnValue(undefined);
    repoStatsCache.clear();
    velocityCache.clear();
    projectHealthCache.clear();
  });

  it("reads issue/PR counts from repoStatsCache instead of re-fetching them", async () => {
    repoStatsCache.set(CACHE_KEY, { issueCount: 12, prCount: 7, lastUpdated: Date.now() });
    warmVelocity();
    mockClient.mockResolvedValue(healthResponse());

    const result = await getProjectHealth("/test", false);

    expect(result.health?.issueCount).toBe(12);
    expect(result.health?.prCount).toBe(7);
    // The only network call was the stripped health query — no count fetch.
    expect(mockClient).toHaveBeenCalledTimes(1);
    expect(String(mockClient.mock.calls[0][0])).toContain("GetProjectHealth");
  });

  it("falls back to the disk stats cache when the memory cache is empty", async () => {
    mockStatsCache.get.mockReturnValue({ issueCount: 9, prCount: 4, lastUpdated: Date.now() });
    warmVelocity();
    mockClient.mockResolvedValue(healthResponse());

    const result = await getProjectHealth("/test", false);

    expect(result.health?.issueCount).toBe(9);
    expect(result.health?.prCount).toBe(4);
  });

  it("returns zero counts on a cold start with no cached stats", async () => {
    warmVelocity();
    mockClient.mockResolvedValue(healthResponse());

    const result = await getProjectHealth("/test", false);

    expect(result.health?.issueCount).toBe(0);
    expect(result.health?.prCount).toBe(0);
  });
});

describe("getProjectHealth — merged-PR velocity cadence", () => {
  beforeEach(() => {
    mockClient.mockReset();
    mockGetRepoContext.mockReset();
    mockGetRepoContext.mockResolvedValue({ owner: "testowner", repo: "testrepo" });
    mockStatsCache.get.mockReset();
    mockStatsCache.get.mockReturnValue(undefined);
    repoStatsCache.clear();
    velocityCache.clear();
    projectHealthCache.clear();
  });

  it("serves merged velocity from the velocity cache without a search query", async () => {
    warmVelocity({ 60: 5, 120: 9, 180: 14 });
    mockClient.mockResolvedValue(healthResponse());

    const result = await getProjectHealth("/test", false);

    expect(result.health?.mergeVelocity.mergedCounts).toEqual({ 60: 5, 120: 9, 180: 14 });
    expect(velocityQueryCount()).toBe(0);
  });

  it("runs the velocity query once on a cold cache, then reuses the cached result", async () => {
    mockClient.mockImplementation(async (query: string) => {
      if (query.includes("GetMergeVelocity")) return velocityResponse(3, 6, 9);
      return healthResponse();
    });

    const first = await getProjectHealth("/test", false);
    expect(first.health?.mergeVelocity.mergedCounts).toEqual({ 60: 3, 120: 6, 180: 9 });
    expect(velocityQueryCount()).toBe(1);

    // A fresh poll (project-health cache expired) must reuse cached velocity.
    projectHealthCache.clear();
    await getProjectHealth("/test", false);
    expect(velocityQueryCount()).toBe(1);
  });

  it("does not re-run the velocity query on bypassCache — velocity is slow-cadence", async () => {
    warmVelocity({ 60: 2, 120: 4, 180: 8 });
    mockClient.mockResolvedValue(healthResponse());

    const result = await getProjectHealth("/test", true);

    expect(result.health?.mergeVelocity.mergedCounts).toEqual({ 60: 2, 120: 4, 180: 8 });
    expect(velocityQueryCount()).toBe(0);
  });

  it("falls back to zero velocity without aborting health when the velocity query fails", async () => {
    mockClient.mockImplementation(async (query: string) => {
      if (query.includes("GetMergeVelocity")) throw new Error("velocity boom");
      return healthResponse("SUCCESS");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await getProjectHealth("/test", false);

    expect(result.health).not.toBeNull();
    expect(result.error).toBeUndefined();
    expect(result.health?.ciStatus).toBe("success");
    expect(result.health?.mergeVelocity.mergedCounts).toEqual({ 60: 0, 120: 0, 180: 0 });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("buildVelocityCacheKey", () => {
  it("changes the key across a UTC day boundary", () => {
    const before = buildVelocityCacheKey("o/r", new Date("2026-05-20T23:59:00Z"));
    const after = buildVelocityCacheKey("o/r", new Date("2026-05-21T00:01:00Z"));
    expect(before).not.toBe(after);
    expect(before).toContain("2026-05-20");
    expect(after).toContain("2026-05-21");
  });

  it("is stable within the same UTC day", () => {
    const morning = buildVelocityCacheKey("o/r", new Date("2026-05-20T00:01:00Z"));
    const evening = buildVelocityCacheKey("o/r", new Date("2026-05-20T23:58:00Z"));
    expect(morning).toBe(evening);
  });
});
