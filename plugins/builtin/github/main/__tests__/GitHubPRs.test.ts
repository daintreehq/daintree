import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGraphQLClient = vi.fn();

vi.mock("../GitHubAuth.js", () => ({
  GitHubAuth: {
    createClient: vi.fn(() => mockGraphQLClient),
  },
  GITHUB_API_TIMEOUT_MS: 5000,
}));

vi.mock("../GitHubRateLimitService.js", () => ({
  gitHubRateLimitService: {
    updateFromGraphQL: vi.fn(),
  },
}));

vi.mock("../GitHubRepoContext.js", () => ({
  withRepoContextRetry: async <T>(
    _cwd: string,
    fn: (ctx: { owner: string; repo: string }) => Promise<T>
  ) => fn({ owner: "owner", repo: "repo" }),
}));

const mockCache = new Map<string, Record<string, number>>();
vi.mock("../GitHubCaches.js", async () => {
  const actual = await vi.importActual("../GitHubCaches.js");
  return {
    ...actual,
    reviewThreadsCache: {
      get: (key: string) => mockCache.get(key),
      set: (key: string, val: Record<string, number>) => {
        mockCache.set(key, val);
      },
      clear: () => {
        mockCache.clear();
      },
    },
  };
});

import { getPRReviewThreads, parsePRNode } from "../GitHubPRs.js";
import { MAX_REVIEW_THREAD_PAGES } from "../GitHubCaches.js";

function makeThreadNode(path: string, isResolved = false, isOutdated = false) {
  return { path, isResolved, isOutdated };
}

function makePageResponse(
  nodes: Array<ReturnType<typeof makeThreadNode>>,
  hasNextPage: boolean,
  endCursor: string | null = hasNextPage ? "cursor-next" : null
) {
  return {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes,
          pageInfo: { hasNextPage, endCursor },
        },
      },
    },
  };
}

describe("getPRReviewThreads", () => {
  beforeEach(() => {
    mockGraphQLClient.mockReset();
    mockCache.clear();
  });

  it("returns an empty object when client is not available", async () => {
    const { GitHubAuth } = await import("../GitHubAuth.js");
    (GitHubAuth.createClient as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);
    const result = await getPRReviewThreads("/fake", 1);
    expect(result).toEqual({});
  });

  it("returns cached result without issuing a request", async () => {
    mockCache.set("owner/repo:1", { "src/foo.ts": 3 });
    const result = await getPRReviewThreads("/fake", 1);
    expect(result).toEqual({ "src/foo.ts": 3 });
    expect(mockGraphQLClient).not.toHaveBeenCalled();
  });

  it("returns empty object for a PR with zero review threads", async () => {
    mockGraphQLClient.mockResolvedValueOnce(makePageResponse([], false, null));
    const result = await getPRReviewThreads("/fake", 1);
    expect(result).toEqual({});
    expect(mockGraphQLClient).toHaveBeenCalledTimes(1);
  });

  it("counts unresolved threads per file across a single page", async () => {
    mockGraphQLClient.mockResolvedValueOnce(
      makePageResponse(
        [
          makeThreadNode("src/a.ts", false, false),
          makeThreadNode("src/a.ts", false, false),
          makeThreadNode("src/b.ts", false, false),
          makeThreadNode("src/a.ts", true, false), // resolved → skip
          makeThreadNode("src/c.ts", false, true), // outdated → skip
        ],
        false,
        null
      )
    );
    const result = await getPRReviewThreads("/fake", 1);
    expect(result).toEqual({ "src/a.ts": 2, "src/b.ts": 1 });
    expect(mockGraphQLClient).toHaveBeenCalledTimes(1);
  });

  it("paginates across multiple pages and returns merged counts", async () => {
    mockGraphQLClient
      .mockResolvedValueOnce(
        makePageResponse([makeThreadNode("src/a.ts", false, false)], true, "cursor-2")
      )
      .mockResolvedValueOnce(
        makePageResponse([makeThreadNode("src/b.ts", false, false)], false, null)
      );
    const result = await getPRReviewThreads("/fake", 1);
    expect(result).toEqual({ "src/a.ts": 1, "src/b.ts": 1 });
    expect(mockGraphQLClient).toHaveBeenCalledTimes(2);
  });

  it("stops after MAX_REVIEW_THREAD_PAGES and sets __clampedAt sentinel", async () => {
    // Simulate more pages than the cap: each page has 100 nodes, hasNextPage always true
    for (let i = 0; i < MAX_REVIEW_THREAD_PAGES + 3; i++) {
      const nodes = Array.from({ length: 100 }, (_, j) =>
        makeThreadNode(`src/file${i * 100 + j}.ts`, false, false)
      );
      mockGraphQLClient.mockResolvedValueOnce(makePageResponse(nodes, true, `cursor-${i + 1}`));
    }

    const result = await getPRReviewThreads("/fake", 1);

    expect(mockGraphQLClient).toHaveBeenCalledTimes(MAX_REVIEW_THREAD_PAGES);
    expect(result.__clampedAt).toBe(MAX_REVIEW_THREAD_PAGES * 100);
    // Should have counts from all 5 pages (500 nodes)
    const countSum = Object.entries(result)
      .filter(([k]) => k !== "__clampedAt")
      .reduce((sum, [, c]) => sum + c, 0);
    expect(countSum).toBe(500);
  });

  it("sets __clampedAt only when hasNextPage is still true after the last fetched page", async () => {
    // Exactly MAX_REVIEW_THREAD_PAGES pages available, hasNextPage: false on the last
    for (let i = 0; i < MAX_REVIEW_THREAD_PAGES - 1; i++) {
      mockGraphQLClient.mockResolvedValueOnce(
        makePageResponse([makeThreadNode(`src/file${i}.ts`, false, false)], true, `cursor-${i + 1}`)
      );
    }
    // Last page: hasNextPage is false
    mockGraphQLClient.mockResolvedValueOnce(
      makePageResponse([makeThreadNode("src/last.ts", false, false)], false, null)
    );

    const result = await getPRReviewThreads("/fake", 1);

    expect(mockGraphQLClient).toHaveBeenCalledTimes(MAX_REVIEW_THREAD_PAGES);
    expect(result.__clampedAt).toBeUndefined();
  });

  it("skips nodes without a path property", async () => {
    mockGraphQLClient.mockResolvedValueOnce({
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              { path: "src/a.ts", isResolved: false, isOutdated: false },
              { isResolved: false, isOutdated: false }, // no path
              { path: "src/b.ts", isResolved: false, isOutdated: false },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });
    const result = await getPRReviewThreads("/fake", 1);
    expect(result).toEqual({ "src/a.ts": 1, "src/b.ts": 1 });
  });

  it("caches the result including the sentinel for subsequent calls", async () => {
    // 6 pages available → clamps at 5
    for (let i = 0; i < 6; i++) {
      mockGraphQLClient.mockResolvedValueOnce(
        makePageResponse([makeThreadNode("src/a.ts", false, false)], true, `cursor-${i + 1}`)
      );
    }

    const result1 = await getPRReviewThreads("/fake", 1);
    expect(mockGraphQLClient).toHaveBeenCalledTimes(MAX_REVIEW_THREAD_PAGES);
    expect(result1.__clampedAt).toBe(MAX_REVIEW_THREAD_PAGES * 100);

    // Second call should return cached result (no additional GraphQL calls)
    const result2 = await getPRReviewThreads("/fake", 1);
    expect(result2).toEqual(result1);
    expect(mockGraphQLClient).toHaveBeenCalledTimes(MAX_REVIEW_THREAD_PAGES); // no new calls
  });

  it("returns empty object on error and warns", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockGraphQLClient.mockRejectedValueOnce(new Error("Network error"));
    const result = await getPRReviewThreads("/fake", 1);
    expect(result).toEqual({});
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("stops pagination when hasNextPage is true but endCursor is null (malformed response)", async () => {
    mockGraphQLClient.mockResolvedValueOnce(
      makePageResponse([makeThreadNode("src/a.ts", false, false)], true, null) // hasNextPage: true, cursor: null
    );
    const result = await getPRReviewThreads("/fake", 1);
    expect(mockGraphQLClient).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ "src/a.ts": 1 });
    expect(result.__clampedAt).toBeUndefined();
  });

  it("passes correct cursors across paginated calls", async () => {
    mockGraphQLClient
      .mockResolvedValueOnce(
        makePageResponse([makeThreadNode("src/a.ts", false, false)], true, "cursor-2")
      )
      .mockResolvedValueOnce(
        makePageResponse([makeThreadNode("src/b.ts", false, false)], false, null)
      );
    await getPRReviewThreads("/fake", 1);

    expect(mockGraphQLClient).toHaveBeenCalledTimes(2);
    // First call: cursor is null
    expect(mockGraphQLClient.mock.calls[0][1].cursor).toBeNull();
    // Second call: cursor from first page
    expect(mockGraphQLClient.mock.calls[1][1].cursor).toBe("cursor-2");
  });

  it("handles prototype property names without pollution", async () => {
    mockGraphQLClient.mockResolvedValueOnce(
      makePageResponse(
        [
          makeThreadNode("toString", false, false),
          makeThreadNode("constructor", false, false),
          makeThreadNode("__proto__", false, false),
        ],
        false,
        null
      )
    );
    const result = await getPRReviewThreads("/fake", 1);
    expect(result.toString).toBe(1);
    expect(result.constructor).toBe(1);
    expect(result.__proto__).toBe(1);
  });
});

function makeBaseNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 42,
    title: "Test PR",
    url: "https://github.com/owner/repo/pull/42",
    state: "OPEN",
    isDraft: false,
    updatedAt: "2025-01-01T00:00:00Z",
    author: { login: "testuser", avatarUrl: "https://example.com/avatar.png" },
    reviews: { totalCount: 3 },
    comments: { totalCount: 5 },
    headRefName: "feature/test",
    headRepository: { nameWithOwner: "fork/repo" },
    baseRepository: { nameWithOwner: "owner/repo" },
    ...overrides,
  };
}

describe("parsePRNode — global CI aggregates", () => {
  it("populates reviewDecision and mergeStateStatus from the node", () => {
    const pr = parsePRNode(
      makeBaseNode({
        reviewDecision: "APPROVED",
        mergeStateStatus: "CLEAN",
      })
    );
    expect(pr.reviewDecision).toBe("APPROVED");
    expect(pr.mergeStateStatus).toBe("CLEAN");
  });

  it("normalises reviewDecision to undefined for unrecognised values", () => {
    const pr = parsePRNode(makeBaseNode({ reviewDecision: "COMMENTED" }));
    expect(pr.reviewDecision).toBeUndefined();
  });

  it("normalises reviewDecision to undefined when absent", () => {
    const pr = parsePRNode(makeBaseNode());
    expect(pr.reviewDecision).toBeUndefined();
  });

  it("derives globalCIStatus and globalCISummary from statusCheckRollup.contexts aggregates", () => {
    const pr = parsePRNode(
      makeBaseNode({
        mergeStateStatus: "CLEAN",
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  state: "SUCCESS",
                  contexts: {
                    checkRunCount: 3,
                    statusContextCount: 2,
                    checkRunCountsByState: [{ state: "SUCCESS", count: 3 }],
                    statusContextCountsByState: [{ state: "SUCCESS", count: 2 }],
                  },
                },
              },
            },
          ],
        },
      })
    );
    expect(pr.globalCIStatus).toBe("SUCCESS");
    expect(pr.globalCISummary).toEqual({
      checkRunCount: 3,
      statusContextCount: 2,
      failingCount: 0,
      pendingCount: 0,
    });
  });

  it("returns undefined globalCIStatus when mergeStateStatus is UNKNOWN", () => {
    const pr = parsePRNode(
      makeBaseNode({
        mergeStateStatus: "UNKNOWN",
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  state: "PENDING",
                  contexts: {
                    checkRunCount: 5,
                    checkRunCountsByState: [{ state: "SUCCESS", count: 5 }],
                  },
                },
              },
            },
          ],
        },
      })
    );
    expect(pr.globalCIStatus).toBeUndefined();
    expect(pr.globalCISummary).toBeUndefined();
    // Required-only fields are untouched
    expect(pr.ciStatus).toBe("PENDING");
    expect(pr.ciSummary).toBeUndefined();
  });

  it("leaves global fields absent when statusCheckRollup is missing", () => {
    const pr = parsePRNode(makeBaseNode());
    expect(pr.globalCIStatus).toBeUndefined();
    expect(pr.globalCISummary).toBeUndefined();
    expect(pr.ciStatus).toBeUndefined();
  });

  it("leaves global fields absent when contexts is null", () => {
    const pr = parsePRNode(
      makeBaseNode({
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  state: "SUCCESS",
                  contexts: null,
                },
              },
            },
          ],
        },
      })
    );
    expect(pr.globalCIStatus).toBeUndefined();
    expect(pr.globalCISummary).toBeUndefined();
    expect(pr.ciStatus).toBe("SUCCESS");
  });

  it("handles missing checkRunCountsByState gracefully", () => {
    const pr = parsePRNode(
      makeBaseNode({
        mergeStateStatus: "CLEAN",
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  state: "SUCCESS",
                  contexts: {
                    checkRunCount: 0,
                    statusContextCount: 1,
                    statusContextCountsByState: [{ state: "SUCCESS", count: 1 }],
                  },
                },
              },
            },
          ],
        },
      })
    );
    expect(pr.globalCIStatus).toBe("SUCCESS");
    expect(pr.globalCISummary?.checkRunCount).toBe(0);
  });

  it("does not populate required-only ciSummary from global aggregates", () => {
    const pr = parsePRNode(
      makeBaseNode({
        mergeStateStatus: "CLEAN",
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  state: "FAILURE",
                  contexts: {
                    checkRunCount: 2,
                    checkRunCountsByState: [
                      { state: "SUCCESS", count: 1 },
                      { state: "FAILURE", count: 1 },
                    ],
                  },
                },
              },
            },
          ],
        },
      })
    );
    // Global CI reflects the aggregate
    expect(pr.globalCIStatus).toBe("FAILURE");
    // Required-only ciSummary is NOT populated — enrichment handles that
    expect(pr.ciSummary).toBeUndefined();
    // Required-only ciStatus still comes from raw rollup
    expect(pr.ciStatus).toBe("FAILURE");
  });

  it("validates mergeStateStatus against known set, maps unknown to undefined", () => {
    const pr = parsePRNode(makeBaseNode({ mergeStateStatus: "DRAFT" }));
    expect(pr.mergeStateStatus).toBeUndefined();
  });

  it("accepts all valid mergeStateStatus values", () => {
    for (const state of [
      "BEHIND",
      "BLOCKED",
      "CLEAN",
      "DIRTY",
      "HAS_HOOKS",
      "UNKNOWN",
      "UNSTABLE",
    ]) {
      const pr = parsePRNode(makeBaseNode({ mergeStateStatus: state }));
      expect(pr.mergeStateStatus).toBe(state);
    }
  });

  it("normalises lowercase mergeStateStatus to uppercase", () => {
    const pr = parsePRNode(makeBaseNode({ mergeStateStatus: "clean" }));
    expect(pr.mergeStateStatus).toBe("CLEAN");
  });
});
