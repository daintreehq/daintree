import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatErrorMessage } from "../../../../../shared/utils/errorMessage.js";

// `getRepoStatsAndPage` is an orchestration boundary — mock the
// network/auth/repo dependencies and leave the real caches in place so the
// activity-probe gate and the REST count path are exercised end to end. The
// explicit-refresh stats query goes through the mocked GraphQL client; the
// REST `/events` probe and the count pair (`/repos/{owner}/{repo}` +
// `/pulls?state=open&per_page=1`) go through the mocked `rateLimitAwareFetch`.
// See issues #8757, #9041, and #10122.

const mockClient = vi.fn();
const mockFetch = vi.fn();

vi.mock("../GitHubAuth.js", () => ({
  GitHubAuth: {
    getToken: vi.fn(() => "test-token"),
    createClient: vi.fn(() => mockClient),
  },
  rateLimitAwareFetch: (input: unknown, init?: unknown) => mockFetch(input, init),
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
  parseGitHubError: (e: unknown) => formatErrorMessage(e, "error"),
}));

const mockStatsCache = {
  get: vi.fn<
    (
      repoKey: string
    ) => { issueCount: number; prCount: number; lastUpdated: number; projectPath: string } | null
  >(() => null),
  set: vi.fn(),
  clear: vi.fn(),
  getForBootstrap: vi.fn<
    (
      repoKey: string,
      maxAgeMs?: number
    ) => { issueCount: number; prCount: number; lastUpdated: number; projectPath: string } | null
  >(() => null),
};
vi.mock("../../../../../electron/services/GitHubStatsCache.js", () => ({
  GitHubStatsCache: { getInstance: () => mockStatsCache },
}));

const mockFirstPageCache = { get: vi.fn(() => undefined), set: vi.fn(), clear: vi.fn() };
vi.mock("../../../../../electron/services/GitHubFirstPageCache.js", () => ({
  GitHubFirstPageCache: { getInstance: () => mockFirstPageCache },
}));

import { getRepoStatsAndPage, parseLinkLastPage } from "../GitHubStats.js";
import {
  repoStatsCache,
  issueListCache,
  prListCache,
  repoStatsAndPageSnapshotCache,
  restCountsCache,
  repoEventsETagCache,
  repoEventsPollIntervalCache,
  repoEventsNoChangeCount,
  repoEventsLastProbeAt,
  clearPRCaches,
} from "../GitHubCaches.js";
import { gitHubRateLimitService } from "../GitHubRateLimitService.js";

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

interface FakeResponse {
  status: number;
  headers: { get: (name: string) => string | null };
  json: () => Promise<unknown>;
}

/** A minimal `Response`-like — `status`, `headers.get`, and `json()`. */
function restResponse(
  status: number,
  opts: { etag?: string; link?: string; pollInterval?: string; body?: unknown } = {}
): FakeResponse {
  const headers = new Map<string, string>();
  if (opts.etag !== undefined) headers.set("etag", opts.etag);
  if (opts.link !== undefined) headers.set("link", opts.link);
  if (opts.pollInterval !== undefined) headers.set("x-poll-interval", opts.pollInterval);
  return {
    status,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    json: async () => opts.body,
  };
}

function eventsResponse(
  status: number,
  opts: { etag?: string; pollInterval?: string } = {}
): FakeResponse {
  return restResponse(status, opts);
}

/** `GET /repos/{owner}/{repo}` — 200 with `open_issues_count` (issues + PRs combined). */
function repoOk(openIssuesCount: number, etag = '"r1"'): FakeResponse {
  return restResponse(200, { etag, body: { open_issues_count: openIssuesCount } });
}

/**
 * `GET /repos/{owner}/{repo}/pulls?state=open&per_page=1` — 200 whose
 * `Link: rel="last"` page number is the total open PR count. GitHub omits the
 * header entirely when everything fits on one page (0 or 1 PRs), so those
 * counts come from the body array length.
 */
function pullsOk(prCount: number, etag = '"p1"'): FakeResponse {
  if (prCount >= 2) {
    const link =
      `<https://api.github.com/repositories/1/pulls?state=open&per_page=1&page=2>; rel="next", ` +
      `<https://api.github.com/repositories/1/pulls?state=open&per_page=1&page=${prCount}>; rel="last"`;
    return restResponse(200, { etag, link, body: [{}] });
  }
  return restResponse(200, { etag, body: prCount === 1 ? [{}] : [] });
}

/**
 * Route the fetch mock per endpoint. Each queue is consumed in order; the last
 * entry is sticky (mirrors `mockResolvedValueOnce` + `mockResolvedValue`).
 */
function routeFetch(routes: {
  events?: FakeResponse[];
  repo?: FakeResponse[];
  pulls?: FakeResponse[];
}): void {
  const queues = {
    events: [...(routes.events ?? [])],
    repo: [...(routes.repo ?? [])],
    pulls: [...(routes.pulls ?? [])],
  };
  mockFetch.mockImplementation((input: unknown) => {
    const url = String(input);
    const key = url.includes("/events")
      ? "events"
      : url.includes("/pulls")
        ? "pulls"
        : ("repo" as const);
    const queue = queues[key as keyof typeof queues];
    if (queue.length === 0) {
      return Promise.reject(new Error(`unexpected ${key} request: ${url}`));
    }
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    return Promise.resolve(next);
  });
}

function statsQueryCount(): number {
  return mockClient.mock.calls.filter((c) => String(c[0]).includes("GetRepoStatsAndPage")).length;
}

function callsTo(part: string): Array<[unknown, { headers: Record<string, string> }]> {
  return mockFetch.mock.calls.filter((c) => String(c[0]).includes(part)) as Array<
    [unknown, { headers: Record<string, string> }]
  >;
}

function probeRestCallCount(): number {
  return callsTo("/events").length;
}

function repoCallCount(): number {
  return mockFetch.mock.calls.filter((c) => /\/repos\/testowner\/testrepo$/.test(String(c[0])))
    .length;
}

function pullsCallCount(): number {
  return callsTo("/pulls?state=open&per_page=1").length;
}

/** Expire the 60s memory caches so the probe gate is reached on the next call. */
function expireMemoryCaches(): void {
  repoStatsCache.clear();
  issueListCache.clear();
  prListCache.clear();
}

/** Clear the last-probe timestamp so the adaptive backoff window no longer
 *  suppresses the next probe (forces a fresh `/events` request). */
function expireBackoffWindow(): void {
  repoEventsLastProbeAt.clear();
}

describe("parseLinkLastPage", () => {
  it("extracts the rel=last page number from a realistic GitHub Link header", () => {
    const link =
      `<https://api.github.com/repositories/1/pulls?state=open&per_page=1&page=2>; rel="next", ` +
      `<https://api.github.com/repositories/1/pulls?state=open&per_page=1&page=47>; rel="last"`;
    expect(parseLinkLastPage(link)).toBe(47);
  });

  it("returns null when the header is absent", () => {
    expect(parseLinkLastPage(null)).toBeNull();
  });

  it("returns null when no rel=last segment exists", () => {
    expect(parseLinkLastPage(`<https://api.github.com/x?page=2>; rel="next"`)).toBeNull();
  });

  it("returns null on a malformed header", () => {
    expect(parseLinkLastPage("not a link header")).toBeNull();
  });
});

describe("getRepoStatsAndPage — decoupled REST count poll (issue #10122)", () => {
  beforeEach(() => {
    mockClient.mockReset();
    mockFetch.mockReset();
    mockGetRepoContext.mockReset();
    mockGetRepoContext.mockResolvedValue({ owner: "testowner", repo: "testrepo" });
    mockStatsCache.get.mockReset();
    mockStatsCache.get.mockReturnValue(null);
    vi.mocked(gitHubRateLimitService.shouldBlockRequest).mockReturnValue({
      blocked: false,
      reason: null,
    });
    repoStatsCache.clear();
    issueListCache.clear();
    prListCache.clear();
    repoStatsAndPageSnapshotCache.clear();
    restCountsCache.clear();
    repoEventsETagCache.clear();
    repoEventsPollIntervalCache.clear();
    repoEventsNoChangeCount.clear();
    repoEventsLastProbeAt.clear();
  });

  it("fetches counts via the REST pair on a background poll — never the GraphQL page query", async () => {
    routeFetch({
      events: [eventsResponse(200, { etag: '"e1"' })],
      repo: [repoOk(8)],
      pulls: [pullsOk(3)],
    });

    const result = await getRepoStatsAndPage("/test", false);

    expect(result.source).toBe("network");
    // issueCount = open_issues_count (combined) − PR count.
    expect(result.stats?.issueCount).toBe(5);
    expect(result.stats?.prCount).toBe(3);
    expect(result.issues).toBeNull();
    expect(result.prs).toBeNull();
    expect(result.nextPollIntervalMs).toBe(60_000);
    expect(statsQueryCount()).toBe(0);
    // The events ETag committed in lockstep with the counts.
    expect(repoEventsETagCache.get(CACHE_KEY)).toBe('"e1"');
    // Counts + their ETags committed as one baseline.
    expect(restCountsCache.get(CACHE_KEY)).toMatchObject({
      combinedCount: 8,
      prCount: 3,
      repoEtag: '"r1"',
      prEtag: '"p1"',
    });
  });

  it("writes the durable disk cache on a REST count success", async () => {
    routeFetch({
      events: [eventsResponse(200, { etag: '"e1"' })],
      repo: [repoOk(8)],
      pulls: [pullsOk(3)],
    });

    await getRepoStatsAndPage("/test", false);

    expect(mockStatsCache.set).toHaveBeenCalledWith(
      CACHE_KEY,
      expect.objectContaining({ issueCount: 5, prCount: 3 }),
      "/test"
    );
  });

  it("sends If-None-Match on both REST legs once a baseline exists and replays counts on 304", async () => {
    routeFetch({
      events: [eventsResponse(200, { etag: '"e1"' }), eventsResponse(200, { etag: '"e2"' })],
      repo: [repoOk(8, '"r1"'), restResponse(304)],
      pulls: [pullsOk(3, '"p1"'), restResponse(304)],
    });

    await getRepoStatsAndPage("/test", false);
    expireMemoryCaches();
    expireBackoffWindow();
    const result = await getRepoStatsAndPage("/test", false);

    expect(result.stats?.issueCount).toBe(5);
    expect(result.stats?.prCount).toBe(3);
    const repoCalls = callsTo("/repos/testowner/testrepo");
    const repoInits = repoCalls.filter((c) => /\/repos\/testowner\/testrepo$/.test(String(c[0])));
    expect(repoInits[0][1].headers["If-None-Match"]).toBeUndefined();
    expect(repoInits[1][1].headers["If-None-Match"]).toBe('"r1"');
    const pullsInits = callsTo("/pulls?state=open&per_page=1");
    expect(pullsInits[0][1].headers["If-None-Match"]).toBeUndefined();
    expect(pullsInits[1][1].headers["If-None-Match"]).toBe('"p1"');
    // The changed probe's new events ETag committed after the 304 replay.
    expect(repoEventsETagCache.get(CACHE_KEY)).toBe('"e2"');
  });

  it("combines a fresh 200 on one leg with a 304 replay on the other against the same baseline", async () => {
    routeFetch({
      events: [eventsResponse(200, { etag: '"e1"' }), eventsResponse(200, { etag: '"e2"' })],
      repo: [repoOk(8, '"r1"'), repoOk(9, '"r2"')],
      pulls: [pullsOk(3, '"p1"'), restResponse(304)],
    });

    await getRepoStatsAndPage("/test", false);
    expireMemoryCaches();
    expireBackoffWindow();
    const result = await getRepoStatsAndPage("/test", false);

    expect(result.stats?.issueCount).toBe(6); // 9 combined − 3 replayed PRs
    expect(result.stats?.prCount).toBe(3);
    expect(restCountsCache.get(CACHE_KEY)).toMatchObject({
      combinedCount: 9,
      repoEtag: '"r2"',
      prEtag: '"p1"',
    });
  });

  it("derives PR counts of 0 and 1 from the body when GitHub omits the Link header", async () => {
    routeFetch({
      events: [eventsResponse(200, { etag: '"e1"' })],
      repo: [repoOk(4)],
      pulls: [pullsOk(0)],
    });
    const zero = await getRepoStatsAndPage("/test", false);
    expect(zero.stats?.prCount).toBe(0);
    expect(zero.stats?.issueCount).toBe(4);

    expireMemoryCaches();
    expireBackoffWindow();
    restCountsCache.clear();
    routeFetch({
      events: [eventsResponse(200, { etag: '"e1"' })],
      repo: [repoOk(4)],
      pulls: [pullsOk(1)],
    });
    const one = await getRepoStatsAndPage("/test", false);
    expect(one.stats?.prCount).toBe(1);
    expect(one.stats?.issueCount).toBe(3);
  });

  it("reuses the last REST counts on an unchanged probe without touching the count endpoints", async () => {
    routeFetch({
      events: [eventsResponse(200, { etag: '"e1"' }), eventsResponse(304)],
      repo: [repoOk(8)],
      pulls: [pullsOk(3)],
    });

    await getRepoStatsAndPage("/test", false);
    expireMemoryCaches();
    expireBackoffWindow();
    const result = await getRepoStatsAndPage("/test", false);

    expect(result.source).toBe("network");
    expect(result.stats?.issueCount).toBe(5);
    expect(result.stats?.prCount).toBe(3);
    expect(probeRestCallCount()).toBe(2);
    // The cheap 304 served the counts — no second hit on either count endpoint.
    expect(repoCallCount()).toBe(1);
    expect(pullsCallCount()).toBe(1);
  });

  it("skips even the probe while inside the adaptive window once REST counts exist", async () => {
    routeFetch({
      events: [eventsResponse(200, { etag: '"e1"' })],
      repo: [repoOk(8)],
      pulls: [pullsOk(3)],
    });

    await getRepoStatsAndPage("/test", false);
    const fetchCallsAfterFirst = mockFetch.mock.calls.length;

    // Only the 60s memory cache expires; the backoff window is still open, so
    // the second poll serves the last REST counts without touching the network.
    expireMemoryCaches();
    const result = await getRepoStatsAndPage("/test", false);

    expect(result.source).toBe("network");
    expect(result.stats?.issueCount).toBe(5);
    expect(mockFetch.mock.calls.length).toBe(fetchCallsAfterFirst);
  });

  it("serves the disk fallback and keeps the old events ETag when a REST leg fails", async () => {
    routeFetch({
      events: [eventsResponse(200, { etag: '"e1"' }), eventsResponse(200, { etag: '"e2"' })],
      repo: [repoOk(8), restResponse(500)],
      pulls: [pullsOk(3)],
    });
    mockStatsCache.get.mockReturnValue({
      issueCount: 5,
      prCount: 3,
      lastUpdated: 123,
      projectPath: "/test",
    });

    await getRepoStatsAndPage("/test", false);
    expect(repoEventsETagCache.get(CACHE_KEY)).toBe('"e1"');

    expireMemoryCaches();
    expireBackoffWindow();
    const result = await getRepoStatsAndPage("/test", false);

    expect(result.stats?.stale).toBe(true);
    expect(result.stats?.issueCount).toBe(5);
    expect(result.error).toBeDefined();
    expect(result.issues).toBeNull();
    // The failed count fetch must not advance the events ETag — the next probe
    // re-detects the change instead of masking it behind a 304.
    expect(repoEventsETagCache.get(CACHE_KEY)).toBe('"e1"');
    expect(statsQueryCount()).toBe(0);
  });

  it("returns an error result when REST counts fail with no disk fallback", async () => {
    routeFetch({
      events: [eventsResponse(200, { etag: '"e1"' })],
      repo: [restResponse(500)],
      pulls: [pullsOk(3)],
    });

    const result = await getRepoStatsAndPage("/test", false);

    expect(result.stats).toBeNull();
    expect(result.error).toBe("Couldn't fetch repository counts");
  });

  it("rejects a negative derived issue count and keeps the prior baseline", async () => {
    routeFetch({
      events: [eventsResponse(200, { etag: '"e1"' }), eventsResponse(200, { etag: '"e2"' })],
      repo: [repoOk(8, '"r1"'), repoOk(1, '"r2"')],
      pulls: [pullsOk(3, '"p1"'), pullsOk(3, '"p2"')],
    });

    await getRepoStatsAndPage("/test", false);
    expireMemoryCaches();
    expireBackoffWindow();
    const result = await getRepoStatsAndPage("/test", false);

    // 1 combined − 3 PRs is impossible — a cross-endpoint race. No commit.
    expect(result.error).toBeDefined();
    expect(restCountsCache.get(CACHE_KEY)).toMatchObject({
      combinedCount: 8,
      prCount: 3,
      repoEtag: '"r1"',
    });
    expect(repoEventsETagCache.get(CACHE_KEY)).toBe('"e1"');
  });

  it("rejects a malformed repo body (missing open_issues_count)", async () => {
    routeFetch({
      events: [eventsResponse(200, { etag: '"e1"' })],
      repo: [restResponse(200, { etag: '"r1"', body: {} })],
      pulls: [pullsOk(3)],
    });

    const result = await getRepoStatsAndPage("/test", false);

    expect(result.stats).toBeNull();
    expect(result.error).toBeDefined();
    expect(restCountsCache.get(CACHE_KEY)).toBeUndefined();
  });

  it("serves the rate-limit message when the core bucket is blocked", async () => {
    vi.mocked(gitHubRateLimitService.shouldBlockRequest).mockImplementation((resource?: string) =>
      resource === "core"
        ? { blocked: true, reason: "primary", resumeAt: Date.now() + 1000 }
        : { blocked: false, reason: null }
    );
    mockStatsCache.get.mockReturnValue({
      issueCount: 5,
      prCount: 3,
      lastUpdated: 123,
      projectPath: "/test",
    });

    const result = await getRepoStatsAndPage("/test", false);

    expect(result.stats?.stale).toBe(true);
    expect(result.error).toBe("rate limited");
    expect(mockFetch).not.toHaveBeenCalled();
    expect(statsQueryCount()).toBe(0);
  });

  it("is unaffected by a depleted GraphQL bucket on the background path", async () => {
    vi.mocked(gitHubRateLimitService.shouldBlockRequest).mockImplementation((resource?: string) =>
      resource === "graphql"
        ? { blocked: true, reason: "primary", resumeAt: Date.now() + 1000 }
        : { blocked: false, reason: null }
    );
    routeFetch({
      events: [eventsResponse(200, { etag: '"e1"' })],
      repo: [repoOk(8)],
      pulls: [pullsOk(3)],
    });

    const result = await getRepoStatsAndPage("/test", false);

    expect(result.stats?.issueCount).toBe(5);
    expect(result.error).toBeUndefined();
    expect(statsQueryCount()).toBe(0);
  });

  describe("bypassCache (explicit refresh) path", () => {
    it("runs the full GraphQL page query, writes the snapshot, and skips the probe + REST counts", async () => {
      mockClient.mockResolvedValue(statsResponse(5, 3));
      routeFetch({});

      const result = await getRepoStatsAndPage("/test", true);

      expect(result.stats?.issueCount).toBe(5);
      expect(result.issues).not.toBeNull();
      expect(result.prs).not.toBeNull();
      expect(statsQueryCount()).toBe(1);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(repoStatsAndPageSnapshotCache.get(CACHE_KEY)).not.toBeUndefined();
    });

    it("does not advance the snapshot cache when the GraphQL query fails", async () => {
      mockClient.mockRejectedValue(new Error("stats boom"));
      routeFetch({});

      await getRepoStatsAndPage("/test", true);

      expect(repoStatsAndPageSnapshotCache.get(CACHE_KEY)).toBeUndefined();
    });

    it("resets the backoff cadence so the next background poll re-probes", async () => {
      routeFetch({
        events: [eventsResponse(200, { etag: '"e1"' }), eventsResponse(304)],
        repo: [repoOk(8)],
        pulls: [pullsOk(3)],
      });

      await getRepoStatsAndPage("/test", false);
      expireMemoryCaches();
      expireBackoffWindow();
      await getRepoStatsAndPage("/test", false); // 304 -> count 1
      expect(repoEventsNoChangeCount.get(CACHE_KEY)).toBe(1);

      mockClient.mockResolvedValue(statsResponse(5, 3));
      await getRepoStatsAndPage("/test", true); // bypassCache resets the cadence
      expect(repoEventsNoChangeCount.get(CACHE_KEY)).toBeUndefined();
      expect(repoEventsLastProbeAt.get(CACHE_KEY)).toBeUndefined();
    });
  });

  describe("probe + snapshot interplay", () => {
    it("serves the full snapshot pages on an unchanged probe", async () => {
      mockClient.mockResolvedValue(statsResponse(8, 4));
      routeFetch({ events: [eventsResponse(304)] });

      await getRepoStatsAndPage("/test", true); // seed snapshot via explicit refresh
      expireMemoryCaches();
      const result = await getRepoStatsAndPage("/test", false);

      expect(result.source).toBe("network");
      expect(result.stats?.issueCount).toBe(8);
      expect(result.issues).not.toBeNull();
      expect(result.prs).not.toBeNull();
      expect(result.issues?.totalCount).toBe(8);
      expect(statsQueryCount()).toBe(1);
      expect(repoCallCount()).toBe(0);
      expect(pullsCallCount()).toBe(0);
    });

    it("does not re-stamp the snapshot TTL on a probe-match hit (keeps the 10-min staleness cap)", async () => {
      mockClient.mockResolvedValue(statsResponse(5, 3));
      routeFetch({ events: [eventsResponse(304)] });

      await getRepoStatsAndPage("/test", true);
      const snapshotBefore = repoStatsAndPageSnapshotCache.get(CACHE_KEY);

      expireMemoryCaches();
      await getRepoStatsAndPage("/test", false);

      expect(repoStatsAndPageSnapshotCache.get(CACHE_KEY)).toBe(snapshotBefore);
    });

    it("serves REST-fresher counts with the snapshot pages on an unchanged probe", async () => {
      // Explicit refresh writes the snapshot (5 issues / 3 PRs)…
      mockClient.mockResolvedValue(statsResponse(5, 3));
      routeFetch({
        events: [eventsResponse(200, { etag: '"e1"' }), eventsResponse(304)],
        repo: [repoOk(12)],
        pulls: [pullsOk(2)],
      });
      await getRepoStatsAndPage("/test", true);

      // …then a background REST poll observes fresher counts (10 / 2)…
      expireMemoryCaches();
      await getRepoStatsAndPage("/test", false);

      // …so a later unchanged probe must not roll the pill back to 5 / 3.
      expireMemoryCaches();
      expireBackoffWindow();
      const result = await getRepoStatsAndPage("/test", false);

      expect(result.stats?.issueCount).toBe(10);
      expect(result.stats?.prCount).toBe(2);
      expect(result.issues).not.toBeNull();
      expect(result.prs).not.toBeNull();
    });

    it("re-fetches REST counts after clearPRCaches drops the baselines", async () => {
      routeFetch({
        events: [eventsResponse(200, { etag: '"e1"' })],
        repo: [repoOk(8, '"r1"')],
        pulls: [pullsOk(3, '"p1"')],
      });

      await getRepoStatsAndPage("/test", false);
      expireMemoryCaches();
      // A user-initiated GitHub refresh must force fresh 200s, not 304 replays.
      clearPRCaches();
      routeFetch({
        events: [eventsResponse(200, { etag: '"e2"' })],
        repo: [repoOk(9, '"r2"')],
        pulls: [pullsOk(4, '"p2"')],
      });
      const result = await getRepoStatsAndPage("/test", false);

      expect(result.stats?.issueCount).toBe(5);
      expect(result.stats?.prCount).toBe(4);
      // Neither leg carried a stale If-None-Match after the clear.
      const repoInits = mockFetch.mock.calls
        .filter((c) => /\/repos\/testowner\/testrepo$/.test(String(c[0])))
        .map((c) => c[1] as { headers: Record<string, string> });
      expect(repoInits[1].headers["If-None-Match"]).toBeUndefined();
    });
  });

  describe("adaptive backoff cadence (issues #9041, #9741)", () => {
    it("stores the server-advertised X-Poll-Interval as the backoff floor (ms)", async () => {
      routeFetch({
        events: [eventsResponse(200, { etag: '"e1"', pollInterval: "120" })],
        repo: [repoOk(8)],
        pulls: [pullsOk(3)],
      });

      await getRepoStatsAndPage("/test", false);

      expect(repoEventsPollIntervalCache.get(CACHE_KEY)).toBe(120_000);
    });

    it("increments the consecutive-no-change counter on each 304 and resets on a 200", async () => {
      routeFetch({
        events: [
          eventsResponse(200, { etag: '"e1"' }),
          eventsResponse(304),
          eventsResponse(304),
          eventsResponse(200, { etag: '"e2"' }),
        ],
        repo: [repoOk(8)],
        pulls: [pullsOk(3)],
      });

      await getRepoStatsAndPage("/test", false); // 200 -> count 0
      expect(repoEventsNoChangeCount.get(CACHE_KEY)).toBe(0);

      expireMemoryCaches();
      expireBackoffWindow();
      await getRepoStatsAndPage("/test", false); // 304 -> count 1
      expect(repoEventsNoChangeCount.get(CACHE_KEY)).toBe(1);

      expireMemoryCaches();
      expireBackoffWindow();
      await getRepoStatsAndPage("/test", false); // 304 -> count 2
      expect(repoEventsNoChangeCount.get(CACHE_KEY)).toBe(2);

      expireMemoryCaches();
      expireBackoffWindow();
      await getRepoStatsAndPage("/test", false); // 200 -> reset to 0
      expect(repoEventsNoChangeCount.get(CACHE_KEY)).toBe(0);
    });

    it("grows the cadence toward the 5-minute ceiling as no-change probes accrue", async () => {
      routeFetch({
        events: [eventsResponse(200, { etag: '"e1"' }), eventsResponse(304)],
        repo: [repoOk(8)],
        pulls: [pullsOk(3)],
      });

      await getRepoStatsAndPage("/test", false); // seed (200)

      const intervals: number[] = [];
      for (let i = 0; i < 6; i++) {
        expireMemoryCaches();
        expireBackoffWindow();
        const r = await getRepoStatsAndPage("/test", false); // 304 count replay
        expect(r.source).toBe("network");
        intervals.push(r.nextPollIntervalMs ?? 0);
      }

      // Monotonic non-decreasing growth, floored at 60s and capped at 5× = 5min.
      expect(intervals[0]).toBe(60_000); // noChange 1 (< engage threshold)
      expect(intervals[intervals.length - 1]).toBe(300_000); // reached the ceiling
      for (let i = 1; i < intervals.length; i++) {
        expect(intervals[i]).toBeGreaterThanOrEqual(intervals[i - 1]);
        expect(intervals[i]).toBeLessThanOrEqual(300_000);
      }
    });

    it("snaps the cadence back to the floor once a change resets the backoff", async () => {
      routeFetch({
        events: [
          eventsResponse(200, { etag: '"e1"' }),
          eventsResponse(304),
          eventsResponse(304),
          eventsResponse(304),
          eventsResponse(200, { etag: '"e2"' }),
        ],
        repo: [repoOk(8)],
        pulls: [pullsOk(3)],
      });

      await getRepoStatsAndPage("/test", false); // seed
      for (let i = 0; i < 3; i++) {
        expireMemoryCaches();
        expireBackoffWindow();
        await getRepoStatsAndPage("/test", false); // 304s grow the cadence
      }

      expireMemoryCaches();
      expireBackoffWindow();
      const changed = await getRepoStatsAndPage("/test", false); // 200 resets cadence

      expect(changed.nextPollIntervalMs).toBe(60_000);
    });
  });

  it("clears the cached events ETag when a 200 probe omits the etag header", async () => {
    routeFetch({
      events: [eventsResponse(200, { etag: '"e1"' }), eventsResponse(200)],
      repo: [repoOk(8)],
      pulls: [pullsOk(3)],
    });

    await getRepoStatsAndPage("/test", false);
    expect(repoEventsETagCache.get(CACHE_KEY)).toBe('"e1"');

    expireMemoryCaches();
    expireBackoffWindow();
    await getRepoStatsAndPage("/test", false); // 200 without etag -> invalidate

    expect(repoEventsETagCache.get(CACHE_KEY)).toBeUndefined();
  });
});
