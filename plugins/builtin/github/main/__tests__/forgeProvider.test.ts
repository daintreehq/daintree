import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { formatErrorMessage } from "../../../../../shared/utils/errorMessage.js";
import { MAX_REVIEW_THREAD_PAGES } from "../GitHubCaches.js";
import type { ShouldBlockResult } from "../GitHubRateLimitService.js";

const mockGraphQLClient = vi.fn();
const mockFetchActivityProbe = vi.fn();
const mockShouldBlockRequest = vi.fn(
  (_resource?: string): ShouldBlockResult => ({ blocked: false, reason: null })
);

vi.mock("../GitHubAuth.js", () => ({
  GitHubAuth: {
    getToken: vi.fn(() => "test-token"),
    createClient: vi.fn(() => mockGraphQLClient),
  },
  GITHUB_API_TIMEOUT_MS: 5000,
}));

vi.mock("../GitHubStats.js", () => ({
  fetchActivityProbe: (...args: unknown[]) => mockFetchActivityProbe(...args),
}));

vi.mock("../GitHubRateLimitService.js", () => ({
  gitHubRateLimitService: {
    updateFromGraphQL: vi.fn(),
    getState: vi.fn(() => ({ blocked: false })),
    shouldBlockRequest: (resource?: string) => mockShouldBlockRequest(resource),
  },
}));

vi.mock("../GitHubErrors.js", () => ({
  parseGitHubError: (e: unknown) => formatErrorMessage(e, "unknown error"),
}));

import { githubForgeProvider } from "../forgeProvider.js";
import {
  _resetForgeQueryCachesForTests,
  clearGitHubCaches,
  clearPRCaches,
  forgeIssueListCache,
  forgePRListCache,
  forgeQueryCache,
  issueTooltipCache,
  prRequiredStatusCache,
  prTooltipCache,
} from "../GitHubCaches.js";
import { GitHubAuth } from "../GitHubAuth.js";
import { gitHubRateLimitService } from "../GitHubRateLimitService.js";
import type { RepoRef } from "../../../../../shared/types/forge.js";

const repo: RepoRef = { host: "github.com", owner: "owner", repo: "repo", rawData: null };

// runQuery caches + coalesces across all provider methods, so every suite must
// start from a clean cache or call-count assertions become order-dependent.
// `clearGitHubCaches` covers every forge cache (forge query, list, tooltip,
// required-status) atomically, so the per-suite reset just calls it.
beforeEach(() => {
  clearGitHubCaches();
  _resetForgeQueryCachesForTests();
  mockShouldBlockRequest.mockReturnValue({ blocked: false, reason: null });
});

function makePRNode(
  number: number,
  headRefName: string,
  reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null,
  commits?: unknown
) {
  return {
    number,
    title: `PR ${number}`,
    bodyText: "",
    url: `https://github.com/owner/repo/pull/${number}`,
    state: "OPEN",
    isDraft: false,
    merged: false,
    baseRefName: "main",
    headRefName,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    closedAt: null,
    mergedAt: null,
    author: { login: "user", avatarUrl: "" },
    ...(reviewDecision !== undefined ? { reviewDecision } : {}),
    ...(commits !== undefined ? { commits } : {}),
  };
}

function makeCommitsRollup(state: string | null) {
  return { nodes: [{ commit: { statusCheckRollup: state === null ? null : { state } } }] };
}

describe("findPRsByBranches", () => {
  beforeEach(() => {
    mockGraphQLClient.mockReset();
  });

  it("returns an empty Map for an empty branch list without issuing a request", async () => {
    const result = await githubForgeProvider.findPRsByBranches!(repo, []);
    expect(result.size).toBe(0);
    expect(mockGraphQLClient).not.toHaveBeenCalled();
  });

  it("maps each alias back to the correct branch in input order (≤ chunk size)", async () => {
    mockGraphQLClient.mockResolvedValueOnce({
      b0: { pullRequests: { nodes: [makePRNode(1, "feature/a")] } },
      b1: { pullRequests: { nodes: [makePRNode(2, "feature/b")] } },
      b2: { pullRequests: { nodes: [] } },
      rateLimit: { cost: 1, remaining: 4999, resetAt: "" },
    });

    const result = await githubForgeProvider.findPRsByBranches!(repo, [
      "feature/a",
      "feature/b",
      "feature/c",
    ]);

    expect(mockGraphQLClient).toHaveBeenCalledTimes(1);
    expect(result.get("feature/a")?.number).toBe(1);
    expect(result.get("feature/b")?.number).toBe(2);
    expect(result.get("feature/c")).toBeNull();
  });

  it("chunks at BATCH_BRANCH_CHUNK_SIZE (20) and maps the 21st branch to alias b0 of the second chunk", async () => {
    const branches = Array.from({ length: 21 }, (_, i) => `branch-${i}`);

    // First chunk: branches 0..19 → b0..b19
    const firstResponse: Record<string, unknown> = {
      rateLimit: { cost: 1, remaining: 4999, resetAt: "" },
    };
    for (let i = 0; i < 20; i++) {
      firstResponse[`b${i}`] = { pullRequests: { nodes: [makePRNode(100 + i, `branch-${i}`)] } };
    }
    // Second chunk: branch 20 → b0
    const secondResponse = {
      b0: { pullRequests: { nodes: [makePRNode(120, "branch-20")] } },
      rateLimit: { cost: 1, remaining: 4998, resetAt: "" },
    };

    mockGraphQLClient.mockResolvedValueOnce(firstResponse).mockResolvedValueOnce(secondResponse);

    const result = await githubForgeProvider.findPRsByBranches!(repo, branches);

    expect(mockGraphQLClient).toHaveBeenCalledTimes(2);
    expect(result.get("branch-0")?.number).toBe(100);
    expect(result.get("branch-19")?.number).toBe(119);
    expect(result.get("branch-20")?.number).toBe(120); // alias b0 of second chunk
  });

  it("omits a branch from the result Map when its alias is missing from the response (partial GraphQL response)", async () => {
    // b1 is missing — the alias key is absent, not null. The caller routes
    // omitted branches to per-branch fallback rather than silently recording null.
    mockGraphQLClient.mockResolvedValueOnce({
      b0: { pullRequests: { nodes: [makePRNode(1, "feature/a")] } },
      // b1 intentionally omitted
      rateLimit: { cost: 1, remaining: 4999, resetAt: "" },
    });

    const result = await githubForgeProvider.findPRsByBranches!(repo, ["feature/a", "feature/b"]);

    expect(result.has("feature/a")).toBe(true);
    expect(result.has("feature/b")).toBe(false);
  });

  it("treats a present-but-null alias the same as a missing alias (omits the branch)", async () => {
    mockGraphQLClient.mockResolvedValueOnce({
      b0: { pullRequests: { nodes: [makePRNode(1, "feature/a")] } },
      b1: null,
      rateLimit: { cost: 1, remaining: 4999, resetAt: "" },
    });

    const result = await githubForgeProvider.findPRsByBranches!(repo, ["feature/a", "feature/b"]);

    expect(result.has("feature/a")).toBe(true);
    expect(result.has("feature/b")).toBe(false);
  });

  it("isolates per-chunk failures so a single transient error doesn't blank every branch", async () => {
    const branches = Array.from({ length: 21 }, (_, i) => `branch-${i}`);

    // First chunk succeeds for all 20 branches
    const firstResponse: Record<string, unknown> = {
      rateLimit: { cost: 1, remaining: 4999, resetAt: "" },
    };
    for (let i = 0; i < 20; i++) {
      firstResponse[`b${i}`] = { pullRequests: { nodes: [makePRNode(100 + i, `branch-${i}`)] } };
    }
    // Second chunk throws
    mockGraphQLClient
      .mockResolvedValueOnce(firstResponse)
      .mockRejectedValueOnce(new Error("transient chunk failure"));

    const result = await githubForgeProvider.findPRsByBranches!(repo, branches);

    // First-chunk branches present, second-chunk branch omitted → caller falls back per-branch
    expect(result.size).toBe(20);
    expect(result.has("branch-0")).toBe(true);
    expect(result.has("branch-19")).toBe(true);
    expect(result.has("branch-20")).toBe(false);
  });

  it("deduplicates duplicate branches in input (one alias per unique value)", async () => {
    mockGraphQLClient.mockResolvedValueOnce({
      b0: { pullRequests: { nodes: [makePRNode(1, "shared")] } },
      rateLimit: { cost: 1, remaining: 4999, resetAt: "" },
    });

    const result = await githubForgeProvider.findPRsByBranches!(repo, [
      "shared",
      "shared",
      "shared",
    ]);

    expect(mockGraphQLClient).toHaveBeenCalledTimes(1);
    // Result Map has one entry for the unique branch; consumers fan out
    // to multiple worktrees via their own iteration of uniqueBranches.
    expect(result.size).toBe(1);
    expect(result.get("shared")?.number).toBe(1);

    // The query body should reference the branch exactly once.
    const calledQuery = mockGraphQLClient.mock.calls[0][0] as string;
    const matches = calledQuery.match(/headRefName: "shared"/g);
    expect(matches?.length).toBe(1);
  });
});

function makeIssueResponse(number: number) {
  return {
    repository: {
      issue: {
        number,
        title: `Issue ${number}`,
        bodyText: "",
        state: "OPEN",
        url: `https://github.com/owner/repo/issues/${number}`,
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
        closedAt: null,
        author: { login: "user", avatarUrl: "" },
      },
    },
    rateLimit: { cost: 1, remaining: 4999, resetAt: "" },
  };
}

function prListResponse(totalCount?: number) {
  return {
    repository: {
      pullRequests: {
        nodes: [makePRNode(1, "feature/a")],
        pageInfo: { hasNextPage: false, endCursor: null },
        ...(totalCount !== undefined ? { totalCount } : {}),
      },
    },
    rateLimit: { cost: 1, remaining: 4999, resetAt: "" },
  };
}

describe("runQuery cache + in-flight dedup", () => {
  beforeEach(() => {
    mockGraphQLClient.mockReset();
  });

  it("coalesces concurrent identical queries into one client call", async () => {
    let resolveClient!: (value: unknown) => void;
    mockGraphQLClient.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveClient = resolve;
      })
    );

    const a = githubForgeProvider.getIssue!(repo, 1);
    const b = githubForgeProvider.getIssue!(repo, 1);

    resolveClient(makeIssueResponse(1));
    const [ra, rb] = await Promise.all([a, b]);

    expect(mockGraphQLClient).toHaveBeenCalledTimes(1);
    expect(ra?.number).toBe(1);
    expect(rb?.number).toBe(1);
  });

  it("serves a cache hit for a repeat query within the TTL", async () => {
    mockGraphQLClient.mockResolvedValueOnce(makeIssueResponse(1));

    const first = await githubForgeProvider.getIssue!(repo, 1);
    const second = await githubForgeProvider.getIssue!(repo, 1);

    expect(mockGraphQLClient).toHaveBeenCalledTimes(1);
    expect(first?.number).toBe(1);
    expect(second?.number).toBe(1);
  });

  it("issues a separate request when variables differ", async () => {
    mockGraphQLClient
      .mockResolvedValueOnce(makeIssueResponse(1))
      .mockResolvedValueOnce(makeIssueResponse(2));

    await githubForgeProvider.getIssue!(repo, 1);
    await githubForgeProvider.getIssue!(repo, 2);

    expect(mockGraphQLClient).toHaveBeenCalledTimes(2);
  });

  it("does not cache errors — a retry issues a fresh request", async () => {
    mockGraphQLClient
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(makeIssueResponse(1));

    await expect(githubForgeProvider.getIssue!(repo, 1)).rejects.toThrow();
    const retry = await githubForgeProvider.getIssue!(repo, 1);

    expect(mockGraphQLClient).toHaveBeenCalledTimes(2);
    expect(retry?.number).toBe(1);
  });

  it("clearGitHubCaches() drops the forge cache so the next call refetches", async () => {
    mockGraphQLClient
      .mockResolvedValueOnce(makeIssueResponse(1))
      .mockResolvedValueOnce(makeIssueResponse(1));

    await githubForgeProvider.getIssue!(repo, 1);
    expect(forgeQueryCache.size()).toBe(1);

    clearGitHubCaches();
    expect(forgeQueryCache.size()).toBe(0);

    await githubForgeProvider.getIssue!(repo, 1);
    expect(mockGraphQLClient).toHaveBeenCalledTimes(2);
  });

  it("clearPRCaches() drops the forge cache so a manual refresh refetches", async () => {
    mockGraphQLClient
      .mockResolvedValueOnce(makeIssueResponse(1))
      .mockResolvedValueOnce(makeIssueResponse(1));

    await githubForgeProvider.getIssue!(repo, 1);
    expect(forgeQueryCache.size()).toBe(1);

    clearPRCaches();
    expect(forgeQueryCache.size()).toBe(0);

    await githubForgeProvider.getIssue!(repo, 1);
    expect(mockGraphQLClient).toHaveBeenCalledTimes(2);
  });
});

describe("listPRs reviewDecision", () => {
  beforeEach(() => {
    mockGraphQLClient.mockReset();
  });

  it("maps GitHub reviewDecision values onto the normalized PR field", async () => {
    mockGraphQLClient.mockResolvedValueOnce({
      repository: {
        pullRequests: {
          nodes: [
            makePRNode(1, "feature/a", "APPROVED"),
            makePRNode(2, "feature/b", "CHANGES_REQUESTED"),
            makePRNode(3, "feature/c", null),
            makePRNode(4, "feature/d", "REVIEW_REQUIRED"),
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
          totalCount: 4,
        },
      },
      rateLimit: { cost: 1, remaining: 4999, resetAt: "" },
    });

    const page = await githubForgeProvider.listPRs(repo, {});

    expect(page.items[0].reviewDecision).toBe("APPROVED");
    expect(page.items[1].reviewDecision).toBe("CHANGES_REQUESTED");
    // `null` means the repo doesn't gate on reviews — preserved, not coerced.
    expect(page.items[2].reviewDecision).toBeNull();
    expect(page.items[3].reviewDecision).toBe("REVIEW_REQUIRED");
  });

  it("leaves reviewDecision undefined when the provider omits the field", async () => {
    mockGraphQLClient.mockResolvedValueOnce({
      repository: {
        pullRequests: {
          nodes: [makePRNode(1, "feature/a")],
          pageInfo: { hasNextPage: false, endCursor: null },
          totalCount: 1,
        },
      },
      rateLimit: { cost: 1, remaining: 4999, resetAt: "" },
    });

    const page = await githubForgeProvider.listPRs(repo, {});
    expect(page.items[0].reviewDecision).toBeUndefined();
  });
});

describe("listPRs ciStatus", () => {
  beforeEach(() => {
    mockGraphQLClient.mockReset();
  });

  function prListResponse(nodes: unknown[]) {
    return {
      repository: {
        pullRequests: {
          nodes,
          pageInfo: { hasNextPage: false, endCursor: null },
          totalCount: nodes.length,
        },
      },
      rateLimit: { cost: 1, remaining: 4999, resetAt: "" },
    };
  }

  it("maps the statusCheckRollup state from the list shape onto ciStatus", async () => {
    mockGraphQLClient.mockResolvedValueOnce(
      prListResponse([
        makePRNode(1, "feature/a", undefined, makeCommitsRollup("SUCCESS")),
        makePRNode(2, "feature/b", undefined, makeCommitsRollup("FAILURE")),
        makePRNode(3, "feature/c", undefined, makeCommitsRollup("ERROR")),
        makePRNode(4, "feature/d", undefined, makeCommitsRollup("PENDING")),
        makePRNode(5, "feature/e", undefined, makeCommitsRollup("EXPECTED")),
      ])
    );

    const page = await githubForgeProvider.listPRs(repo, {});

    expect(page.items[0].ciStatus).toBe("success");
    expect(page.items[1].ciStatus).toBe("failure");
    // ERROR folds into failure and EXPECTED into pending — the forge set is
    // boolean-ish by design (see mapListCIStatus).
    expect(page.items[2].ciStatus).toBe("failure");
    expect(page.items[3].ciStatus).toBe("pending");
    expect(page.items[4].ciStatus).toBe("pending");
  });

  it("omits ciStatus when the head commit has no statusCheckRollup", async () => {
    // No rollup means "no CI configured" — the field must stay absent rather
    // than default to a state (absence !== passing).
    mockGraphQLClient.mockResolvedValueOnce(
      prListResponse([makePRNode(1, "feature/a", undefined, makeCommitsRollup(null))])
    );

    const page = await githubForgeProvider.listPRs(repo, {});
    expect("ciStatus" in page.items[0]).toBe(false);
  });

  it("omits ciStatus when the commits field is missing or empty", async () => {
    mockGraphQLClient.mockResolvedValueOnce(
      prListResponse([
        makePRNode(1, "feature/a"),
        makePRNode(2, "feature/b", undefined, { nodes: [] }),
      ])
    );

    const page = await githubForgeProvider.listPRs(repo, {});
    expect("ciStatus" in page.items[0]).toBe(false);
    expect("ciStatus" in page.items[1]).toBe(false);
  });

  it("tolerates malformed commits shapes without throwing or emitting ciStatus", async () => {
    mockGraphQLClient.mockResolvedValueOnce(
      prListResponse([
        makePRNode(1, "feature/a", undefined, { nodes: [null] }),
        makePRNode(2, "feature/b", undefined, { nodes: [{ commit: null }] }),
        makePRNode(3, "feature/c", undefined, makeCommitsRollup("SUCCESS")),
      ])
    );

    const page = await githubForgeProvider.listPRs(repo, {});
    expect("ciStatus" in page.items[0]).toBe(false);
    expect("ciStatus" in page.items[1]).toBe(false);
    expect(page.items[2].ciStatus).toBe("success");
  });

  it("drops unrecognized rollup states instead of guessing a mapping", async () => {
    // Non-string and unknown-enum states fall through to "absent" — the
    // conservative behavior if GitHub ever widens the rollup enum.
    mockGraphQLClient.mockResolvedValueOnce(
      prListResponse([
        makePRNode(1, "feature/a", undefined, makeCommitsRollup("NEUTRAL")),
        makePRNode(2, "feature/b", undefined, {
          nodes: [{ commit: { statusCheckRollup: { state: 123 } } }],
        }),
      ])
    );

    const page = await githubForgeProvider.listPRs(repo, {});
    expect("ciStatus" in page.items[0]).toBe(false);
    expect("ciStatus" in page.items[1]).toBe(false);
  });
});

describe("commentCount mapping", () => {
  beforeEach(() => {
    mockGraphQLClient.mockReset();
  });

  function prListWithNodes(nodes: unknown[]) {
    return {
      repository: {
        pullRequests: {
          nodes,
          pageInfo: { hasNextPage: false, endCursor: null },
          totalCount: nodes.length,
        },
      },
      rateLimit: { cost: 1, remaining: 4999, resetAt: "" },
    };
  }

  function issueListWithNodes(nodes: unknown[]) {
    return {
      repository: {
        issues: {
          nodes,
          pageInfo: { hasNextPage: false, endCursor: null },
          totalCount: nodes.length,
        },
      },
      rateLimit: { cost: 1, remaining: 4999, resetAt: "" },
    };
  }

  function issueNode(number: number, comments?: unknown) {
    return {
      number,
      title: `Issue ${number}`,
      bodyText: "",
      state: "OPEN",
      url: `https://github.com/owner/repo/issues/${number}`,
      author: { login: "user", avatarUrl: "" },
      assignees: { nodes: [] },
      labels: { nodes: [] },
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
      closedAt: null,
      ...(comments !== undefined ? { comments } : {}),
    };
  }

  it("extracts comments.totalCount onto the listed issue's commentCount", async () => {
    mockGraphQLClient.mockResolvedValueOnce(issueListWithNodes([issueNode(5, { totalCount: 7 })]));

    const page = await githubForgeProvider.listIssues(repo, {});
    expect(page.items[0].commentCount).toBe(7);
  });

  it("preserves a zero comment count from the issue node", async () => {
    mockGraphQLClient.mockResolvedValueOnce(issueListWithNodes([issueNode(5, { totalCount: 0 })]));

    const page = await githubForgeProvider.listIssues(repo, {});
    expect(page.items[0].commentCount).toBe(0);
  });

  it("omits commentCount when the issue node has no comments connection", async () => {
    mockGraphQLClient.mockResolvedValueOnce(issueListWithNodes([issueNode(5)]));

    const page = await githubForgeProvider.listIssues(repo, {});
    expect("commentCount" in page.items[0]).toBe(false);
  });

  it("omits commentCount when comments.totalCount is not a number", async () => {
    mockGraphQLClient.mockResolvedValueOnce(
      issueListWithNodes([issueNode(5, { totalCount: "7" })])
    );

    const page = await githubForgeProvider.listIssues(repo, {});
    expect("commentCount" in page.items[0]).toBe(false);
  });

  it("extracts comments.totalCount onto the listed PR's commentCount", async () => {
    mockGraphQLClient.mockResolvedValueOnce(
      prListWithNodes([{ ...makePRNode(1, "feature/a"), comments: { totalCount: 3 } }])
    );

    const page = await githubForgeProvider.listPRs(repo, {});
    expect(page.items[0].commentCount).toBe(3);
  });

  it("preserves a zero comment count from the PR node", async () => {
    mockGraphQLClient.mockResolvedValueOnce(
      prListWithNodes([{ ...makePRNode(1, "feature/a"), comments: { totalCount: 0 } }])
    );

    const page = await githubForgeProvider.listPRs(repo, {});
    expect(page.items[0].commentCount).toBe(0);
  });

  it("omits commentCount when the PR node has no comments connection", async () => {
    mockGraphQLClient.mockResolvedValueOnce(prListWithNodes([makePRNode(1, "feature/a")]));

    const page = await githubForgeProvider.listPRs(repo, {});
    expect("commentCount" in page.items[0]).toBe(false);
  });

  it("omits commentCount when the PR comments.totalCount is malformed", async () => {
    mockGraphQLClient.mockResolvedValueOnce(
      prListWithNodes([{ ...makePRNode(1, "feature/a"), comments: { totalCount: null } }])
    );

    const page = await githubForgeProvider.listPRs(repo, {});
    expect("commentCount" in page.items[0]).toBe(false);
  });
});

function issueListResponse(totalCount?: number) {
  return {
    repository: {
      issues: {
        nodes: [
          {
            number: 5,
            title: "Issue 5",
            bodyText: "body",
            state: "OPEN",
            url: "https://github.com/owner/repo/issues/5",
            author: { login: "user", avatarUrl: "" },
            assignees: { nodes: [] },
            labels: { nodes: [] },
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
            closedAt: null,
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
        ...(totalCount !== undefined ? { totalCount } : {}),
      },
    },
    rateLimit: { cost: 1, remaining: 4999, resetAt: "" },
  };
}

function ciResponse(state = "SUCCESS") {
  return {
    repository: {
      pullRequest: {
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  state,
                  contexts: { nodes: [], pageInfo: { hasNextPage: false } },
                },
              },
            },
          ],
        },
      },
    },
    rateLimit: { cost: 1, remaining: 4999, resetAt: "" },
  };
}

describe("listPRs caching", () => {
  beforeEach(() => mockGraphQLClient.mockReset());

  it("serves a warm cache entry without issuing a second query", async () => {
    mockGraphQLClient.mockResolvedValue(prListResponse());

    const first = await githubForgeProvider.listPRs(repo, { state: "open" });
    const second = await githubForgeProvider.listPRs(repo, { state: "open" });

    expect(mockGraphQLClient).toHaveBeenCalledTimes(1);
    expect(first.items[0]?.number).toBe(1);
    expect(second.items[0]?.number).toBe(1);
  });

  it("coalesces concurrent identical calls into a single query", async () => {
    mockGraphQLClient.mockResolvedValue(prListResponse());

    const [a, b] = await Promise.all([
      githubForgeProvider.listPRs(repo, { state: "open" }),
      githubForgeProvider.listPRs(repo, { state: "open" }),
    ]);

    expect(mockGraphQLClient).toHaveBeenCalledTimes(1);
    expect(a.items[0]?.number).toBe(1);
    expect(b.items[0]?.number).toBe(1);
  });

  it("bypassCache skips the warm cache and refetches, then repopulates it", async () => {
    mockGraphQLClient.mockResolvedValue(prListResponse());

    await githubForgeProvider.listPRs(repo, { state: "open" });
    await githubForgeProvider.listPRs(repo, { state: "open", bypassCache: true });
    expect(mockGraphQLClient).toHaveBeenCalledTimes(2);

    // The bypass result repopulated the cache, so a following plain read hits it.
    await githubForgeProvider.listPRs(repo, { state: "open" });
    expect(mockGraphQLClient).toHaveBeenCalledTimes(2);
  });

  it("writes the cache entry under the forge list cache key", async () => {
    mockGraphQLClient.mockResolvedValue(prListResponse());
    await githubForgeProvider.listPRs(repo, { state: "open" });
    expect(forgePRListCache.get("pr:owner/repo:open::created:")).toBeDefined();
  });

  it("a superseded slow fetch does not clobber a newer bypass result", async () => {
    let resolveP1!: (v: unknown) => void;
    const p1 = new Promise((r) => {
      resolveP1 = r;
    });
    mockGraphQLClient
      .mockReturnValueOnce(p1) // P1: normal call, left hanging
      .mockResolvedValueOnce({
        repository: {
          pullRequests: {
            nodes: [makePRNode(42, "feature/a")],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
        rateLimit: { cost: 1, remaining: 4999, resetAt: "" },
      });

    const call1 = githubForgeProvider.listPRs(repo, { state: "open" });
    // Let the deferred dedupe microtask register P1 as the in-flight entry.
    await Promise.resolve();
    const call2 = githubForgeProvider.listPRs(repo, { state: "open", bypassCache: true });
    await call2; // P2 (bypass) resolves with #42 and writes the cache.

    resolveP1({
      repository: {
        pullRequests: {
          nodes: [makePRNode(17, "feature/a")],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
      rateLimit: { cost: 1, remaining: 4999, resetAt: "" },
    });
    await call1; // P1 resolves with stale #17 but is superseded → must not write.

    const after = await githubForgeProvider.listPRs(repo, { state: "open" });
    expect(after.items[0]?.number).toBe(42);
  });

  it("evicts a rejected in-flight promise so the next call retries", async () => {
    mockGraphQLClient
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(prListResponse());

    await expect(githubForgeProvider.listPRs(repo, { state: "open" })).rejects.toThrow();
    const ok = await githubForgeProvider.listPRs(repo, { state: "open" });
    expect(ok.items[0]?.number).toBe(1);
    expect(mockGraphQLClient).toHaveBeenCalledTimes(2);
  });

  it("updates the repo stats count on a first-page open list with a totalCount", async () => {
    mockGraphQLClient.mockResolvedValue(prListResponse(42));
    await githubForgeProvider.listPRs(repo, { state: "open" });
    // updateRepoStatsCount wrote the open PR count into the stats cache.
    // (Asserted indirectly: a cursored page must NOT update it.)
    mockGraphQLClient.mockResolvedValue(prListResponse(99));
    await githubForgeProvider.listPRs(repo, { state: "open", cursor: "next" });
    // No throw and distinct cache keys — cursored result cached separately.
    expect(forgePRListCache.get("pr:owner/repo:open::created:next")).toBeDefined();
  });
});

describe("listIssues caching", () => {
  beforeEach(() => mockGraphQLClient.mockReset());

  it("serves a warm cache entry without a second query", async () => {
    mockGraphQLClient.mockResolvedValue(issueListResponse());
    await githubForgeProvider.listIssues(repo, { state: "open" });
    const second = await githubForgeProvider.listIssues(repo, { state: "open" });
    expect(mockGraphQLClient).toHaveBeenCalledTimes(1);
    expect(second.items[0]?.number).toBe(5);
    expect(forgeIssueListCache.get("issue:owner/repo:open::created:")).toBeDefined();
  });
});

function issueSearchResponse() {
  return {
    search: {
      issueCount: 1,
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [
        {
          number: 9,
          title: "Search hit",
          bodyText: "body",
          state: "OPEN",
          url: "https://github.com/owner/repo/issues/9",
          author: { login: "user", avatarUrl: "" },
          assignees: { nodes: [] },
          labels: { nodes: [] },
          createdAt: "2025-01-01T00:00:00Z",
          updatedAt: "2025-01-01T00:00:00Z",
          closedAt: null,
        },
      ],
    },
    rateLimit: { cost: 1, remaining: 4999, resetAt: "" },
  };
}

describe("listIssues search", () => {
  beforeEach(() => mockGraphQLClient.mockReset());

  it("routes a search term to SEARCH_QUERY with is:issue and a state qualifier", async () => {
    mockGraphQLClient.mockResolvedValue(issueSearchResponse());

    const page = await githubForgeProvider.listIssues(repo, { state: "open", search: "flaky" });

    expect(mockGraphQLClient).toHaveBeenCalledTimes(1);
    const [query, variables] = mockGraphQLClient.mock.calls[0] as [
      string,
      { searchQuery: string; type: string },
    ];
    expect(query).toContain("SearchItems");
    expect(variables.type).toBe("ISSUE");
    expect(variables.searchQuery).toBe(
      "repo:owner/repo is:issue state:open sort:created-desc flaky"
    );
    expect(page.items[0]?.number).toBe(9);
    expect(page.items[0]?.state).toBe("open");
    expect(page.totalCount).toBe(1);
  });

  it("maps the state filter into the query string and omits it for 'all'", async () => {
    mockGraphQLClient.mockResolvedValue(issueSearchResponse());

    await githubForgeProvider.listIssues(repo, { state: "closed", search: "flaky" });
    await githubForgeProvider.listIssues(repo, { state: "all", search: "flaky" });

    const queries = mockGraphQLClient.mock.calls.map(
      (call) => (call[1] as { searchQuery: string }).searchQuery
    );
    expect(queries[0]).toBe("repo:owner/repo is:issue state:closed sort:created-desc flaky");
    expect(queries[1]).toBe("repo:owner/repo is:issue sort:created-desc flaky");
  });

  it("maps opts.sort 'updated' to sort:updated-desc", async () => {
    mockGraphQLClient.mockResolvedValue(issueSearchResponse());

    await githubForgeProvider.listIssues(repo, { state: "open", search: "flaky", sort: "updated" });

    const { searchQuery } = mockGraphQLClient.mock.calls[0]![1] as { searchQuery: string };
    expect(searchQuery).toBe("repo:owner/repo is:issue state:open sort:updated-desc flaky");
  });

  it("truncates the free-text term so the query stays within GitHub's 256-char cap", async () => {
    mockGraphQLClient.mockResolvedValue(issueSearchResponse());

    await githubForgeProvider.listIssues(repo, { state: "open", search: "x".repeat(400) });

    const { searchQuery } = mockGraphQLClient.mock.calls[0]![1] as { searchQuery: string };
    expect(searchQuery.length).toBeLessThanOrEqual(256);
    expect(searchQuery.startsWith("repo:owner/repo is:issue state:open sort:created-desc x")).toBe(
      true
    );
  });

  it("does not coalesce concurrent calls with different search terms", async () => {
    mockGraphQLClient.mockResolvedValueOnce(issueSearchResponse()).mockResolvedValueOnce({
      search: {
        issueCount: 1,
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          {
            number: 11,
            title: "Other hit",
            bodyText: "",
            state: "OPEN",
            url: "https://github.com/owner/repo/issues/11",
            author: { login: "user", avatarUrl: "" },
            assignees: { nodes: [] },
            labels: { nodes: [] },
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
            closedAt: null,
          },
        ],
      },
      rateLimit: { cost: 1, remaining: 4999, resetAt: "" },
    });

    const [a, b] = await Promise.all([
      githubForgeProvider.listIssues(repo, { state: "open", search: "abc" }),
      githubForgeProvider.listIssues(repo, { state: "open", search: "def" }),
    ]);

    expect(mockGraphQLClient).toHaveBeenCalledTimes(2);
    expect(a.items[0]?.number).toBe(9);
    expect(b.items[0]?.number).toBe(11);
  });

  it("does not write search results into the forge issue list cache", async () => {
    mockGraphQLClient.mockResolvedValue(issueSearchResponse());

    await githubForgeProvider.listIssues(repo, { state: "open", search: "flaky" });

    expect(forgeIssueListCache.get("issue:owner/repo:open::created:")).toBeUndefined();

    // A following unfiltered list call misses the cache and issues its own query.
    mockGraphQLClient.mockResolvedValue(issueListResponse());
    const list = await githubForgeProvider.listIssues(repo, { state: "open" });
    expect(list.items[0]?.number).toBe(5);
    expect(mockGraphQLClient).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent identical search calls into a single query", async () => {
    mockGraphQLClient.mockResolvedValue(issueSearchResponse());

    const [a, b] = await Promise.all([
      githubForgeProvider.listIssues(repo, { state: "open", search: "flaky" }),
      githubForgeProvider.listIssues(repo, { state: "open", search: "flaky" }),
    ]);

    expect(mockGraphQLClient).toHaveBeenCalledTimes(1);
    expect(a.items[0]?.number).toBe(9);
    expect(b.items[0]?.number).toBe(9);
  });

  it("ignores a whitespace-only search term and uses the list path", async () => {
    mockGraphQLClient.mockResolvedValue(issueListResponse());

    const page = await githubForgeProvider.listIssues(repo, { state: "open", search: "   " });

    const [query] = mockGraphQLClient.mock.calls[0] as [string];
    expect(query).not.toContain("SearchItems");
    expect(page.items[0]?.number).toBe(5);
  });
});

describe("getPR tooltip pre-warm", () => {
  beforeEach(() => mockGraphQLClient.mockReset());

  it("writes a complete tooltip entry as a side effect of a detail fetch", async () => {
    mockGraphQLClient.mockResolvedValue({
      repository: {
        pullRequest: {
          ...makePRNode(7, "feature/x"),
          assignees: { nodes: [{ login: "alice", avatarUrl: "a.png" }] },
          labels: { nodes: [{ name: "bug", color: "ff0000" }] },
        },
      },
      rateLimit: { cost: 1, remaining: 4999, resetAt: "" },
    });

    const pr = await githubForgeProvider.getPR(repo, 7);
    expect(pr?.number).toBe(7);

    const tooltip = prTooltipCache.get("owner/repo:7");
    expect(tooltip).toBeDefined();
    expect(tooltip?.assignees[0]?.login).toBe("alice");
    expect(tooltip?.labels[0]?.name).toBe("bug");
    expect(tooltip?.createdAt).toBe(Date.parse("2025-01-01T00:00:00Z"));
  });

  it("coalesces concurrent identical detail fetches", async () => {
    mockGraphQLClient.mockResolvedValue({
      repository: { pullRequest: makePRNode(7, "feature/x") },
      rateLimit: { cost: 1, remaining: 4999, resetAt: "" },
    });
    await Promise.all([githubForgeProvider.getPR(repo, 7), githubForgeProvider.getPR(repo, 7)]);
    expect(mockGraphQLClient).toHaveBeenCalledTimes(1);
  });
});

describe("batchLookups.findPRsByNumbers", () => {
  beforeEach(() => mockGraphQLClient.mockReset());

  it("chunks PR-number lookups and maps aliases back to PR numbers", async () => {
    const numbers = Array.from({ length: 21 }, (_, i) => i + 1);
    const firstResponse: Record<string, unknown> = {
      repository: {},
      rateLimit: { cost: 1, remaining: 4999, resetAt: "" },
    };
    const firstRepo = firstResponse.repository as Record<string, unknown>;
    for (let i = 1; i <= 20; i++) {
      firstRepo[`p${i}`] = makePRNode(i, `feature/${i}`);
    }
    const secondResponse = {
      repository: { p21: makePRNode(21, "feature/21") },
      rateLimit: { cost: 1, remaining: 4998, resetAt: "" },
    };
    mockGraphQLClient.mockResolvedValueOnce(firstResponse).mockResolvedValueOnce(secondResponse);

    const result = await githubForgeProvider.batchLookups!.findPRsByNumbers!(repo, [...numbers, 1]);

    expect(mockGraphQLClient).toHaveBeenCalledTimes(2);
    expect(result.size).toBe(21);
    expect(result.get(1)?.headRef).toBe("feature/1");
    expect(result.get(20)?.number).toBe(20);
    expect(result.get(21)?.number).toBe(21);
  });

  it("distinguishes explicit null from omitted aliases", async () => {
    mockGraphQLClient.mockResolvedValueOnce({
      repository: {
        p1: makePRNode(1, "feature/one"),
        p2: null,
        // p3 intentionally omitted: transient partial response, not confirmed missing.
      },
      rateLimit: { cost: 1, remaining: 4999, resetAt: "" },
    });

    const result = await githubForgeProvider.batchLookups!.findPRsByNumbers!(repo, [1, 2, 3]);

    expect(result.get(1)?.number).toBe(1);
    expect(result.has(2)).toBe(true);
    expect(result.get(2)).toBeNull();
    expect(result.has(3)).toBe(false);
  });

  it("pre-warms PR tooltip cache for batched PR-number hits", async () => {
    mockGraphQLClient.mockResolvedValueOnce({
      repository: {
        p7: {
          ...makePRNode(7, "feature/x"),
          assignees: { nodes: [{ login: "alice", avatarUrl: "a.png" }] },
          labels: { nodes: [{ name: "bug", color: "ff0000" }] },
        },
      },
      rateLimit: { cost: 1, remaining: 4999, resetAt: "" },
    });

    await githubForgeProvider.batchLookups!.findPRsByNumbers!(repo, [7]);

    const tooltip = prTooltipCache.get("owner/repo:7");
    expect(tooltip?.assignees[0]?.login).toBe("alice");
    expect(tooltip?.labels[0]?.name).toBe("bug");
  });

  it("skips the network when the GraphQL budget gate is closed", async () => {
    mockShouldBlockRequest.mockReturnValue({
      blocked: true,
      reason: "primary",
      resumeAt: Date.now() + 1000,
    } as ShouldBlockResult);

    const result = await githubForgeProvider.batchLookups!.findPRsByNumbers!(repo, [1, 2]);

    expect(result.size).toBe(0);
    expect(mockGraphQLClient).not.toHaveBeenCalled();
  });
});

function requiredChecksBatchResponse(
  entries: Record<number, { state: string; contexts: Array<Record<string, unknown>> } | null>
) {
  const response: Record<string, unknown> = {
    rateLimit: { cost: 1, remaining: 4999, resetAt: "" },
  };
  for (const [rawNumber, entry] of Object.entries(entries)) {
    const number = Number(rawNumber);
    response[`pr_${number}`] =
      entry === null
        ? { pullRequest: null }
        : {
            pullRequest: {
              number,
              commits: {
                nodes: [
                  {
                    commit: {
                      statusCheckRollup: {
                        state: entry.state,
                        contexts: {
                          nodes: entry.contexts,
                          pageInfo: { hasNextPage: false },
                        },
                      },
                    },
                  },
                ],
              },
            },
          };
  }
  return response;
}

describe("batchLookups.getCIStatuses", () => {
  beforeEach(() => mockGraphQLClient.mockReset());

  it("chunks required-check lookups and returns normalized CI statuses", async () => {
    const firstChunkEntries: Record<
      number,
      { state: string; contexts: Array<Record<string, unknown>> }
    > = {};
    for (let i = 1; i <= 20; i++) {
      firstChunkEntries[i] = {
        state: "SUCCESS",
        contexts: [
          {
            __typename: "CheckRun",
            conclusion: "SUCCESS",
            status: "COMPLETED",
            isRequired: true,
          },
        ],
      };
    }
    firstChunkEntries[2] = {
      state: "FAILURE",
      contexts: [
        {
          __typename: "StatusContext",
          state: "FAILURE",
          isRequired: true,
        },
      ],
    };
    const secondChunk = requiredChecksBatchResponse({
      21: {
        state: "PENDING",
        contexts: [
          {
            __typename: "CheckRun",
            conclusion: null,
            status: "IN_PROGRESS",
            isRequired: true,
          },
        ],
      },
    });
    mockGraphQLClient
      .mockResolvedValueOnce(requiredChecksBatchResponse(firstChunkEntries))
      .mockResolvedValueOnce(secondChunk);

    const result = await githubForgeProvider.batchLookups!.getCIStatuses!(
      repo,
      Array.from({ length: 21 }, (_, i) => i + 1)
    );

    expect(mockGraphQLClient).toHaveBeenCalledTimes(2);
    expect(result.get(1)?.state).toBe("success");
    expect(result.get(1)?.total).toBe(1);
    expect(result.get(2)?.state).toBe("failure");
    expect(result.get(21)?.state).toBe("pending");
    expect(prRequiredStatusCache.get("owner/repo:21")).toBeDefined();
  });

  it("serves cached required-check statuses without a GraphQL call", async () => {
    prRequiredStatusCache.set("owner/repo:5", {
      ciStatus: "SUCCESS",
      ciSummary: { requiredTotal: 1, requiredFailing: 0, requiredPending: 0 },
    });

    const result = await githubForgeProvider.batchLookups!.getCIStatuses!(repo, [5]);

    expect(mockGraphQLClient).not.toHaveBeenCalled();
    expect(result.get(5)?.state).toBe("success");
  });

  it("distinguishes confirmed missing PRs from omitted aliases", async () => {
    mockGraphQLClient.mockResolvedValueOnce(requiredChecksBatchResponse({ 1: null }));

    const result = await githubForgeProvider.batchLookups!.getCIStatuses!(repo, [1, 2]);

    expect(result.has(1)).toBe(true);
    expect(result.get(1)).toBeNull();
    expect(result.has(2)).toBe(false);
  });

  it("returns cached hits and omits misses while rate-limited", async () => {
    prRequiredStatusCache.set("owner/repo:5", {
      ciStatus: "SUCCESS",
      ciSummary: { requiredTotal: 1, requiredFailing: 0, requiredPending: 0 },
    });
    mockShouldBlockRequest.mockReturnValue({
      blocked: true,
      reason: "secondary",
      resumeAt: Date.now() + 1000,
    } as ShouldBlockResult);

    const result = await githubForgeProvider.batchLookups!.getCIStatuses!(repo, [5, 6]);

    expect(mockGraphQLClient).not.toHaveBeenCalled();
    expect(result.get(5)?.state).toBe("success");
    expect(result.has(6)).toBe(false);
  });
});

describe("getCIStatus caching", () => {
  beforeEach(() => mockGraphQLClient.mockReset());

  it("serves the second call from the required-status cache", async () => {
    mockGraphQLClient.mockResolvedValue(ciResponse());
    const first = await githubForgeProvider.getCIStatus(repo, 3);
    const second = await githubForgeProvider.getCIStatus(repo, 3);
    expect(mockGraphQLClient).toHaveBeenCalledTimes(1);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(prRequiredStatusCache.get("owner/repo:3")).toBeDefined();
  });

  it("coalesces concurrent identical CI lookups", async () => {
    mockGraphQLClient.mockResolvedValue(ciResponse());
    await Promise.all([
      githubForgeProvider.getCIStatus(repo, 3),
      githubForgeProvider.getCIStatus(repo, 3),
    ]);
    expect(mockGraphQLClient).toHaveBeenCalledTimes(1);
  });
});

describe("findPRsByBranches rate-limit gate + pre-warm", () => {
  beforeEach(() => mockGraphQLClient.mockReset());

  it("skips the network entirely when rate-limited and returns an empty Map", async () => {
    mockShouldBlockRequest.mockReturnValue({
      blocked: true,
      reason: "secondary",
      resumeAt: Date.now() + 1000,
    } as ShouldBlockResult);
    const result = await githubForgeProvider.findPRsByBranches!(repo, ["feature/a"]);
    expect(result.size).toBe(0);
    expect(mockGraphQLClient).not.toHaveBeenCalled();
  });

  it("pre-warms the PR tooltip cache for resolved branches", async () => {
    mockGraphQLClient.mockResolvedValueOnce({
      b0: {
        pullRequests: {
          nodes: [
            {
              ...makePRNode(11, "feature/a"),
              assignees: { nodes: [{ login: "bob", avatarUrl: "" }] },
              labels: { nodes: [{ name: "feat", color: "00ff00" }] },
            },
          ],
        },
      },
      rateLimit: { cost: 1, remaining: 4999, resetAt: "" },
    });

    await githubForgeProvider.findPRsByBranches!(repo, ["feature/a"]);

    const tooltip = prTooltipCache.get("owner/repo:11");
    expect(tooltip?.assignees[0]?.login).toBe("bob");
    expect(tooltip?.labels[0]?.name).toBe("feat");
  });
});

describe("getRepoActivityProbe", () => {
  beforeEach(async () => {
    mockFetchActivityProbe.mockReset();
    const { repoEventsETagCache } = await import("../GitHubCaches.js");
    repoEventsETagCache.clear();
  });

  it("returns the fresh ETag as the opaque freshness token on a changed probe", async () => {
    mockFetchActivityProbe.mockResolvedValueOnce({
      status: "changed",
      etag: 'W/"fresh-etag"',
    });

    const { freshnessToken } = await githubForgeProvider.getRepoActivityProbe!(repo);

    expect(freshnessToken).toBe('W/"fresh-etag"');
  });

  it("returns the cached ETag on an unchanged probe", async () => {
    const { repoEventsETagCache } = await import("../GitHubCaches.js");
    repoEventsETagCache.set("owner/repo", 'W/"cached-etag"');
    mockFetchActivityProbe.mockResolvedValueOnce({ status: "unchanged" });

    const { freshnessToken } = await githubForgeProvider.getRepoActivityProbe!(repo);

    expect(freshnessToken).toBe('W/"cached-etag"');
  });

  it("throws when the probe status is unknown", async () => {
    mockFetchActivityProbe.mockResolvedValueOnce({ status: "unknown" });

    await expect(githubForgeProvider.getRepoActivityProbe!(repo)).rejects.toThrow();
  });

  it("yields a different token when the ETag changes", async () => {
    mockFetchActivityProbe
      .mockResolvedValueOnce({ status: "changed", etag: 'W/"etag-1"' })
      .mockResolvedValueOnce({ status: "changed", etag: 'W/"etag-2"' });

    const first = await githubForgeProvider.getRepoActivityProbe!(repo);
    const second = await githubForgeProvider.getRepoActivityProbe!(repo);
    expect(first.freshnessToken).not.toBe(second.freshnessToken);
  });

  it("throws when no GitHub token is configured", async () => {
    vi.mocked(GitHubAuth.getToken).mockReturnValueOnce(undefined);
    await expect(githubForgeProvider.getRepoActivityProbe!(repo)).rejects.toThrow();
  });
});

describe("classifyPushError", () => {
  it("extracts a GH### code from protected-branch stderr", () => {
    expect(
      githubForgeProvider.classifyPushError!(
        "GH006: Protected branch update failed for refs/heads/main."
      )
    ).toEqual({ code: "GH006" });
  });

  it("extracts a GH### code from ruleset-violation stderr", () => {
    expect(
      githubForgeProvider.classifyPushError!("remote: GH013: Repository rule violations found.")
    ).toEqual({ code: "GH013" });
  });

  it("returns null when no recognized code is present", () => {
    expect(
      githubForgeProvider.classifyPushError!("fatal: Authentication failed for 'https://...'")
    ).toBeNull();
    expect(githubForgeProvider.classifyPushError!("")).toBeNull();
  });
});

describe("getReviewThreads", () => {
  beforeEach(() => {
    mockGraphQLClient.mockReset();
  });

  function makeThreadNode(id: number) {
    return { path: `src/file${id}.ts`, isResolved: false, isOutdated: false };
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

  it("returns empty array for a PR with zero review threads", async () => {
    mockGraphQLClient.mockResolvedValueOnce(makePageResponse([], false, null));
    const result = await githubForgeProvider.reviews!.getReviewThreads(repo, 1);
    expect(result).toEqual([]);
    expect(mockGraphQLClient).toHaveBeenCalledTimes(1);
  });

  it("returns all threads from a single page", async () => {
    mockGraphQLClient.mockResolvedValueOnce(
      makePageResponse([makeThreadNode(1), makeThreadNode(2)], false, null)
    );
    const result = await githubForgeProvider.reviews!.getReviewThreads(repo, 1);
    expect(result).toHaveLength(2);
    expect(result[0].id).toContain("owner/repo#1");
    expect(result[0].rawData).toEqual(makeThreadNode(1));
  });

  it("paginates across multiple pages", async () => {
    mockGraphQLClient
      .mockResolvedValueOnce(makePageResponse([makeThreadNode(1)], true, "cursor-2"))
      .mockResolvedValueOnce(makePageResponse([makeThreadNode(2)], false, null));
    const result = await githubForgeProvider.reviews!.getReviewThreads(repo, 1);
    expect(result).toHaveLength(2);
    expect(mockGraphQLClient).toHaveBeenCalledTimes(2);
  });

  it("stops after MAX_REVIEW_THREAD_PAGES", async () => {
    // Return more pages than the cap
    for (let i = 0; i < MAX_REVIEW_THREAD_PAGES + 3; i++) {
      const nodes = Array.from({ length: 100 }, (_, j) => makeThreadNode(i * 100 + j));
      mockGraphQLClient.mockResolvedValueOnce(makePageResponse(nodes, true, `cursor-${i + 1}`));
    }

    const result = await githubForgeProvider.reviews!.getReviewThreads(repo, 1);

    expect(mockGraphQLClient).toHaveBeenCalledTimes(MAX_REVIEW_THREAD_PAGES);
    expect(result).toHaveLength(MAX_REVIEW_THREAD_PAGES * 100);
  });

  it("returns all threads when exactly at cap with no more pages", async () => {
    for (let i = 0; i < MAX_REVIEW_THREAD_PAGES; i++) {
      const hasNext = i < MAX_REVIEW_THREAD_PAGES - 1;
      mockGraphQLClient.mockResolvedValueOnce(
        makePageResponse([makeThreadNode(i)], hasNext, hasNext ? `cursor-${i + 1}` : null)
      );
    }

    const result = await githubForgeProvider.reviews!.getReviewThreads(repo, 1);
    expect(mockGraphQLClient).toHaveBeenCalledTimes(MAX_REVIEW_THREAD_PAGES);
    expect(result).toHaveLength(MAX_REVIEW_THREAD_PAGES);
  });
});

describe("createIssue", () => {
  const restIssueResponse = {
    number: 7,
    title: "Add dark mode",
    body: "Body text",
    state: "open",
    html_url: "https://github.com/owner/repo/issues/7",
    user: { login: "octocat", avatar_url: "https://avatars/u" },
    assignees: [{ login: "octocat", avatar_url: "https://avatars/u" }],
    labels: [{ name: "enhancement", color: "a2eeef" }],
    created_at: "2025-01-02T03:04:05Z",
    updated_at: "2025-01-02T03:04:05Z",
    closed_at: null,
  };

  function mockFetchOk(body: unknown = restIssueResponse) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: vi.fn().mockResolvedValue(body),
    });
    (globalThis as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
    return fetchMock;
  }

  beforeEach(() => {
    vi.mocked(GitHubAuth.getToken).mockReturnValue("test-token");
  });

  it("POSTs to the issues endpoint with bearer auth and API version headers", async () => {
    const fetchMock = mockFetchOk();

    await githubForgeProvider.createIssue(repo, { title: "Add dark mode" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/owner/repo/issues");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token");
    expect(headers.Accept).toBe("application/vnd.github+json");
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("normalizes the REST response into a forge Issue", async () => {
    mockFetchOk();

    const issue = await githubForgeProvider.createIssue(repo, { title: "Add dark mode" });

    expect(issue).toMatchObject({
      number: 7,
      title: "Add dark mode",
      body: "Body text",
      state: "open",
      url: "https://github.com/owner/repo/issues/7",
      author: { login: "octocat", avatarUrl: "https://avatars/u" },
      assignees: [{ login: "octocat", avatarUrl: "https://avatars/u" }],
      labels: [{ name: "enhancement", color: "a2eeef" }],
    });
    expect(issue.createdAt).toBe(Date.parse("2025-01-02T03:04:05Z"));
    expect(issue.closedAt).toBeNull();
  });

  it("only sends body and labels when provided", async () => {
    const fetchMock = mockFetchOk();

    await githubForgeProvider.createIssue(repo, {
      title: "With labels",
      body: "Explanation",
      labels: ["bug", "ui"],
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      title: "With labels",
      body: "Explanation",
      labels: ["bug", "ui"],
    });
  });

  it("omits empty body and label arrays from the request", async () => {
    const fetchMock = mockFetchOk();

    await githubForgeProvider.createIssue(repo, { title: "Bare", labels: [] });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ title: "Bare" });
  });

  it("throws when no token is configured", async () => {
    // getToken returns "" / null when unset; either is falsy for the guard.
    vi.mocked(GitHubAuth.getToken).mockReturnValue("");

    await expect(githubForgeProvider.createIssue(repo, { title: "x" })).rejects.toThrow(
      /token not configured/i
    );
  });

  it("throws when the title is blank", async () => {
    mockFetchOk();

    await expect(githubForgeProvider.createIssue(repo, { title: "   " })).rejects.toThrow(
      /title is required/i
    );
  });

  it("surfaces a dedicated message when issues are disabled (HTTP 410)", async () => {
    (globalThis as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch = vi
      .fn()
      .mockResolvedValue({
        ok: false,
        status: 410,
        text: vi.fn().mockResolvedValue("Issues are disabled"),
      });

    await expect(githubForgeProvider.createIssue(repo, { title: "x" })).rejects.toThrow(
      /issues are disabled/i
    );
  });

  it("includes the HTTP status in the error for other failures", async () => {
    (globalThis as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch = vi
      .fn()
      .mockResolvedValue({
        ok: false,
        status: 422,
        text: vi.fn().mockResolvedValue('{"message":"Validation failed"}'),
      });

    await expect(githubForgeProvider.createIssue(repo, { title: "x" })).rejects.toThrow(/HTTP 422/);
  });

  it("rejects when the response body cannot be parsed as JSON", async () => {
    (globalThis as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        status: 201,
        json: vi.fn().mockRejectedValue(new Error("invalid json")),
      });

    await expect(githubForgeProvider.createIssue(repo, { title: "x" })).rejects.toThrow(
      /invalid json/i
    );
  });

  it("rejects a malformed success body missing number or html_url", async () => {
    mockFetchOk({ title: "only a title" });

    await expect(githubForgeProvider.createIssue(repo, { title: "x" })).rejects.toThrow(
      /missing issue number or URL/i
    );
  });

  it("propagates a TimeoutError from the transport", async () => {
    const timeoutError = new Error("aborted");
    timeoutError.name = "TimeoutError";
    (globalThis as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch = vi
      .fn()
      .mockRejectedValue(timeoutError);

    await expect(githubForgeProvider.createIssue(repo, { title: "x" })).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });
});

describe("review write operations", () => {
  function mockReviewFetchOk(status = 200) {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status });
    (globalThis as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
    return fetchMock;
  }

  function expectStandardHeaders(init: RequestInit) {
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token");
    expect(headers.Accept).toBe("application/vnd.github+json");
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  }

  beforeEach(() => {
    vi.mocked(GitHubAuth.getToken).mockReturnValue("test-token");
  });

  describe("approvePR", () => {
    it("POSTs an APPROVE review to the reviews endpoint with standard headers", async () => {
      const fetchMock = mockReviewFetchOk();

      await githubForgeProvider.reviews!.approvePR!(repo, 3);

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.github.com/repos/owner/repo/pulls/3/reviews");
      expect(init.method).toBe("POST");
      expectStandardHeaders(init);
      // No body field when no approval comment is supplied.
      expect(JSON.parse(init.body as string)).toEqual({ event: "APPROVE" });
    });

    it("includes the approval comment when provided", async () => {
      const fetchMock = mockReviewFetchOk();

      await githubForgeProvider.reviews!.approvePR!(repo, 3, "LGTM");

      const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
      expect(JSON.parse(init.body as string)).toEqual({ event: "APPROVE", body: "LGTM" });
    });

    it("invalidates the PR caches so the next getPR reflects the new reviewDecision", async () => {
      mockReviewFetchOk();
      prTooltipCache.set("owner/repo:3", {} as never);
      expect(prTooltipCache.get("owner/repo:3")).toBeDefined();

      await githubForgeProvider.reviews!.approvePR!(repo, 3);

      expect(prTooltipCache.get("owner/repo:3")).toBeUndefined();
    });

    it("throws when no token is configured", async () => {
      vi.mocked(GitHubAuth.getToken).mockReturnValue("");

      await expect(githubForgeProvider.reviews!.approvePR!(repo, 3)).rejects.toThrow(
        /token not configured/i
      );
    });

    it("surfaces the HTTP status when the forge rejects the review", async () => {
      (globalThis as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch = vi
        .fn()
        .mockResolvedValue({
          ok: false,
          status: 422,
          text: vi.fn().mockResolvedValue("Can not approve your own pull request"),
        });

      await expect(githubForgeProvider.reviews!.approvePR!(repo, 3)).rejects.toThrow(/HTTP 422/);
    });
  });

  describe("requestChanges", () => {
    it("POSTs a REQUEST_CHANGES review carrying the body", async () => {
      const fetchMock = mockReviewFetchOk();

      await githubForgeProvider.reviews!.requestChanges!(repo, 4, "Please fix the types");

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.github.com/repos/owner/repo/pulls/4/reviews");
      expect(init.method).toBe("POST");
      expectStandardHeaders(init);
      expect(JSON.parse(init.body as string)).toEqual({
        event: "REQUEST_CHANGES",
        body: "Please fix the types",
      });
    });

    it("invalidates the PR caches", async () => {
      mockReviewFetchOk();
      prTooltipCache.set("owner/repo:4", {} as never);

      await githubForgeProvider.reviews!.requestChanges!(repo, 4, "fix");

      expect(prTooltipCache.get("owner/repo:4")).toBeUndefined();
    });

    it("surfaces the HTTP status on failure", async () => {
      (globalThis as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch = vi
        .fn()
        .mockResolvedValue({
          ok: false,
          status: 422,
          text: vi.fn().mockResolvedValue("Validation failed"),
        });

      await expect(githubForgeProvider.reviews!.requestChanges!(repo, 4, "fix")).rejects.toThrow(
        /HTTP 422/
      );
    });
  });

  describe("dismissReview", () => {
    it("PUTs to the dismissals endpoint with the message and DISMISS event", async () => {
      const fetchMock = mockReviewFetchOk();

      await githubForgeProvider.reviews!.dismissReview!(repo, 5, 99, "No longer relevant");

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.github.com/repos/owner/repo/pulls/5/reviews/99/dismissals");
      expect(init.method).toBe("PUT");
      expectStandardHeaders(init);
      expect(JSON.parse(init.body as string)).toEqual({
        message: "No longer relevant",
        event: "DISMISS",
      });
    });

    it("surfaces the HTTP status on failure", async () => {
      (globalThis as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch = vi
        .fn()
        .mockResolvedValue({
          ok: false,
          status: 404,
          text: vi.fn().mockResolvedValue("Not Found"),
        });

      await expect(githubForgeProvider.reviews!.dismissReview!(repo, 5, 99, "x")).rejects.toThrow(
        /HTTP 404/
      );
    });

    it("throws when no token is configured", async () => {
      vi.mocked(GitHubAuth.getToken).mockReturnValue("");

      await expect(githubForgeProvider.reviews!.dismissReview!(repo, 5, 99, "x")).rejects.toThrow(
        /token not configured/i
      );
    });
  });

  describe("requestReviewers", () => {
    it("POSTs users as reviewers and teams as team_reviewers", async () => {
      const fetchMock = mockReviewFetchOk(201);

      await githubForgeProvider.reviews!.requestReviewers!(repo, 6, {
        users: ["octocat"],
        teams: ["core-team"],
      });

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.github.com/repos/owner/repo/pulls/6/requested_reviewers");
      expect(init.method).toBe("POST");
      expectStandardHeaders(init);
      expect(JSON.parse(init.body as string)).toEqual({
        reviewers: ["octocat"],
        team_reviewers: ["core-team"],
      });
    });

    it("sends empty arrays for the side not supplied", async () => {
      const fetchMock = mockReviewFetchOk(201);

      await githubForgeProvider.reviews!.requestReviewers!(repo, 6, { users: ["octocat"] });

      const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
      expect(JSON.parse(init.body as string)).toEqual({
        reviewers: ["octocat"],
        team_reviewers: [],
      });
    });

    it("rejects without hitting the network when no reviewer is supplied", async () => {
      const fetchMock = mockReviewFetchOk(201);

      await expect(githubForgeProvider.reviews!.requestReviewers!(repo, 6, {})).rejects.toThrow(
        /at least one user or team/i
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("surfaces the HTTP status on failure", async () => {
      (globalThis as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch = vi
        .fn()
        .mockResolvedValue({
          ok: false,
          status: 422,
          text: vi.fn().mockResolvedValue("Reviewer is not a collaborator"),
        });

      await expect(
        githubForgeProvider.reviews!.requestReviewers!(repo, 6, { users: ["octocat"] })
      ).rejects.toThrow(/HTTP 422/);
    });

    it("does NOT invalidate the PR caches (requested reviewers are not part of the cached PR)", async () => {
      mockReviewFetchOk(201);
      prTooltipCache.set("owner/repo:6", {} as never);

      await githubForgeProvider.reviews!.requestReviewers!(repo, 6, { users: ["octocat"] });

      expect(prTooltipCache.get("owner/repo:6")).toBeDefined();
    });
  });
});

describe("issue write mutations (close/reopen/edit/comment/labels)", () => {
  const restIssueResponse = {
    number: 7,
    title: "Add dark mode",
    body: "Body text",
    state: "closed",
    html_url: "https://github.com/owner/repo/issues/7",
    user: { login: "octocat", avatar_url: "https://avatars/u" },
    assignees: [],
    labels: [{ name: "enhancement", color: "a2eeef" }],
    created_at: "2025-01-02T03:04:05Z",
    updated_at: "2025-01-02T03:04:05Z",
    closed_at: "2025-01-03T00:00:00Z",
  };

  function mockJsonOk(body: unknown, status = 200) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status,
      json: vi.fn().mockResolvedValue(body),
    });
    (globalThis as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
    return fetchMock;
  }

  function mockHttpError(status: number, text = "") {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status,
      text: vi.fn().mockResolvedValue(text),
    });
    (globalThis as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
    return fetchMock;
  }

  beforeEach(() => {
    vi.mocked(GitHubAuth.getToken).mockReturnValue("test-token");
  });

  describe("closeIssue", () => {
    it("PATCHes state:closed with the API version headers and returns the normalized issue", async () => {
      const fetchMock = mockJsonOk(restIssueResponse);

      const issue = await githubForgeProvider.closeIssue(repo, 7);

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.github.com/repos/owner/repo/issues/7");
      expect(init.method).toBe("PATCH");
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer test-token");
      expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
      expect(JSON.parse(init.body as string)).toEqual({ state: "closed" });
      expect(issue).toMatchObject({ number: 7, state: "closed" });
      expect(issue.closedAt).toBe(Date.parse("2025-01-03T00:00:00Z"));
    });

    it("forwards an optional state reason", async () => {
      const fetchMock = mockJsonOk(restIssueResponse);

      await githubForgeProvider.closeIssue(repo, 7, "not_planned");

      const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
      expect(JSON.parse(init.body as string)).toEqual({
        state: "closed",
        state_reason: "not_planned",
      });
    });

    it("drops the forge caches after a successful close", async () => {
      mockJsonOk(restIssueResponse);
      forgeIssueListCache.set("owner/repo:open", { items: [], nextCursor: null, hasMore: false });
      expect(forgeIssueListCache.size()).toBe(1);

      await githubForgeProvider.closeIssue(repo, 7);

      expect(forgeIssueListCache.size()).toBe(0);
    });

    it("throws without a token", async () => {
      vi.mocked(GitHubAuth.getToken).mockReturnValue("");
      await expect(githubForgeProvider.closeIssue(repo, 7)).rejects.toThrow(
        /token not configured/i
      );
    });

    it("includes the HTTP status on failure", async () => {
      mockHttpError(403, "forbidden");
      await expect(githubForgeProvider.closeIssue(repo, 7)).rejects.toThrow(/HTTP 403/);
    });
  });

  describe("reopenIssue", () => {
    it("PATCHes state:open and clears the prior close reason", async () => {
      const fetchMock = mockJsonOk({ ...restIssueResponse, state: "open", closed_at: null });

      const issue = await githubForgeProvider.reopenIssue(repo, 7);

      const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
      expect(init.method).toBe("PATCH");
      expect(JSON.parse(init.body as string)).toEqual({ state: "open", state_reason: null });
      expect(issue.state).toBe("open");
    });
  });

  describe("editIssue", () => {
    it("sends only the provided fields", async () => {
      const fetchMock = mockJsonOk(restIssueResponse);

      await githubForgeProvider.editIssue(repo, 7, { title: "New title" });

      const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
      expect(JSON.parse(init.body as string)).toEqual({ title: "New title" });
    });

    it("allows clearing the body with an empty string", async () => {
      const fetchMock = mockJsonOk(restIssueResponse);

      await githubForgeProvider.editIssue(repo, 7, { body: "" });

      const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
      expect(JSON.parse(init.body as string)).toEqual({ body: "" });
    });

    it("rejects an empty input before issuing a request", async () => {
      const fetchMock = mockJsonOk(restIssueResponse);

      await expect(githubForgeProvider.editIssue(repo, 7, {})).rejects.toThrow(
        /at least one of title or body/i
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("addIssueComment", () => {
    const commentResponse = {
      id: 12345,
      body: "Looks good",
      html_url: "https://github.com/owner/repo/issues/7#issuecomment-12345",
      user: { login: "octocat", avatar_url: "https://avatars/u" },
      created_at: "2025-02-01T00:00:00Z",
    };

    it("POSTs the comment body and normalizes the response", async () => {
      const fetchMock = mockJsonOk(commentResponse, 201);

      const comment = await githubForgeProvider.addIssueComment(repo, 7, "Looks good");

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.github.com/repos/owner/repo/issues/7/comments");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({ body: "Looks good" });
      expect(comment).toMatchObject({
        id: "12345",
        body: "Looks good",
        url: "https://github.com/owner/repo/issues/7#issuecomment-12345",
        author: { login: "octocat" },
      });
      expect(comment.createdAt).toBe(Date.parse("2025-02-01T00:00:00Z"));
    });

    it("invalidates only the tooltip cache, not the issue list cache", async () => {
      mockJsonOk(commentResponse, 201);
      const invalidateSpy = vi.spyOn(issueTooltipCache, "invalidate");
      forgeIssueListCache.set("owner/repo:open", { items: [], nextCursor: null, hasMore: false });

      await githubForgeProvider.addIssueComment(repo, 7, "Looks good");

      expect(invalidateSpy).toHaveBeenCalledWith("owner/repo:7");
      expect(forgeIssueListCache.size()).toBe(1);
      invalidateSpy.mockRestore();
    });

    it("rejects a blank comment body before issuing a request", async () => {
      const fetchMock = mockJsonOk(commentResponse, 201);
      await expect(githubForgeProvider.addIssueComment(repo, 7, "   ")).rejects.toThrow(
        /comment body is required/i
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("addIssueLabel", () => {
    const labelsResponse = [
      { name: "bug", color: "ee0701" },
      { name: "enhancement", color: "a2eeef" },
    ];

    it("POSTs the label name and returns the full label set", async () => {
      const fetchMock = mockJsonOk(labelsResponse);

      const labels = await githubForgeProvider.addIssueLabel(repo, 7, "bug");

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.github.com/repos/owner/repo/issues/7/labels");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({ labels: ["bug"] });
      expect(labels).toEqual([
        { name: "bug", color: "ee0701" },
        { name: "enhancement", color: "a2eeef" },
      ]);
    });

    it("rejects a blank label name", async () => {
      const fetchMock = mockJsonOk(labelsResponse);
      await expect(githubForgeProvider.addIssueLabel(repo, 7, "  ")).rejects.toThrow(
        /label name is required/i
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("removeIssueLabel", () => {
    const remainingLabels = [{ name: "enhancement", color: "a2eeef" }];

    it("DELETEs the URL-encoded label name and returns the remaining labels", async () => {
      const fetchMock = mockJsonOk(remainingLabels);

      const labels = await githubForgeProvider.removeIssueLabel(repo, 7, "needs review");

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.github.com/repos/owner/repo/issues/7/labels/needs%20review");
      expect(init.method).toBe("DELETE");
      expect(labels).toEqual([{ name: "enhancement", color: "a2eeef" }]);
    });

    it("throws a specific message when the label is not on the issue (404)", async () => {
      mockHttpError(404, "Label does not exist");
      await expect(githubForgeProvider.removeIssueLabel(repo, 7, "ghost")).rejects.toThrow(
        /'ghost' is not on issue #7/i
      );
    });

    it("includes the HTTP status for other failures", async () => {
      mockHttpError(500, "server error");
      await expect(githubForgeProvider.removeIssueLabel(repo, 7, "bug")).rejects.toThrow(
        /HTTP 500/
      );
    });
  });
});

function parseBuiltUrl(s: string) {
  const url = new URL(s);
  return { path: url.pathname, q: url.searchParams.get("q") };
}

describe("buildIssuesUrl", () => {
  it("returns the bare /issues path with no q param when no options are given", () => {
    const { path, q } = parseBuiltUrl(githubForgeProvider.buildIssuesUrl(repo));
    expect(path).toBe("/owner/repo/issues");
    expect(q).toBeNull();
  });

  it("returns the bare /issues path with no q param when options is empty", () => {
    const { path, q } = parseBuiltUrl(githubForgeProvider.buildIssuesUrl(repo, {}));
    expect(path).toBe("/owner/repo/issues");
    expect(q).toBeNull();
  });

  // #11201: the default open filter with no search should link to the bare
  // /issues list (GitHub already scopes it to `is:issue is:open`), not a raw
  // `?q=is:open` search view.
  it("returns the bare /issues path with no q param for the default open filter", () => {
    const { path, q } = parseBuiltUrl(githubForgeProvider.buildIssuesUrl(repo, { state: "open" }));
    expect(path).toBe("/owner/repo/issues");
    expect(q).toBeNull();
  });

  it("treats an empty-string query with state 'open' as the default open filter", () => {
    const { path, q } = parseBuiltUrl(
      githubForgeProvider.buildIssuesUrl(repo, { query: "", state: "open" })
    );
    expect(path).toBe("/owner/repo/issues");
    expect(q).toBeNull();
  });

  // #11201: once a search query is present the `is:issue` type qualifier is
  // required so results stay scoped to issues and don't leak PRs (GitHub's
  // issue/PR search is unified).
  it("prefixes the is:issue type qualifier when a query is given", () => {
    const { path, q } = parseBuiltUrl(githubForgeProvider.buildIssuesUrl(repo, { query: "bug" }));
    expect(path).toBe("/owner/repo/issues");
    expect(q).toBe("is:issue bug");
  });

  it("keeps the is:open state qualifier alongside a query on the open filter", () => {
    const { path, q } = parseBuiltUrl(
      githubForgeProvider.buildIssuesUrl(repo, { query: "bug", state: "open" })
    );
    expect(path).toBe("/owner/repo/issues");
    expect(q).toBe("is:issue bug is:open");
  });

  // Regression for #9986: the previous implementation gated the `is:<state>`
  // qualifier on `query` being truthy, so `{ state: "closed" }` alone returned
  // the bare /issues URL and silently dropped the filter.
  it("applies the state filter as a q qualifier even when no query is given", () => {
    const { path, q } = parseBuiltUrl(
      githubForgeProvider.buildIssuesUrl(repo, { state: "closed" })
    );
    expect(path).toBe("/owner/repo/issues");
    expect(q).toBe("is:closed");
  });

  it("treats an empty-string query as absent and still applies the state filter", () => {
    const { q } = parseBuiltUrl(
      githubForgeProvider.buildIssuesUrl(repo, { query: "", state: "closed" })
    );
    expect(q).toBe("is:closed");
  });

  it("appends the state qualifier after the query when both are present", () => {
    const { path, q } = parseBuiltUrl(
      githubForgeProvider.buildIssuesUrl(repo, { query: "bug", state: "closed" })
    );
    expect(path).toBe("/owner/repo/issues");
    expect(q).toBe("is:issue bug is:closed");
  });

  it("treats state: 'all' as a no-op when given alone", () => {
    const { path, q } = parseBuiltUrl(githubForgeProvider.buildIssuesUrl(repo, { state: "all" }));
    expect(path).toBe("/owner/repo/issues");
    expect(q).toBeNull();
  });

  it("treats state: 'all' as a no-op even when combined with a query", () => {
    const { q } = parseBuiltUrl(
      githubForgeProvider.buildIssuesUrl(repo, { query: "bug", state: "all" })
    );
    expect(q).toBe("is:issue bug");
  });
});

describe("buildPRsUrl", () => {
  it("returns the bare /pulls path with no q param when no options are given", () => {
    const { path, q } = parseBuiltUrl(githubForgeProvider.buildPRsUrl(repo));
    expect(path).toBe("/owner/repo/pulls");
    expect(q).toBeNull();
  });

  it("returns the bare /pulls path with no q param when options is empty", () => {
    const { path, q } = parseBuiltUrl(githubForgeProvider.buildPRsUrl(repo, {}));
    expect(path).toBe("/owner/repo/pulls");
    expect(q).toBeNull();
  });

  // #11201: the default open filter → bare /pulls list (GitHub already scopes
  // it to `is:pr is:open`), not a raw `?q=is:open` search view.
  it("returns the bare /pulls path with no q param for the default open filter", () => {
    const { path, q } = parseBuiltUrl(githubForgeProvider.buildPRsUrl(repo, { state: "open" }));
    expect(path).toBe("/owner/repo/pulls");
    expect(q).toBeNull();
  });

  it("treats an empty-string query with state 'open' as the default open filter", () => {
    const { path, q } = parseBuiltUrl(
      githubForgeProvider.buildPRsUrl(repo, { query: "", state: "open" })
    );
    expect(path).toBe("/owner/repo/pulls");
    expect(q).toBeNull();
  });

  // #11201: once a search query is present the `is:pr` type qualifier is
  // required so results stay scoped to PRs.
  it("prefixes the is:pr type qualifier when a query is given", () => {
    const { path, q } = parseBuiltUrl(githubForgeProvider.buildPRsUrl(repo, { query: "bug" }));
    expect(path).toBe("/owner/repo/pulls");
    expect(q).toBe("is:pr bug");
  });

  it("keeps the is:open state qualifier alongside a query on the open filter", () => {
    const { path, q } = parseBuiltUrl(
      githubForgeProvider.buildPRsUrl(repo, { query: "bug", state: "open" })
    );
    expect(path).toBe("/owner/repo/pulls");
    expect(q).toBe("is:pr bug is:open");
  });

  // Regression for #9986: see buildIssuesUrl counterpart.
  it("applies the state filter as a q qualifier even when no query is given", () => {
    const { path, q } = parseBuiltUrl(githubForgeProvider.buildPRsUrl(repo, { state: "closed" }));
    expect(path).toBe("/owner/repo/pulls");
    expect(q).toBe("is:closed");
  });

  it("applies state: 'merged' as a q qualifier on its own", () => {
    // PRs only — issues never use "merged" upstream, but the builder must
    // round-trip whatever the caller supplies.
    const { path, q } = parseBuiltUrl(githubForgeProvider.buildPRsUrl(repo, { state: "merged" }));
    expect(path).toBe("/owner/repo/pulls");
    expect(q).toBe("is:merged");
  });

  it("treats an empty-string query as absent and still applies the state filter", () => {
    const { q } = parseBuiltUrl(
      githubForgeProvider.buildPRsUrl(repo, { query: "", state: "merged" })
    );
    expect(q).toBe("is:merged");
  });

  it("appends the state qualifier after the query when both are present", () => {
    const { path, q } = parseBuiltUrl(
      githubForgeProvider.buildPRsUrl(repo, { query: "bug", state: "closed" })
    );
    expect(path).toBe("/owner/repo/pulls");
    expect(q).toBe("is:pr bug is:closed");
  });

  it("treats state: 'all' as a no-op when given alone", () => {
    const { path, q } = parseBuiltUrl(githubForgeProvider.buildPRsUrl(repo, { state: "all" }));
    expect(path).toBe("/owner/repo/pulls");
    expect(q).toBeNull();
  });

  it("treats state: 'all' as a no-op even when combined with a query", () => {
    const { q } = parseBuiltUrl(
      githubForgeProvider.buildPRsUrl(repo, { query: "bug", state: "all" })
    );
    expect(q).toBe("is:pr bug");
  });
});

describe("buildPRFileUrl", () => {
  // GitHub's "Files changed" deep-link uses a `#diff-<sha256-of-utf8-path>`
  // anchor. The hash is over the raw UTF-8 path bytes (not URL-encoded) and
  // the URL must NOT use the legacy `?file=<path>` query — github.com
  // doesn't honor it. The renderer never reconstructs this URL; the
  // decoration provider calls into here.
  function parseDeepLink(url: string): {
    origin: string;
    pathname: string;
    hash: string;
    search: string;
  } {
    const parsed = new URL(url);
    return {
      origin: parsed.origin,
      pathname: parsed.pathname,
      hash: parsed.hash,
      search: parsed.search,
    };
  }

  it("returns a /pull/<n>/files URL with a #diff-<sha256> fragment", () => {
    const url = githubForgeProvider.buildPRFileUrl!(repo, 42, "src/a.ts");
    const { pathname, hash, search } = parseDeepLink(url);
    expect(pathname).toBe("/owner/repo/pull/42/files");
    expect(search).toBe(""); // The legacy `?file=` shape must NOT be used
    expect(hash).toMatch(/^#diff-[0-9a-f]{64}$/);
  });

  it("hashes the path as raw UTF-8 bytes, not URL-encoded form", () => {
    // The SHA-256 of "src/has space.ts" must match the raw-byte form.
    // If the implementation accidentally URL-encodes first, the hash will
    // diverge from the github.com anchor (which hashes the raw path).
    const path = "src/has space.ts";
    const url = githubForgeProvider.buildPRFileUrl!(repo, 1, path);
    const { hash } = parseDeepLink(url);
    const rawHash = createHash("sha256").update(path, "utf8").digest("hex");
    const encodedHash = createHash("sha256").update(encodeURIComponent(path), "utf8").digest("hex");
    expect(hash).toBe(`#diff-${rawHash}`);
    // Sanity: URL-encoded form would produce a DIFFERENT hash. If the
    // implementation encoded the path first, the raw-hash assertion above
    // would fail — this is just a documentation of why those two are
    // expected to differ.
    expect(rawHash).not.toBe(encodedHash);
  });

  it("produces different hashes for different paths", () => {
    const url1 = githubForgeProvider.buildPRFileUrl!(repo, 1, "src/a.ts");
    const url2 = githubForgeProvider.buildPRFileUrl!(repo, 1, "src/b.ts");
    expect(parseDeepLink(url1).hash).not.toBe(parseDeepLink(url2).hash);
  });

  it("produces the same hash for the same path on different PR numbers", () => {
    const url1 = githubForgeProvider.buildPRFileUrl!(repo, 1, "src/a.ts");
    const url2 = githubForgeProvider.buildPRFileUrl!(repo, 999, "src/a.ts");
    const hash1 = parseDeepLink(url1).hash;
    const hash2 = parseDeepLink(url2).hash;
    expect(hash1).toBe(hash2);
    // Path component is the only thing that should differ
    expect(parseDeepLink(url1).pathname).toBe("/owner/repo/pull/1/files");
    expect(parseDeepLink(url2).pathname).toBe("/owner/repo/pull/999/files");
  });

  it("uses the well-known SHA-256 of 'src/a.ts' as the anchor", () => {
    // Locks the algorithm: any future change to the hash function or input
    // encoding would break this fixture.
    const expected = createHash("sha256").update("src/a.ts", "utf8").digest("hex");
    const url = githubForgeProvider.buildPRFileUrl!(repo, 42, "src/a.ts");
    expect(parseDeepLink(url).hash).toBe(`#diff-${expected}`);
  });
});

describe("getRateLimit", () => {
  afterEach(() => {
    vi.mocked(gitHubRateLimitService.getState).mockReturnValue({ blocked: false } as never);
  });

  it("includes throttleMultiplier when not blocked so the bridge path carries throttle state", async () => {
    vi.mocked(gitHubRateLimitService.getState).mockReturnValue({
      blocked: false,
      kind: null,
      throttleMultiplier: 3,
    } as never);

    await expect(githubForgeProvider.getRateLimit!()).resolves.toEqual({
      limit: null,
      remaining: null,
      resetAt: null,
      throttleMultiplier: 3,
    });
  });

  it("defaults throttleMultiplier to 1 when the state omits it", async () => {
    vi.mocked(gitHubRateLimitService.getState).mockReturnValue({
      blocked: false,
      kind: null,
    } as never);

    const info = await githubForgeProvider.getRateLimit!();
    expect(info.throttleMultiplier).toBe(1);
  });

  it("includes throttleMultiplier and the secondary flag when blocked", async () => {
    vi.mocked(gitHubRateLimitService.getState).mockReturnValue({
      blocked: true,
      kind: "secondary",
      resetAt: 123,
      throttleMultiplier: 8,
    } as never);

    await expect(githubForgeProvider.getRateLimit!()).resolves.toEqual({
      limit: null,
      remaining: 0,
      resetAt: 123,
      secondaryThrottled: true,
      throttleMultiplier: 8,
    });
  });
});
