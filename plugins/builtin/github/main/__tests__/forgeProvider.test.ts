import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatErrorMessage } from "../../../../../shared/utils/errorMessage.js";

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
import type { RepoRef } from "../../../../../shared/types/forge.js";

const repo: RepoRef = { host: "github.com", owner: "owner", repo: "repo", rawData: null };

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
