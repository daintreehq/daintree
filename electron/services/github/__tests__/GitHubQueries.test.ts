import { describe, expect, it } from "vitest";
import {
  buildBatchPRQuery,
  buildBatchRequiredChecksQuery,
  LIST_PRS_QUERY,
  REPO_STATS_AND_PAGE_QUERY,
  SEARCH_QUERY,
  GET_PR_QUERY,
  PROJECT_HEALTH_QUERY,
} from "../GitHubQueries.js";

describe("PROJECT_HEALTH_QUERY", () => {
  it("fetches CI status via statusCheckRollup on default branch", () => {
    expect(PROJECT_HEALTH_QUERY).toContain("defaultBranchRef");
    expect(PROJECT_HEALTH_QUERY).toContain("statusCheckRollup");
    expect(PROJECT_HEALTH_QUERY).toContain("... on Commit");
  });

  it("fetches latest release fields", () => {
    expect(PROJECT_HEALTH_QUERY).toContain("latestRelease");
    expect(PROJECT_HEALTH_QUERY).toContain("tagName");
    expect(PROJECT_HEALTH_QUERY).toContain("publishedAt");
  });

  it("fetches vulnerability alerts with required first argument", () => {
    expect(PROJECT_HEALTH_QUERY).toContain("vulnerabilityAlerts(first: 1)");
    expect(PROJECT_HEALTH_QUERY).toContain("totalCount");
  });

  it("uses search API for accurate merged PR counts per range", () => {
    expect(PROJECT_HEALTH_QUERY).toContain("mergedPRs60: search");
    expect(PROJECT_HEALTH_QUERY).toContain("mergedPRs120: search");
    expect(PROJECT_HEALTH_QUERY).toContain("mergedPRs180: search");
    expect(PROJECT_HEALTH_QUERY).toContain("issueCount");
  });

  it("accepts merged search query variables for each range", () => {
    expect(PROJECT_HEALTH_QUERY).toContain("$merged60: String!");
    expect(PROJECT_HEALTH_QUERY).toContain("$merged120: String!");
    expect(PROJECT_HEALTH_QUERY).toContain("$merged180: String!");
  });

  it("fetches open issue and PR counts", () => {
    expect(PROJECT_HEALTH_QUERY).toContain("issues(states: OPEN)");
    expect(PROJECT_HEALTH_QUERY).toContain("pullRequests(states: OPEN)");
  });
});

describe("REPO_STATS_AND_PAGE_QUERY", () => {
  it("fetches the first 20 open issues sorted by created-desc", () => {
    expect(REPO_STATS_AND_PAGE_QUERY).toContain(
      "issues(first: 20, states: OPEN, orderBy: {field: CREATED_AT, direction: DESC})"
    );
  });

  it("fetches the first 20 open pullRequests sorted by created-desc", () => {
    expect(REPO_STATS_AND_PAGE_QUERY).toContain(
      "pullRequests(first: 20, states: OPEN, orderBy: {field: CREATED_AT, direction: DESC})"
    );
  });

  it("does not reference PullRequestOrder (the schema uses IssueOrder for both connections)", () => {
    // Past lesson #3339: Repository.pullRequests.orderBy expects IssueOrder,
    // not PullRequestOrder. The combined query sidesteps this by inlining the
    // order literal — keep it that way so a future refactor can't reintroduce
    // a $orderBy: PullRequestOrder variable.
    expect(REPO_STATS_AND_PAGE_QUERY).not.toContain("PullRequestOrder");
  });

  it("does not declare a $query variable (rejected by @octokit/graphql)", () => {
    // Past lesson #1376.
    expect(REPO_STATS_AND_PAGE_QUERY).not.toContain("$query");
  });

  it("returns totalCount and pageInfo for both connections", () => {
    const issuesBlock = REPO_STATS_AND_PAGE_QUERY.slice(
      REPO_STATS_AND_PAGE_QUERY.indexOf("issues(first: 20"),
      REPO_STATS_AND_PAGE_QUERY.indexOf("pullRequests(first: 20")
    );
    expect(issuesBlock).toContain("totalCount");
    expect(issuesBlock).toContain("pageInfo { hasNextPage endCursor }");

    const prsBlock = REPO_STATS_AND_PAGE_QUERY.slice(
      REPO_STATS_AND_PAGE_QUERY.indexOf("pullRequests(first: 20")
    );
    expect(prsBlock).toContain("totalCount");
    expect(prsBlock).toContain("pageInfo { hasNextPage endCursor }");
  });

  it("includes statusCheckRollup on PRs so the toolbar can render CI badges from the broadcast", () => {
    expect(REPO_STATS_AND_PAGE_QUERY).toContain("statusCheckRollup");
  });

  it("returns the issue fields the disk-cache validator (isIssueLike) requires", () => {
    // GitHubFirstPageCache.isIssueLike rejects items missing author{login,
    // avatarUrl} or assignees. Drop one of these from the query and the
    // disk-cache write produces a null page, breaking cold-start hydration.
    const issuesBlock = REPO_STATS_AND_PAGE_QUERY.slice(
      REPO_STATS_AND_PAGE_QUERY.indexOf("issues(first: 20"),
      REPO_STATS_AND_PAGE_QUERY.indexOf("pullRequests(first: 20")
    );
    expect(issuesBlock).toContain("author { login avatarUrl }");
    expect(issuesBlock).toContain("assignees");
  });

  it("returns the PR fields the disk-cache validator (isPRLike) requires", () => {
    // GitHubFirstPageCache.isPRLike requires author{login, avatarUrl} and
    // isDraft. Same hydration-break risk if either is dropped.
    const prsBlock = REPO_STATS_AND_PAGE_QUERY.slice(
      REPO_STATS_AND_PAGE_QUERY.indexOf("pullRequests(first: 20")
    );
    expect(prsBlock).toContain("author { login avatarUrl }");
    expect(prsBlock).toContain("isDraft");
  });
});

describe("LIST_PRS_QUERY", () => {
  it("uses IssueOrder (not PullRequestOrder) for the orderBy variable type", () => {
    expect(LIST_PRS_QUERY).toContain("$orderBy: IssueOrder");
    expect(LIST_PRS_QUERY).not.toContain("PullRequestOrder");
  });

  it("fetches comments totalCount", () => {
    expect(LIST_PRS_QUERY).toContain("comments");
    expect(LIST_PRS_QUERY).toContain("totalCount");
  });
});

describe("SEARCH_QUERY", () => {
  it("fetches comments totalCount in PR fragment", () => {
    const prFragment = SEARCH_QUERY.slice(SEARCH_QUERY.indexOf("... on PullRequest"));
    expect(prFragment).toContain("comments");
  });
});

describe("GET_PR_QUERY", () => {
  it("fetches comments totalCount", () => {
    expect(GET_PR_QUERY).toContain("comments");
  });
});

describe("buildBatchPRQuery — no comments field", () => {
  it("does not include comments in batch query output", () => {
    const query = buildBatchPRQuery("owner", "repo", [{ worktreeId: "wt-1", branchName: "main" }]);
    expect(query).not.toContain("comments");
  });
});

describe("buildBatchPRQuery", () => {
  it("escapes owner, repo, and branch values in generated GraphQL query", () => {
    const query = buildBatchPRQuery('my"owner', "repo\\name", [
      {
        worktreeId: "wt-1",
        issueNumber: 12,
        branchName: 'feat"branch',
      },
    ]);

    expect(query).toContain('owner: "my\\"owner"');
    expect(query).toContain('name: "repo\\\\name"');
    expect(query).toContain('headRefName: "feat\\"branch"');
  });

  it("builds required-checks query with per-PR aliases and inlined pullRequestNumber", () => {
    const query = buildBatchRequiredChecksQuery("owner", "repo", [12, 34]);
    expect(query).toContain("pr_12: repository");
    expect(query).toContain("pr_34: repository");
    expect(query).toContain("pullRequest(number: 12)");
    expect(query).toContain("pullRequest(number: 34)");
    expect(query).toContain("isRequired(pullRequestNumber: 12)");
    expect(query).toContain("isRequired(pullRequestNumber: 34)");
    expect(query).toContain("contexts(first: 50)");
    expect(query).toContain("... on CheckRun");
    expect(query).toContain("... on StatusContext");
    expect(query).toContain("hasNextPage");
  });

  it("returns empty string when no valid PR numbers are supplied", () => {
    expect(buildBatchRequiredChecksQuery("owner", "repo", [])).toBe("");
    expect(buildBatchRequiredChecksQuery("owner", "repo", [-1, 0, 2.5])).toBe("");
  });

  it("escapes owner and repo in required-checks query", () => {
    const query = buildBatchRequiredChecksQuery('my"owner', "repo\\name", [7]);
    expect(query).toContain('owner: "my\\"owner"');
    expect(query).toContain('name: "repo\\\\name"');
  });

  it("includes issue lookups only for positive integer issue numbers", () => {
    const query = buildBatchPRQuery("owner", "repo", [
      { worktreeId: "wt-1", issueNumber: -1 },
      { worktreeId: "wt-2", issueNumber: 2.5 },
      { worktreeId: "wt-3", issueNumber: 7 },
      { worktreeId: "wt-4", branchName: "feature-branch" },
    ]);

    expect(query).not.toContain("issue(number: -1)");
    expect(query).not.toContain("issue(number: 2.5)");
    expect(query).toContain("issue(number: 7)");
    expect(query).toContain('headRefName: "feature-branch"');
  });
});
