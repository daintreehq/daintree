import { describe, expect, it } from "vitest";
import {
  BATCH_BRANCH_CHUNK_SIZE,
  GRAPHQL_BATCH_CHUNK_SIZE,
  buildBatchBranchPRQuery,
  buildBatchPRQuery,
  buildBatchRequiredChecksQuery,
  buildBatchIssuesQuery,
  buildBatchPRsQuery,
  LIST_ISSUE_COMMENTS_QUERY,
  LIST_PRS_QUERY,
  REPO_STATS_AND_PAGE_QUERY,
  SEARCH_QUERY,
  GET_PR_QUERY,
  PROJECT_HEALTH_QUERY,
  MERGE_VELOCITY_QUERY,
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

  it("does not duplicate the open issue/PR counts already fetched by the stats query", () => {
    // Issue #8757: open counts are read from `repoStatsCache` (populated by
    // REPO_STATS_AND_PAGE_QUERY), so re-fetching them here is wasteful.
    expect(PROJECT_HEALTH_QUERY).not.toContain("issues(states: OPEN)");
    expect(PROJECT_HEALTH_QUERY).not.toContain("pullRequests(states: OPEN)");
  });

  it("does not run merged-PR velocity search blocks (moved to MERGE_VELOCITY_QUERY)", () => {
    // Issue #8757: the three `search` blocks change on a days timescale and
    // moved to MERGE_VELOCITY_QUERY behind a long-lived cache.
    expect(PROJECT_HEALTH_QUERY).not.toContain("search(");
    expect(PROJECT_HEALTH_QUERY).not.toContain("$merged60");
    expect(PROJECT_HEALTH_QUERY).not.toContain("$merged120");
    expect(PROJECT_HEALTH_QUERY).not.toContain("$merged180");
  });

  it("declares only owner and repo as variables", () => {
    expect(PROJECT_HEALTH_QUERY).toContain("$owner: String!");
    expect(PROJECT_HEALTH_QUERY).toContain("$repo: String!");
  });
});

describe("MERGE_VELOCITY_QUERY", () => {
  it("uses search API for accurate merged PR counts per range", () => {
    expect(MERGE_VELOCITY_QUERY).toContain("mergedPRs60: search");
    expect(MERGE_VELOCITY_QUERY).toContain("mergedPRs120: search");
    expect(MERGE_VELOCITY_QUERY).toContain("mergedPRs180: search");
    expect(MERGE_VELOCITY_QUERY).toContain("issueCount");
  });

  it("accepts a merged-search query variable for each range", () => {
    expect(MERGE_VELOCITY_QUERY).toContain("$merged60: String!");
    expect(MERGE_VELOCITY_QUERY).toContain("$merged120: String!");
    expect(MERGE_VELOCITY_QUERY).toContain("$merged180: String!");
  });

  it("does not declare a $query variable (rejected by @octokit/graphql)", () => {
    // Past lesson #1376: @octokit/graphql reserves `query` for the document.
    expect(MERGE_VELOCITY_QUERY).not.toContain("$query");
  });

  it("includes rateLimit so velocity fetches keep rate-limit state in sync", () => {
    expect(MERGE_VELOCITY_QUERY).toContain("rateLimit {");
    expect(MERGE_VELOCITY_QUERY).toContain("cost");
    expect(MERGE_VELOCITY_QUERY).toContain("remaining");
    expect(MERGE_VELOCITY_QUERY).toContain("resetAt");
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

  it("includes reviewDecision and mergeStateStatus on the PR fragment", () => {
    const prsBlock = REPO_STATS_AND_PAGE_QUERY.slice(
      REPO_STATS_AND_PAGE_QUERY.indexOf("pullRequests(first: 20")
    );
    expect(prsBlock).toContain("reviewDecision");
    expect(prsBlock).toContain("mergeStateStatus");
  });

  it("includes statusCheckRollup.contexts aggregate scalars on the PR fragment", () => {
    const prsBlock = REPO_STATS_AND_PAGE_QUERY.slice(
      REPO_STATS_AND_PAGE_QUERY.indexOf("pullRequests(first: 20")
    );
    expect(prsBlock).toContain("contexts {");
    expect(prsBlock).toContain("checkRunCount");
    expect(prsBlock).toContain("statusContextCount");
    expect(prsBlock).toContain("checkRunCountsByState {");
    expect(prsBlock).toContain("statusContextCountsByState {");
    // Must not include first: or last: on the contexts connection
    const contextsLine = prsBlock.slice(
      prsBlock.indexOf("contexts {"),
      prsBlock.indexOf("contexts {") + 50
    );
    expect(contextsLine).not.toMatch(/\bfirst\b/);
    expect(contextsLine).not.toMatch(/\blast\b/);
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
    expect(issuesBlock).toContain("assignees(first: 10) { nodes { login avatarUrl } }");
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

describe("LIST_ISSUE_COMMENTS_QUERY", () => {
  it("selects raw markdown body, not the bodyText projection", () => {
    // The REST write path returns raw markdown; a bodyText read would strip
    // formatting on the way back and break round-trip fidelity.
    const commentSelection = /nodes\s*\{([^}]*)\}/.exec(LIST_ISSUE_COMMENTS_QUERY)?.[1] ?? "";
    expect(commentSelection).toContain("body");
    expect(commentSelection).not.toContain("bodyText");
  });

  it("selects every comment field the mapper projects", () => {
    // Scoped to the node selection: a global toContain would pass even if one
    // of these moved to the wrong level of the query.
    const commentSelection = /nodes\s*\{([^}]*)\}/.exec(LIST_ISSUE_COMMENTS_QUERY)?.[1] ?? "";
    for (const field of ["id", "databaseId", "body", "url", "createdAt", "author"]) {
      expect(commentSelection).toContain(field);
    }
  });

  it("selects the author's login and avatar, not a bare actor node", () => {
    const authorSelection = /author\s*\{([^}]*)\}/.exec(LIST_ISSUE_COMMENTS_QUERY)?.[1] ?? "";
    expect(authorSelection).toContain("login");
    expect(authorSelection).toContain("avatarUrl");
  });

  it("pages forward with first/after and returns pageInfo plus totalCount", () => {
    expect(LIST_ISSUE_COMMENTS_QUERY).toContain("comments(first: $limit, after: $cursor)");
    expect(LIST_ISSUE_COMMENTS_QUERY).toContain("hasNextPage");
    expect(LIST_ISSUE_COMMENTS_QUERY).toContain("endCursor");
    expect(LIST_ISSUE_COMMENTS_QUERY).toContain("totalCount");
  });

  it("does not order the connection (IssueCommentOrderField has no CREATED_AT)", () => {
    expect(LIST_ISSUE_COMMENTS_QUERY).not.toContain("orderBy");
  });

  it("includes the rateLimit fields the accounting service reads", () => {
    const rateLimitSelection = /rateLimit\s*\{([^}]*)\}/.exec(LIST_ISSUE_COMMENTS_QUERY)?.[1] ?? "";
    for (const field of ["cost", "remaining", "resetAt", "limit"]) {
      expect(rateLimitSelection).toContain(field);
    }
  });

  it("declares every variable it interpolates", () => {
    const declared =
      /query ListIssueComments\(([^)]*)\)/.exec(LIST_ISSUE_COMMENTS_QUERY)?.[1] ?? "";
    const used = new Set(LIST_ISSUE_COMMENTS_QUERY.match(/\$\w+/g) ?? []);
    for (const variable of used) {
      expect(declared).toContain(variable);
    }
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

  it("fetches reviewDecision and mergeStateStatus at the PR node level", () => {
    expect(LIST_PRS_QUERY).toContain("reviewDecision");
    expect(LIST_PRS_QUERY).toContain("mergeStateStatus");
  });

  it("selects reviewDecision as a bare scalar (zero-cost approval badge)", () => {
    expect(LIST_PRS_QUERY).toContain("reviewDecision");
    // Bare scalar — no connection arguments that would add query cost.
    expect(LIST_PRS_QUERY).not.toContain("reviewDecision(");
  });

  it("fetches statusCheckRollup.contexts aggregate scalars without first/last args", () => {
    // contexts must NOT use first: or last: — aggregate scalars are
    // available on the connection type itself without pagination args.
    const rollupSection = LIST_PRS_QUERY.slice(LIST_PRS_QUERY.indexOf("statusCheckRollup {"));
    expect(rollupSection).toContain("contexts {");
    expect(rollupSection).toContain("checkRunCount");
    expect(rollupSection).toContain("statusContextCount");
    expect(rollupSection).toContain("checkRunCountsByState {");
    expect(rollupSection).toContain("statusContextCountsByState {");
    expect(rollupSection).toContain("state");
    expect(rollupSection).toContain("count");

    // Must not include first: or last: on the contexts connection
    const contextsLine = rollupSection.slice(
      rollupSection.indexOf("contexts {"),
      rollupSection.indexOf("contexts {") + 50
    );
    expect(contextsLine).not.toMatch(/\bfirst\b/);
    expect(contextsLine).not.toMatch(/\blast\b/);
  });

  it("retains the raw statusCheckRollup.state field", () => {
    expect(LIST_PRS_QUERY).toContain("statusCheckRollup {");
    expect(LIST_PRS_QUERY).toContain("state");
  });
});

describe("SEARCH_QUERY", () => {
  it("fetches comments totalCount in PR fragment", () => {
    const prFragment = SEARCH_QUERY.slice(SEARCH_QUERY.indexOf("... on PullRequest"));
    expect(prFragment).toContain("comments");
  });

  it("selects reviewDecision in the PR fragment so searched PRs carry the badge", () => {
    const prFragment = SEARCH_QUERY.slice(SEARCH_QUERY.indexOf("... on PullRequest"));
    expect(prFragment).toContain("reviewDecision");
  });
});

describe("GET_PR_QUERY", () => {
  it("fetches comments totalCount", () => {
    expect(GET_PR_QUERY).toContain("comments");
  });

  it("selects reviewDecision so getPR matches listPRs", () => {
    expect(GET_PR_QUERY).toContain("reviewDecision");
  });
});

describe("buildBatchPRQuery — no comments field", () => {
  it("does not include comments in batch query output", () => {
    const query = buildBatchPRQuery("owner", "repo", [{ worktreeId: "wt-1", branchName: "main" }]);
    expect(query).not.toContain("comments");
  });
});

describe("buildBatchPRQuery — statusCheckRollup", () => {
  it("requests statusCheckRollup for branch-path PR nodes", () => {
    const query = buildBatchPRQuery("owner", "repo", [
      { worktreeId: "wt-1", branchName: "feature/x" },
    ]);
    expect(query).toContain("statusCheckRollup { state }");
  });

  it("requests statusCheckRollup on issue-timeline PR fragments", () => {
    const query = buildBatchPRQuery("owner", "repo", [{ worktreeId: "wt-1", issueNumber: 42 }]);
    // Both CrossReferencedEvent.source and ConnectedEvent.subject inline
    // fragments should request rollup state, so the badge can render CI
    // status for issue-linked PRs without an extra round-trip.
    const matches = query.match(/statusCheckRollup \{ state \}/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });

  it("requests updatedAt on issue-timeline PR fragments for latest-linked-PR selection", () => {
    const query = buildBatchPRQuery("owner", "repo", [{ worktreeId: "wt-1", issueNumber: 42 }]);
    expect(query).toContain("updatedAt");
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
    expect(query).toContain("contexts(first: 100)");
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

  describe("tooltip pre-warm fields", () => {
    // The poll-driven batch query over-fetches PR fields that match
    // PRTooltipData so `prTooltipCache` can be warmed without an extra
    // round-trip on first hover. Both query paths (issue timeline + branch
    // search) must emit the same field shape.

    it("includes tooltip fields on the issue-path PR fragments", () => {
      const query = buildBatchPRQuery("owner", "repo", [{ worktreeId: "wt-1", issueNumber: 42 }]);

      // Locate the issue path slice (no branch path emitted for this candidate).
      const issuePathStart = query.indexOf("wt_0_issue:");
      expect(issuePathStart).toBeGreaterThanOrEqual(0);
      const issuePath = query.slice(issuePathStart);

      // Both timeline event types resolve to PullRequest fragments — both
      // need the tooltip projection so either codepath warms the cache.
      const sourceFragmentStart = issuePath.indexOf("source");
      const subjectFragmentStart = issuePath.indexOf("subject");
      expect(sourceFragmentStart).toBeGreaterThanOrEqual(0);
      expect(subjectFragmentStart).toBeGreaterThan(sourceFragmentStart);

      const sourceFragment = issuePath.slice(sourceFragmentStart, subjectFragmentStart);
      const subjectFragment = issuePath.slice(subjectFragmentStart);

      for (const fragment of [sourceFragment, subjectFragment]) {
        expect(fragment).toContain("bodyText");
        expect(fragment).toContain("createdAt");
        expect(fragment).toContain("author { login avatarUrl }");
        expect(fragment).toContain("assignees(first: 10) { nodes { login avatarUrl } }");
        expect(fragment).toContain("labels(first: 10) { nodes { name color } }");
      }
    });

    it("includes tooltip fields on the branch-path PR nodes", () => {
      const query = buildBatchPRQuery("owner", "repo", [
        { worktreeId: "wt-1", branchName: "feature-branch" },
      ]);

      const branchPathStart = query.indexOf("wt_0_branch:");
      expect(branchPathStart).toBeGreaterThanOrEqual(0);
      const branchPath = query.slice(branchPathStart);

      expect(branchPath).toContain("bodyText");
      expect(branchPath).toContain("createdAt");
      expect(branchPath).toContain("author { login avatarUrl }");
      expect(branchPath).toContain("assignees(first: 10) { nodes { login avatarUrl } }");
      expect(branchPath).toContain("labels(first: 10) { nodes { name color } }");
    });

    it("does not add an orderBy argument to assignees or labels connections", () => {
      // Past lesson #3339: schema-context mismatches on connection ordering
      // produce silent failures. Neither GitHub's PR.assignees nor PR.labels
      // accepts an order arg; keep the call sites bare.
      const query = buildBatchPRQuery("owner", "repo", [
        { worktreeId: "wt-1", issueNumber: 42, branchName: "feature-branch" },
      ]);

      expect(query).not.toMatch(/assignees\(first:\s*\d+,\s*orderBy/);
      expect(query).not.toMatch(/labels\(first:\s*10,\s*orderBy/);
    });

    it("uses bodyText (not body) so the response carries plain-text excerpt content", () => {
      // GraphQL has both `body` (Markdown) and `bodyText` (plain text). The
      // tooltip excerpt is rendered as plain text; using `body` would force
      // every consumer to strip Markdown and breaks parity with getPRTooltip.
      const query = buildBatchPRQuery("owner", "repo", [
        { worktreeId: "wt-1", issueNumber: 42, branchName: "feature-branch" },
      ]);

      expect(query).toContain("bodyText");
      // `body` is not present as a standalone field on either path. Match
      // a word boundary to avoid matching `bodyText`.
      expect(query).not.toMatch(/\bbody\b(?!Text)/);
    });
  });

  describe("rateLimit field", () => {
    it("includes rateLimit at operation root in REPO_STATS_AND_PAGE_QUERY", () => {
      expect(REPO_STATS_AND_PAGE_QUERY).toContain("rateLimit {");
      expect(REPO_STATS_AND_PAGE_QUERY).toContain("cost");
      expect(REPO_STATS_AND_PAGE_QUERY).toContain("remaining");
      expect(REPO_STATS_AND_PAGE_QUERY).toContain("resetAt");
    });

    it("includes rateLimit in PROJECT_HEALTH_QUERY", () => {
      expect(PROJECT_HEALTH_QUERY).toContain("rateLimit {");
    });

    it("includes rateLimit in SEARCH_QUERY", () => {
      expect(SEARCH_QUERY).toContain("rateLimit {");
    });

    it("includes rateLimit in GET_PR_QUERY", () => {
      expect(GET_PR_QUERY).toContain("rateLimit {");
    });

    it("includes rateLimit in generated batch PR query", () => {
      const query = buildBatchPRQuery("owner", "repo", [{ worktreeId: "wt-1", issueNumber: 42 }]);
      expect(query).toContain("rateLimit {");
      expect(query).toContain("cost");
      expect(query).toContain("remaining");
      expect(query).toContain("resetAt");
    });

    it("includes rateLimit in generated batch required checks query", () => {
      const query = buildBatchRequiredChecksQuery("owner", "repo", [12]);
      expect(query).toContain("rateLimit {");
    });
  });
});

describe("buildBatchBranchPRQuery", () => {
  it("returns empty string for an empty branch list (caller must skip the request)", () => {
    expect(buildBatchBranchPRQuery("owner", "repo", [])).toBe("");
  });

  it("uses index-based aliases (b0, b1, …) so special characters in branch names never appear as identifiers", () => {
    const query = buildBatchBranchPRQuery("owner", "repo", [
      "feature/x",
      'has"quote',
      "with spaces",
    ]);
    expect(query).toContain("b0: repository");
    expect(query).toContain("b1: repository");
    expect(query).toContain("b2: repository");
  });

  it("escapes owner, repo, and branch values in generated GraphQL query", () => {
    const query = buildBatchBranchPRQuery('my"owner', "repo\\name", ['feat"branch']);
    expect(query).toContain('owner: "my\\"owner"');
    expect(query).toContain('name: "repo\\\\name"');
    expect(query).toContain('headRefName: "feat\\"branch"');
  });

  it("queries one PR per branch with first: 1 and all PR states", () => {
    const query = buildBatchBranchPRQuery("owner", "repo", ["main"]);
    expect(query).toContain("first: 1");
    expect(query).toContain("states: [OPEN, MERGED, CLOSED]");
  });

  it("uses inline orderBy literal (avoids the IssueOrder/PullRequestOrder variable trap)", () => {
    // Past lesson #3339: Repository.pullRequests.orderBy expects IssueOrder,
    // not PullRequestOrder. Inlining sidesteps the variable type entirely.
    const query = buildBatchBranchPRQuery("owner", "repo", ["main"]);
    expect(query).toContain("orderBy: {field: UPDATED_AT, direction: DESC}");
    expect(query).not.toContain("PullRequestOrder");
  });

  it("does not declare a $query variable (rejected by @octokit/graphql)", () => {
    // Past lesson #1376: @octokit/graphql reserves `query` for the operation
    // document. The inline builder pattern sidesteps the trap entirely.
    const query = buildBatchBranchPRQuery("owner", "repo", ["main", "dev"]);
    expect(query).not.toContain("$query");
  });

  it("returns the PR fields toForgePR reads (number, title, bodyText, url, state, draft, merged, refs, timestamps, author)", () => {
    const query = buildBatchBranchPRQuery("owner", "repo", ["main"]);
    expect(query).toContain("number");
    expect(query).toContain("title");
    expect(query).toContain("bodyText");
    expect(query).toContain("url");
    expect(query).toContain("state");
    expect(query).toContain("isDraft");
    expect(query).toContain("merged");
    expect(query).toContain("baseRefName");
    expect(query).toContain("headRefName");
    expect(query).toContain("createdAt");
    expect(query).toContain("updatedAt");
    expect(query).toContain("closedAt");
    expect(query).toContain("mergedAt");
    expect(query).toContain("author { login avatarUrl }");
    // toForgePR now reads node.comments.totalCount — the batch shape must carry it.
    expect(query).toContain("comments { totalCount }");
  });

  it("uses bodyText (not body) — parity with SEARCH_QUERY and getPRTooltip", () => {
    const query = buildBatchBranchPRQuery("owner", "repo", ["main"]);
    expect(query).toContain("bodyText");
    // Word-boundary match avoids matching `bodyText`.
    expect(query).not.toMatch(/\bbody\b(?!Text)/);
  });

  it("includes rateLimit at operation root so rate-limit state stays in sync", () => {
    const query = buildBatchBranchPRQuery("owner", "repo", ["main"]);
    expect(query).toContain("rateLimit {");
    expect(query).toContain("cost");
    expect(query).toContain("remaining");
    expect(query).toContain("resetAt");
  });

  it("emits one aliased block per branch in the caller's chunk", () => {
    const branches = Array.from({ length: BATCH_BRANCH_CHUNK_SIZE }, (_, i) => `branch-${i}`);
    const query = buildBatchBranchPRQuery("owner", "repo", branches);
    for (let i = 0; i < branches.length; i++) {
      expect(query).toContain(`b${i}: repository`);
      expect(query).toContain(`headRefName: "branch-${i}"`);
    }
  });

  it("exports BATCH_BRANCH_CHUNK_SIZE as 20 (per-chunk cap)", () => {
    expect(BATCH_BRANCH_CHUNK_SIZE).toBe(20);
  });
});

describe("GRAPHQL_BATCH_CHUNK_SIZE", () => {
  it("equals BATCH_BRANCH_CHUNK_SIZE", () => {
    expect(GRAPHQL_BATCH_CHUNK_SIZE).toBe(BATCH_BRANCH_CHUNK_SIZE);
  });
});

describe("buildBatchIssuesQuery", () => {
  it("returns empty string for empty array", () => {
    expect(buildBatchIssuesQuery("owner", "repo", [])).toBe("");
  });

  it("returns empty string when all numbers are invalid", () => {
    expect(buildBatchIssuesQuery("owner", "repo", [-1, 0, 1.5])).toBe("");
  });

  it("filters out negative, zero, and non-integer numbers", () => {
    const query = buildBatchIssuesQuery("owner", "repo", [-1, 0, 1.5, 5]);
    expect(query).toContain("i5: issue(number: 5)");
    expect(query).not.toContain("i-1");
    expect(query).not.toContain("i0");
    expect(query).not.toContain("i1.5");
  });

  it("uses a single repository block with field-level aliases", () => {
    const query = buildBatchIssuesQuery("owner", "repo", [1, 2, 3]);
    // Exactly one "repository(owner:" block
    const repoMatches = query.match(/repository\(owner:/g);
    expect(repoMatches?.length).toBe(1);
    expect(query).toContain("i1: issue");
    expect(query).toContain("i2: issue");
    expect(query).toContain("i3: issue");
  });

  it("aliases use i{num} prefix", () => {
    const query = buildBatchIssuesQuery("owner", "repo", [42]);
    expect(query).toContain("i42: issue(number: 42)");
  });

  it("includes the full field set from GET_ISSUE_QUERY", () => {
    const query = buildBatchIssuesQuery("owner", "repo", [1]);
    expect(query).toContain("number");
    expect(query).toContain("title");
    expect(query).toContain("bodyText");
    expect(query).toContain("url");
    expect(query).toContain("state");
    expect(query).toContain("createdAt");
    expect(query).toContain("updatedAt");
    expect(query).toContain("closedAt");
    expect(query).toContain("author {");
    expect(query).toContain("assignees(first: 10)");
    expect(query).toContain("comments {");
    expect(query).toContain("labels(first: 10)");
    expect(query).toContain("timelineItems");
    expect(query).toContain("CROSS_REFERENCED_EVENT");
    expect(query).toContain("CONNECTED_EVENT");
  });

  it("includes rateLimit at operation root", () => {
    const query = buildBatchIssuesQuery("owner", "repo", [1]);
    expect(query).toContain("rateLimit {");
    expect(query).toContain("cost");
    expect(query).toContain("remaining");
    expect(query).toContain("resetAt");
  });

  it("escapes owner and repo with special characters", () => {
    const query = buildBatchIssuesQuery('my"owner', "repo\\name", [1]);
    expect(query).toContain('owner: "my\\"owner"');
    expect(query).toContain('name: "repo\\\\name"');
  });

  it("does not declare $query variable", () => {
    const query = buildBatchIssuesQuery("owner", "repo", [1, 2]);
    expect(query).not.toContain("$query");
  });
});

describe("buildBatchPRsQuery", () => {
  it("returns empty string for empty array", () => {
    expect(buildBatchPRsQuery("owner", "repo", [])).toBe("");
  });

  it("returns empty string when all numbers are invalid", () => {
    expect(buildBatchPRsQuery("owner", "repo", [-1, 0, 1.5])).toBe("");
  });

  it("filters out negative, zero, and non-integer numbers", () => {
    const query = buildBatchPRsQuery("owner", "repo", [-1, 0, 1.5, 10]);
    expect(query).toContain("p10: pullRequest(number: 10)");
    expect(query).not.toContain("p-1");
    expect(query).not.toContain("p0");
    expect(query).not.toContain("p1.5");
  });

  it("uses a single repository block with field-level aliases", () => {
    const query = buildBatchPRsQuery("owner", "repo", [10, 11]);
    const repoMatches = query.match(/repository\(owner:/g);
    expect(repoMatches?.length).toBe(1);
    expect(query).toContain("p10: pullRequest");
    expect(query).toContain("p11: pullRequest");
  });

  it("aliases use p{num} prefix", () => {
    const query = buildBatchPRsQuery("owner", "repo", [99]);
    expect(query).toContain("p99: pullRequest(number: 99)");
  });

  it("includes the full field set from GET_PR_QUERY", () => {
    const query = buildBatchPRsQuery("owner", "repo", [1]);
    expect(query).toContain("number");
    expect(query).toContain("title");
    expect(query).toContain("bodyText");
    expect(query).toContain("url");
    expect(query).toContain("state");
    expect(query).toContain("isDraft");
    expect(query).toContain("merged");
    expect(query).toContain("createdAt");
    expect(query).toContain("updatedAt");
    expect(query).toContain("closedAt");
    expect(query).toContain("mergedAt");
    expect(query).toContain("baseRefName");
    expect(query).toContain("headRefName");
    expect(query).toContain("headRepository");
    expect(query).toContain("baseRepository");
    expect(query).toContain("author {");
    expect(query).toContain("assignees(first: 10)");
    expect(query).toContain("comments {");
    expect(query).toContain("labels(first: 10)");
    expect(query).toContain("commits(last: 1)");
    expect(query).toContain("statusCheckRollup");
  });

  it("does not include unused review-count fields", () => {
    const query = buildBatchPRsQuery("owner", "repo", [1]);
    expect(query).not.toContain("reviews(first: 1)");
  });

  it("includes rateLimit at operation root", () => {
    const query = buildBatchPRsQuery("owner", "repo", [1]);
    expect(query).toContain("rateLimit {");
    expect(query).toContain("cost");
    expect(query).toContain("remaining");
    expect(query).toContain("resetAt");
  });

  it("escapes owner and repo with special characters", () => {
    const query = buildBatchPRsQuery('my"owner', "repo\\name", [1]);
    expect(query).toContain('owner: "my\\"owner"');
    expect(query).toContain('name: "repo\\\\name"');
  });

  it("does not declare $query variable", () => {
    const query = buildBatchPRsQuery("owner", "repo", [1, 2]);
    expect(query).not.toContain("$query");
  });
});
