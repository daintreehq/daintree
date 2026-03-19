import { describe, expect, it } from "vitest";
import {
  buildBatchPRQuery,
  LIST_PRS_QUERY,
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
