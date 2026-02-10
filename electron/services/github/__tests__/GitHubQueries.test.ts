import { describe, expect, it } from "vitest";
import { buildBatchPRQuery } from "../GitHubQueries.js";

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
