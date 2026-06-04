import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatErrorMessage } from "../../../../../shared/utils/errorMessage.js";

// `getRepoStatsAndPage` is an orchestration boundary — mock the
// network/auth/repo dependencies and leave the real caches in place so the
// activity-probe gate is exercised end to end. The full stats query goes
// through the mocked GraphQL client; the REST `/events` probe goes through the
// mocked `rateLimitAwareFetch`. See issues #8757 and #9041.

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

import { getRepoStatsAndPage } from "../GitHubStats.js";
import {
  repoStatsCache,
  issueListCache,
  prListCache,
  repoStatsAndPageSnapshotCache,
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

/** A minimal `Response`-like for the events probe — only `status` + `headers.get`. */
function eventsResponse(
  status: number,
  opts: { etag?: string; pollInterval?: string } = {}
): { status: number; headers: { get: (name: string) => string | null } } {
  const headers = new Map<string, string>();
  if (opts.etag !== undefined) headers.set("etag", opts.etag);
  if (opts.pollInterval !== undefined) headers.set("x-poll-interval", opts.pollInterval);
  return {
    status,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
  };
}

function statsQueryCount(): number {
  return mockClient.mock.calls.filter((c) => String(c[0]).includes("GetRepoStatsAndPage")).length;
}

function probeRestCallCount(): number {
  return mockFetch.mock.calls.filter((c) => String(c[0]).includes("/events")).length;
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

describe("getRepoStatsAndPage — REST events activity-probe gate (issues #8757, #9041)", () => {
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
    repoEventsETagCache.clear();
    repoEventsPollIntervalCache.clear();
    repoEventsNoChangeCount.clear();
    repoEventsLastProbeAt.clear();
  });

  it("runs the full stats query and records the snapshot + events ETag on first fetch", async () => {
    mockClient.mockResolvedValue(statsResponse(5, 3));
    mockFetch.mockResolvedValue(eventsResponse(200, { etag: '"e1"' }));

    const result = await getRepoStatsAndPage("/test", false);

    expect(result.source).toBe("network");
    expect(result.stats?.issueCount).toBe(5);
    expect(statsQueryCount()).toBe(1);
    // The probe primed the ETag baseline so the next poll can send If-None-Match.
    expect(repoEventsETagCache.get(CACHE_KEY)).toBe('"e1"');
    expect(repoStatsAndPageSnapshotCache.get(CACHE_KEY)).not.toBeUndefined();
  });

  it("skips the full stats query when the probe returns 304 Not Modified", async () => {
    mockClient.mockResolvedValue(statsResponse(5, 3));
    // First fetch primes the snapshot + ETag (200); the next probe sees no change (304).
    mockFetch
      .mockResolvedValueOnce(eventsResponse(200, { etag: '"e1"' }))
      .mockResolvedValue(eventsResponse(304));

    await getRepoStatsAndPage("/test", false);
    expireMemoryCaches();
    expireBackoffWindow();
    const result = await getRepoStatsAndPage("/test", false);

    expect(result.source).toBe("network");
    expect(result.stats?.issueCount).toBe(5);
    // The probe ran twice; the expensive stats query ran only once.
    expect(probeRestCallCount()).toBe(2);
    expect(statsQueryCount()).toBe(1);
  });

  it("sends the cached ETag as If-None-Match on the follow-up probe", async () => {
    mockClient.mockResolvedValue(statsResponse(5, 3));
    mockFetch
      .mockResolvedValueOnce(eventsResponse(200, { etag: '"e1"' }))
      .mockResolvedValue(eventsResponse(304));

    await getRepoStatsAndPage("/test", false);
    expireMemoryCaches();
    expireBackoffWindow();
    await getRepoStatsAndPage("/test", false);

    const firstInit = mockFetch.mock.calls[0][1] as { headers: Record<string, string> };
    const secondInit = mockFetch.mock.calls[1][1] as { headers: Record<string, string> };
    expect(firstInit.headers["If-None-Match"]).toBeUndefined();
    expect(secondInit.headers["If-None-Match"]).toBe('"e1"');
    expect(String(mockFetch.mock.calls[0][0])).toContain(
      "/repos/testowner/testrepo/events?per_page=1"
    );
  });

  it("returns complete stats/issues/prs on a probe-validated cache hit", async () => {
    mockClient.mockResolvedValue(statsResponse(8, 4));
    mockFetch
      .mockResolvedValueOnce(eventsResponse(200, { etag: '"e1"' }))
      .mockResolvedValue(eventsResponse(304));

    await getRepoStatsAndPage("/test", false);
    expireMemoryCaches();
    expireBackoffWindow();
    const result = await getRepoStatsAndPage("/test", false);

    expect(result.stats?.issueCount).toBe(8);
    expect(result.stats?.prCount).toBe(4);
    expect(result.issues).not.toBeNull();
    expect(result.prs).not.toBeNull();
    expect(result.issues?.totalCount).toBe(8);
    expect(result.prs?.totalCount).toBe(4);
  });

  it("re-runs the full stats query when the probe returns 200 (changed)", async () => {
    mockClient.mockResolvedValue(statsResponse(5, 3));
    // Both polls see a real event (200) — the stats query must run each time.
    mockFetch.mockResolvedValue(eventsResponse(200, { etag: '"e1"' }));

    await getRepoStatsAndPage("/test", false);
    expireMemoryCaches();
    expireBackoffWindow();
    await getRepoStatsAndPage("/test", false);

    expect(statsQueryCount()).toBe(2);
  });

  it("falls through to the full query when the probe request fails", async () => {
    mockClient.mockResolvedValue(statsResponse(5, 3));
    mockFetch.mockRejectedValue(new Error("probe boom"));

    await getRepoStatsAndPage("/test", false);
    expireMemoryCaches();
    expireBackoffWindow();
    const result = await getRepoStatsAndPage("/test", false);

    expect(result.source).toBe("network");
    // Probe failure never gates — both calls ran the expensive query.
    expect(statsQueryCount()).toBe(2);
  });

  it("falls through to the full query on an unexpected probe status (no snapshot served)", async () => {
    mockClient.mockResolvedValue(statsResponse(5, 3));
    mockFetch
      .mockResolvedValueOnce(eventsResponse(200, { etag: '"e1"' }))
      .mockResolvedValue(eventsResponse(500));

    await getRepoStatsAndPage("/test", false);
    expireMemoryCaches();
    expireBackoffWindow();
    await getRepoStatsAndPage("/test", false);

    expect(statsQueryCount()).toBe(2);
  });

  it("skips the probe entirely on bypassCache and runs the full query", async () => {
    mockClient.mockResolvedValue(statsResponse(5, 3));
    mockFetch.mockResolvedValue(eventsResponse(304));

    await getRepoStatsAndPage("/test", true);

    expect(probeRestCallCount()).toBe(0);
    expect(statsQueryCount()).toBe(1);
  });

  it("does not advance the snapshot cache when the full query fails", async () => {
    mockClient.mockRejectedValue(new Error("stats boom"));
    mockFetch.mockResolvedValue(eventsResponse(200, { etag: '"e1"' }));

    await getRepoStatsAndPage("/test", false);

    expect(repoStatsAndPageSnapshotCache.get(CACHE_KEY)).toBeUndefined();
  });

  it("keeps the prior snapshot when a later full query fails", async () => {
    let statsShouldFail = false;
    mockClient.mockImplementation(async () => {
      if (statsShouldFail) throw new Error("stats boom");
      return statsResponse(5, 3);
    });
    // First probe primes the baseline (200); the second reports a real change (200).
    mockFetch.mockResolvedValue(eventsResponse(200, { etag: '"e1"' }));

    await getRepoStatsAndPage("/test", false);
    const goodSnapshot = repoStatsAndPageSnapshotCache.get(CACHE_KEY);
    expect(goodSnapshot).toBeDefined();

    expireMemoryCaches();
    expireBackoffWindow();
    statsShouldFail = true;
    await getRepoStatsAndPage("/test", false);

    // A failed fetch must not clobber the last good snapshot.
    expect(repoStatsAndPageSnapshotCache.get(CACHE_KEY)).toEqual(goodSnapshot);
  });

  it("re-stamps the durable disk cache on a probe-match hit so the fallback can't age out (issue #8826)", async () => {
    mockClient.mockResolvedValue(statsResponse(5, 3));
    mockFetch
      .mockResolvedValueOnce(eventsResponse(200, { etag: '"e1"' }))
      .mockResolvedValue(eventsResponse(304));

    await getRepoStatsAndPage("/test", false);

    expireMemoryCaches();
    expireBackoffWindow();
    mockStatsCache.set.mockClear();

    await getRepoStatsAndPage("/test", false);

    // Optimization preserved — no second expensive stats query.
    expect(statsQueryCount()).toBe(1);
    // The durable disk cache is re-written on the fast path so it can't age out
    // behind the in-memory caches and leave the error-path fallback empty.
    expect(mockStatsCache.set).toHaveBeenCalledWith(
      CACHE_KEY,
      expect.objectContaining({ issueCount: 5, prCount: 3 }),
      "/test"
    );
  });

  it("does not re-stamp the snapshot TTL on a probe-match hit (keeps the 10-min staleness cap)", async () => {
    mockClient.mockResolvedValue(statsResponse(5, 3));
    mockFetch
      .mockResolvedValueOnce(eventsResponse(200, { etag: '"e1"' }))
      .mockResolvedValue(eventsResponse(304));

    await getRepoStatsAndPage("/test", false);
    const snapshotBefore = repoStatsAndPageSnapshotCache.get(CACHE_KEY);

    expireMemoryCaches();
    expireBackoffWindow();
    await getRepoStatsAndPage("/test", false);

    // Snapshot cache is read, not rewritten — its original entry (and TTL) is
    // untouched so list content can't live indefinitely behind a matching probe.
    expect(repoStatsAndPageSnapshotCache.get(CACHE_KEY)).toBe(snapshotBefore);
  });

  it("serves the full snapshot on a 304 even when the GraphQL bucket is blocked", async () => {
    // The probe + snapshot draw from the REST "core" bucket, so a depleted
    // GraphQL budget must not suppress a zero-cost 304 cache hit. The probe gate
    // runs before the GraphQL rate-limit check for exactly this reason.
    mockClient.mockResolvedValue(statsResponse(5, 3));
    mockFetch
      .mockResolvedValueOnce(eventsResponse(200, { etag: '"e1"' }))
      .mockResolvedValue(eventsResponse(304));

    await getRepoStatsAndPage("/test", false); // seed snapshot + ETag, all unblocked
    expireMemoryCaches();
    expireBackoffWindow();

    // Block only GraphQL; the REST "core" probe is unaffected.
    vi.mocked(gitHubRateLimitService.shouldBlockRequest).mockImplementation((resource?: string) =>
      resource === "graphql"
        ? { blocked: true, reason: "primary", resumeAt: Date.now() + 1000 }
        : { blocked: false, reason: null }
    );

    const result = await getRepoStatsAndPage("/test", false);

    // Full snapshot served (not the degraded disk fallback with null lists),
    // and no second GraphQL query was issued.
    expect(result.issues).not.toBeNull();
    expect(result.prs).not.toBeNull();
    expect(result.error).toBeUndefined();
    expect(statsQueryCount()).toBe(1);
  });

  it("does not advance the events ETag when the full query fails (deferred commit)", async () => {
    // The ETag must move in lockstep with the snapshot: if the full query fails
    // after a changed probe, the old ETag has to survive so the next probe
    // re-detects the change instead of masking it behind a later 304.
    let statsShouldFail = false;
    mockClient.mockImplementation(async () => {
      if (statsShouldFail) throw new Error("stats boom");
      return statsResponse(5, 3);
    });
    mockFetch
      .mockResolvedValueOnce(eventsResponse(200, { etag: '"e1"' }))
      .mockResolvedValue(eventsResponse(200, { etag: '"e2"' }));

    await getRepoStatsAndPage("/test", false); // probe 200 e1, full ok -> commit e1
    expect(repoEventsETagCache.get(CACHE_KEY)).toBe('"e1"');

    expireMemoryCaches();
    expireBackoffWindow();
    statsShouldFail = true;
    await getRepoStatsAndPage("/test", false); // probe 200 e2 (changed), full FAILS

    // ETag stays e1 — the failed fetch never committed e2.
    expect(repoEventsETagCache.get(CACHE_KEY)).toBe('"e1"');
  });

  it("clears the cached ETag when a 200 response omits the etag header", async () => {
    mockClient.mockResolvedValue(statsResponse(5, 3));
    mockFetch
      .mockResolvedValueOnce(eventsResponse(200, { etag: '"e1"' }))
      .mockResolvedValue(eventsResponse(200)); // changed, but no etag header

    await getRepoStatsAndPage("/test", false);
    expect(repoEventsETagCache.get(CACHE_KEY)).toBe('"e1"');

    expireMemoryCaches();
    expireBackoffWindow();
    await getRepoStatsAndPage("/test", false); // 200 without etag -> invalidate

    expect(repoEventsETagCache.get(CACHE_KEY)).toBeUndefined();
  });

  it("re-runs the full query after clearPRCaches invalidates the snapshot", async () => {
    mockClient.mockResolvedValue(statsResponse(5, 3));
    mockFetch.mockResolvedValue(eventsResponse(200, { etag: '"e1"' }));

    await getRepoStatsAndPage("/test", false);
    expireMemoryCaches();
    // A user-initiated GitHub refresh must not be defeated by a probe hit.
    clearPRCaches();
    await getRepoStatsAndPage("/test", false);

    expect(statsQueryCount()).toBe(2);
  });

  describe("adaptive backoff (issue #9041)", () => {
    it("reuses the snapshot without probing while inside the X-Poll-Interval window", async () => {
      mockClient.mockResolvedValue(statsResponse(5, 3));
      mockFetch.mockResolvedValue(eventsResponse(200, { etag: '"e1"' }));

      await getRepoStatsAndPage("/test", false);
      const probesAfterFirst = probeRestCallCount();

      // Only the 60s memory cache expires; the backoff window is still open, so
      // the second poll serves the snapshot without touching the network.
      expireMemoryCaches();
      const result = await getRepoStatsAndPage("/test", false);

      expect(result.source).toBe("network");
      expect(probeRestCallCount()).toBe(probesAfterFirst);
      expect(statsQueryCount()).toBe(1);
    });

    it("stores the server-advertised X-Poll-Interval as the backoff floor (ms)", async () => {
      mockClient.mockResolvedValue(statsResponse(5, 3));
      mockFetch.mockResolvedValue(eventsResponse(200, { etag: '"e1"', pollInterval: "120" }));

      await getRepoStatsAndPage("/test", false);

      expect(repoEventsPollIntervalCache.get(CACHE_KEY)).toBe(120_000);
    });

    it("honors the stored X-Poll-Interval as the gate window boundary", async () => {
      mockClient.mockResolvedValue(statsResponse(5, 3));
      mockFetch.mockResolvedValue(eventsResponse(200, { etag: '"e1"', pollInterval: "120" }));

      await getRepoStatsAndPage("/test", false); // floor now 120_000ms, noChange 0
      const probesAfterSeed = probeRestCallCount();

      // Just inside the 120s window — must reuse the snapshot without probing.
      repoEventsLastProbeAt.set(CACHE_KEY, Date.now() - 119_000);
      expireMemoryCaches();
      await getRepoStatsAndPage("/test", false);
      expect(probeRestCallCount()).toBe(probesAfterSeed);

      // Just past the window — the probe must fire again.
      repoEventsLastProbeAt.set(CACHE_KEY, Date.now() - 121_000);
      expireMemoryCaches();
      await getRepoStatsAndPage("/test", false);
      expect(probeRestCallCount()).toBe(probesAfterSeed + 1);
    });

    it("increments the consecutive-no-change counter on each 304 and resets on a 200", async () => {
      mockClient.mockResolvedValue(statsResponse(5, 3));
      mockFetch
        .mockResolvedValueOnce(eventsResponse(200, { etag: '"e1"' }))
        .mockResolvedValueOnce(eventsResponse(304))
        .mockResolvedValueOnce(eventsResponse(304))
        .mockResolvedValue(eventsResponse(200, { etag: '"e2"' }));

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

    it("resets the backoff cadence on a bypassCache (manual refresh / focus) poll", async () => {
      mockClient.mockResolvedValue(statsResponse(5, 3));
      mockFetch
        .mockResolvedValueOnce(eventsResponse(200, { etag: '"e1"' }))
        .mockResolvedValue(eventsResponse(304));

      await getRepoStatsAndPage("/test", false);
      expireMemoryCaches();
      expireBackoffWindow();
      await getRepoStatsAndPage("/test", false); // 304 -> count 1
      expect(repoEventsNoChangeCount.get(CACHE_KEY)).toBe(1);

      await getRepoStatsAndPage("/test", true); // bypassCache resets the cadence
      expect(repoEventsNoChangeCount.get(CACHE_KEY)).toBeUndefined();
      expect(repoEventsLastProbeAt.get(CACHE_KEY)).toBeUndefined();
    });
  });

  describe("next-poll interval surface (issue #9741)", () => {
    it("returns the floor cadence on a fresh fetch with changes landing", async () => {
      mockClient.mockResolvedValue(statsResponse(5, 3));
      mockFetch.mockResolvedValue(eventsResponse(200, { etag: '"e1"' }));

      const result = await getRepoStatsAndPage("/test", false);

      // No consecutive no-change polls yet → cadence pinned to the 60s floor.
      expect(result.nextPollIntervalMs).toBe(60_000);
    });

    it("grows the cadence toward the 5-minute ceiling as no-change probes accrue", async () => {
      mockClient.mockResolvedValue(statsResponse(5, 3));
      mockFetch
        .mockResolvedValueOnce(eventsResponse(200, { etag: '"e1"' }))
        .mockResolvedValue(eventsResponse(304));

      await getRepoStatsAndPage("/test", false); // seed (200)

      const intervals: number[] = [];
      for (let i = 0; i < 6; i++) {
        expireMemoryCaches();
        expireBackoffWindow();
        const r = await getRepoStatsAndPage("/test", false); // 304 short-circuit
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
      mockClient.mockResolvedValue(statsResponse(5, 3));
      mockFetch
        .mockResolvedValueOnce(eventsResponse(200, { etag: '"e1"' }))
        .mockResolvedValueOnce(eventsResponse(304))
        .mockResolvedValueOnce(eventsResponse(304))
        .mockResolvedValueOnce(eventsResponse(304))
        .mockResolvedValue(eventsResponse(200, { etag: '"e2"' }));

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

  it("returns unknown and still runs the full query when the core bucket is blocked", async () => {
    mockClient.mockResolvedValue(statsResponse(5, 3));
    mockFetch.mockResolvedValue(eventsResponse(200, { etag: '"e1"' }));

    // Seed a snapshot with every bucket unblocked so the gate has something it
    // could serve — proving the block, not a missing snapshot, forces the query.
    await getRepoStatsAndPage("/test", false);
    expireMemoryCaches();
    expireBackoffWindow();
    const probesBefore = probeRestCallCount();

    // Now block only the REST "core" bucket; GraphQL is unaffected so the full
    // stats query (and its "graphql" preflight) still proceeds.
    vi.mocked(gitHubRateLimitService.shouldBlockRequest).mockImplementation((resource?: string) =>
      resource === "core"
        ? { blocked: true, reason: "primary", resumeAt: Date.now() + 1000 }
        : { blocked: false, reason: null }
    );

    await getRepoStatsAndPage("/test", false);

    // Probe short-circuited to "unknown" before opening a socket; full query ran.
    expect(probeRestCallCount()).toBe(probesBefore);
    expect(statsQueryCount()).toBe(2);
  });
});
