import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatErrorMessage } from "../../../../../shared/utils/errorMessage.js";
import { MAX_REVIEW_THREAD_PAGES } from "../GitHubCaches.js";

const mockGraphQLClient = vi.fn();

vi.mock("../GitHubAuth.js", () => ({
  GitHubAuth: {
    getToken: vi.fn(() => "test-token"),
    createClient: vi.fn(() => mockGraphQLClient),
  },
  GITHUB_API_TIMEOUT_MS: 5000,
}));

vi.mock("../GitHubRateLimitService.js", () => ({
  gitHubRateLimitService: {
    updateFromGraphQL: vi.fn(),
    getState: vi.fn(() => ({ blocked: false })),
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
  forgeQueryCache,
} from "../GitHubCaches.js";
import type { RepoRef } from "../../../../../shared/types/forge.js";

const repo: RepoRef = { host: "github.com", owner: "owner", repo: "repo", rawData: null };

// runQuery caches + coalesces across all provider methods, so every suite must
// start from a clean cache or call-count assertions become order-dependent.
beforeEach(() => {
  _resetForgeQueryCachesForTests();
});

function makePRNode(number: number, headRefName: string) {
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
  };
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
