import { beforeEach, describe, expect, it } from "vitest";
import {
  prETagCache,
  branchListETagCache,
  repoPRListETagCache,
  getETagCacheVersion,
  clearGitHubCaches,
  clearPRCaches,
  velocityCache,
  repoEventsETagCache,
  repoEventsNoChangeCount,
  repoEventsLastProbeAt,
  repoStatsAndPageSnapshotCache,
  forgeIssueListCache,
  forgePRListCache,
  prRequiredStatusCache,
  issueListCache,
  prListCache,
  getRepoListEpoch,
  invalidateRepoListCachesForCountChange,
  invalidateRepoIssueCachesForAssignment,
  issueTooltipCache,
  MAX_REVIEW_THREAD_PAGES,
  REVIEW_THREADS_PER_PAGE,
} from "../GitHubCaches.js";
import { buildListCacheKey } from "../GitHubPRs.js";
import type { Issue, PR, Page } from "../../../../../shared/types/forge.js";
import type { GitHubIssue, GitHubPR, GitHubListResponse } from "../../shared/types.js";

describe("GitHubCaches ETag caches", () => {
  beforeEach(() => {
    prETagCache.clear();
    branchListETagCache.clear();
    repoPRListETagCache.clear();
  });

  it("are Cache instances, not plain Maps", () => {
    expect(prETagCache.get).toBeInstanceOf(Function);
    expect(prETagCache.set).toBeInstanceOf(Function);
    expect(prETagCache.invalidate).toBeInstanceOf(Function);
    expect(typeof (prETagCache as unknown as { delete?: unknown }).delete).toBe("undefined");

    expect(branchListETagCache.get).toBeInstanceOf(Function);
    expect(branchListETagCache.set).toBeInstanceOf(Function);
    expect(branchListETagCache.invalidate).toBeInstanceOf(Function);

    expect(repoPRListETagCache.get).toBeInstanceOf(Function);
    expect(repoPRListETagCache.set).toBeInstanceOf(Function);
    expect(repoPRListETagCache.invalidate).toBeInstanceOf(Function);
  });

  it("set and get work for all caches", () => {
    prETagCache.set("owner/repo#42", '"abc123"');
    expect(prETagCache.get("owner/repo#42")).toBe('"abc123"');

    branchListETagCache.set("owner/repo@main", '"def456"');
    expect(branchListETagCache.get("owner/repo@main")).toBe('"def456"');

    repoPRListETagCache.set("owner/repo", 'W/"ghi789"');
    expect(repoPRListETagCache.get("owner/repo")).toBe('W/"ghi789"');
  });

  it("invalidate removes entries", () => {
    prETagCache.set("owner/repo#42", '"abc123"');
    prETagCache.invalidate("owner/repo#42");
    expect(prETagCache.get("owner/repo#42")).toBeUndefined();
  });

  it("TTL expires entries", async () => {
    const tinyCache = new (Object.getPrototypeOf(prETagCache).constructor)({
      maxSize: 10,
      defaultTTL: 10,
    }) as typeof prETagCache;
    tinyCache.set("k", "v");
    expect(tinyCache.get("k")).toBe("v");
    await new Promise((r) => setTimeout(r, 20));
    expect(tinyCache.get("k")).toBeUndefined();
  });
});

describe("clearGitHubCaches / clearPRCaches symmetry", () => {
  beforeEach(() => {
    prETagCache.clear();
    branchListETagCache.clear();
    repoPRListETagCache.clear();
  });

  it("clearGitHubCaches clears all ETag caches", () => {
    prETagCache.set("k1", '"v1"');
    branchListETagCache.set("k2", '"v2"');
    repoPRListETagCache.set("k3", 'W/"v3"');
    clearGitHubCaches();
    expect(prETagCache.get("k1")).toBeUndefined();
    expect(branchListETagCache.get("k2")).toBeUndefined();
    expect(repoPRListETagCache.get("k3")).toBeUndefined();
  });

  it("clearPRCaches clears all ETag caches (previously skipped them)", () => {
    prETagCache.set("k1", '"v1"');
    branchListETagCache.set("k2", '"v2"');
    repoPRListETagCache.set("k3", 'W/"v3"');
    clearPRCaches();
    expect(prETagCache.get("k1")).toBeUndefined();
    expect(branchListETagCache.get("k2")).toBeUndefined();
    expect(repoPRListETagCache.get("k3")).toBeUndefined();
  });

  it("clearPRCaches increments ETag cache version", () => {
    const before = getETagCacheVersion();
    clearPRCaches();
    expect(getETagCacheVersion()).toBeGreaterThan(before);
  });

  it("clearGitHubCaches increments ETag cache version", () => {
    const before = getETagCacheVersion();
    clearGitHubCaches();
    expect(getETagCacheVersion()).toBeGreaterThan(before);
  });

  // The PR list and the required-status cache jointly back one rendered CI
  // status: `listPRsImpl` enriches its rows from `prRequiredStatusCache`
  // before caching the page (#11251). Clearing one without the other would
  // leave a refreshed list re-enriched from stale required-check entries, or a
  // cleared status cache shadowed by an already-enriched page — the two-caches-
  // out-of-step failure mode from #9061.
  for (const [name, clear] of [
    ["clearGitHubCaches", clearGitHubCaches],
    ["clearPRCaches", clearPRCaches],
  ] as const) {
    it(`${name} clears the PR list and required-status caches together`, () => {
      // Key shape must match buildListCacheKey's
      // `${type}:${owner}/${repo}:${state}:${search}:${sortOrder}:${cursor}` —
      // a malformed key would still pass under a global clear but would give a
      // false green if clearing ever became prefix-scoped.
      const listKey = buildListCacheKey("pr", "owner", "repo", "open", "", "created", "");
      forgePRListCache.set(listKey, {
        items: [],
        nextCursor: null,
        hasMore: false,
      } as Page<PR>);
      prRequiredStatusCache.set("owner/repo:1", { ciStatus: "SUCCESS", ciSummary: undefined });

      clear();

      expect(forgePRListCache.get(listKey)).toBeUndefined();
      expect(prRequiredStatusCache.get("owner/repo:1")).toBeUndefined();
    });
  }
});

describe("polling-optimization caches (issues #8757, #9041)", () => {
  beforeEach(() => {
    velocityCache.clear();
    repoEventsETagCache.clear();
    repoEventsNoChangeCount.clear();
    repoEventsLastProbeAt.clear();
    repoStatsAndPageSnapshotCache.clear();
  });

  function seedAll(): void {
    velocityCache.set("owner/repo::velocity::2026-05-20", { 60: 1, 120: 2, 180: 3 });
    repoEventsETagCache.set("owner/repo", '"events-etag"');
    repoEventsNoChangeCount.set("owner/repo", 3);
    repoEventsLastProbeAt.set("owner/repo", Date.now());
    repoStatsAndPageSnapshotCache.set("owner/repo", {
      stats: { issueCount: 4, prCount: 5, lastUpdated: 1 },
      issues: { items: [], endCursor: null, hasNextPage: false, totalCount: 4 },
      prs: { items: [], endCursor: null, hasNextPage: false, totalCount: 5 },
    });
  }

  it("clearGitHubCaches clears the velocity, events-ETag, and snapshot caches", () => {
    seedAll();
    clearGitHubCaches();
    expect(velocityCache.get("owner/repo::velocity::2026-05-20")).toBeUndefined();
    expect(repoEventsETagCache.get("owner/repo")).toBeUndefined();
    expect(repoEventsNoChangeCount.get("owner/repo")).toBeUndefined();
    expect(repoEventsLastProbeAt.get("owner/repo")).toBeUndefined();
    expect(repoStatsAndPageSnapshotCache.get("owner/repo")).toBeUndefined();
  });

  it("clearPRCaches drops the events ETag + snapshot and resets the backoff state", () => {
    seedAll();
    clearPRCaches();
    expect(repoEventsETagCache.get("owner/repo")).toBeUndefined();
    expect(repoEventsNoChangeCount.get("owner/repo")).toBeUndefined();
    expect(repoEventsLastProbeAt.get("owner/repo")).toBeUndefined();
    expect(repoStatsAndPageSnapshotCache.get("owner/repo")).toBeUndefined();
  });

  it("clearPRCaches keeps the velocity cache — it is repo metadata, not PR-list state", () => {
    seedAll();
    clearPRCaches();
    expect(velocityCache.get("owner/repo::velocity::2026-05-20")).toEqual({
      60: 1,
      120: 2,
      180: 3,
    });
  });
});

describe("invalidateRepoListCachesForCountChange (count-as-cache-buster)", () => {
  const forgePage = { items: [], nextCursor: null, hasMore: false } as Page<Issue> & Page<PR>;
  const legacyPage = {
    items: [],
    pageInfo: { hasNextPage: false, endCursor: null },
  } as GitHubListResponse<GitHubIssue> & GitHubListResponse<GitHubPR>;

  beforeEach(() => {
    forgeIssueListCache.clear();
    forgePRListCache.clear();
    issueListCache.clear();
    prListCache.clear();
    repoStatsAndPageSnapshotCache.clear();
  });

  function seedLists(): void {
    // Every state/sort/cursor variant for the target repo, in both the forge
    // and legacy cache families, plus a second repo that must survive.
    forgeIssueListCache.set("issue:owner/repo:open::created:", forgePage);
    forgeIssueListCache.set("issue:owner/repo:closed::updated:cursor123", forgePage);
    issueListCache.set("issue:owner/repo:open::created:", legacyPage);
    issueListCache.set("issue:owner/repo:all:search-term:created:", legacyPage);
    forgeIssueListCache.set("issue:other/repo:open::created:", forgePage);
    issueListCache.set("issue:other/repo:open::created:", legacyPage);

    forgePRListCache.set("pr:owner/repo:open::created:", forgePage);
    forgePRListCache.set("pr:owner/repo:merged::updated:", forgePage);
    prListCache.set("pr:owner/repo:open::created:", legacyPage);
    forgePRListCache.set("pr:other/repo:open::created:", forgePage);

    repoStatsAndPageSnapshotCache.set("owner/repo", {
      stats: { issueCount: 4, prCount: 5, lastUpdated: 1 },
      issues: { items: [], endCursor: null, hasNextPage: false, totalCount: 4 },
      prs: { items: [], endCursor: null, hasNextPage: false, totalCount: 5 },
    });
    repoStatsAndPageSnapshotCache.set("other/repo", {
      stats: { issueCount: 1, prCount: 1, lastUpdated: 1 },
      issues: { items: [], endCursor: null, hasNextPage: false, totalCount: 1 },
      prs: { items: [], endCursor: null, hasNextPage: false, totalCount: 1 },
    });
  }

  it("an issue-count change drops every issue variant for the repo but no PR pages", () => {
    seedLists();
    invalidateRepoListCachesForCountChange("owner", "repo", { issues: true, prs: false });

    expect(forgeIssueListCache.get("issue:owner/repo:open::created:")).toBeUndefined();
    expect(forgeIssueListCache.get("issue:owner/repo:closed::updated:cursor123")).toBeUndefined();
    expect(issueListCache.get("issue:owner/repo:open::created:")).toBeUndefined();
    expect(issueListCache.get("issue:owner/repo:all:search-term:created:")).toBeUndefined();

    expect(forgePRListCache.get("pr:owner/repo:open::created:")).toBe(forgePage);
    expect(forgePRListCache.get("pr:owner/repo:merged::updated:")).toBe(forgePage);
    expect(prListCache.get("pr:owner/repo:open::created:")).toBe(legacyPage);
  });

  it("a PR-count change drops every PR variant but no issue pages", () => {
    seedLists();
    invalidateRepoListCachesForCountChange("owner", "repo", { issues: false, prs: true });

    expect(forgePRListCache.get("pr:owner/repo:open::created:")).toBeUndefined();
    expect(forgePRListCache.get("pr:owner/repo:merged::updated:")).toBeUndefined();
    expect(prListCache.get("pr:owner/repo:open::created:")).toBeUndefined();

    expect(forgeIssueListCache.get("issue:owner/repo:open::created:")).toBe(forgePage);
    expect(issueListCache.get("issue:owner/repo:open::created:")).toBe(legacyPage);
  });

  it("other repos' entries always survive", () => {
    seedLists();
    invalidateRepoListCachesForCountChange("owner", "repo", { issues: true, prs: true });

    expect(forgeIssueListCache.get("issue:other/repo:open::created:")).toBe(forgePage);
    expect(issueListCache.get("issue:other/repo:open::created:")).toBe(legacyPage);
    expect(forgePRListCache.get("pr:other/repo:open::created:")).toBe(forgePage);
    expect(repoStatsAndPageSnapshotCache.get("other/repo")).toBeDefined();
  });

  it("drops the combined stats-and-page snapshot on any delta — it embeds both first pages", () => {
    seedLists();
    invalidateRepoListCachesForCountChange("owner", "repo", { issues: true, prs: false });
    expect(repoStatsAndPageSnapshotCache.get("owner/repo")).toBeUndefined();
  });

  it("is a no-op when nothing changed", () => {
    seedLists();
    const issueEpoch = getRepoListEpoch("issue", "owner", "repo");
    const prEpoch = getRepoListEpoch("pr", "owner", "repo");

    invalidateRepoListCachesForCountChange("owner", "repo", { issues: false, prs: false });

    expect(forgeIssueListCache.get("issue:owner/repo:open::created:")).toBe(forgePage);
    expect(forgePRListCache.get("pr:owner/repo:open::created:")).toBe(forgePage);
    expect(repoStatsAndPageSnapshotCache.get("owner/repo")).toBeDefined();
    expect(getRepoListEpoch("issue", "owner", "repo")).toBe(issueEpoch);
    expect(getRepoListEpoch("pr", "owner", "repo")).toBe(prEpoch);
  });

  it("bumps only the changed type's epoch so in-flight writes of the other type stay valid", () => {
    const issueBefore = getRepoListEpoch("issue", "owner", "repo");
    const prBefore = getRepoListEpoch("pr", "owner", "repo");

    invalidateRepoListCachesForCountChange("owner", "repo", { issues: true, prs: false });

    expect(getRepoListEpoch("issue", "owner", "repo")).toBe(issueBefore + 1);
    expect(getRepoListEpoch("pr", "owner", "repo")).toBe(prBefore);
  });

  it("epochs are scoped per repo", () => {
    const before = getRepoListEpoch("issue", "unrelated", "repo");
    invalidateRepoListCachesForCountChange("owner", "repo", { issues: true, prs: true });
    expect(getRepoListEpoch("issue", "unrelated", "repo")).toBe(before);
  });

  describe("invalidateRepoIssueCachesForAssignment (#11087)", () => {
    // An assignment changes an issue's assignees without moving the open count,
    // so the count fingerprint can't detect it and every cached issue page for
    // the repo now carries a stale assignee list.
    it("drops every cached issue variant for the repo so no read can serve the pre-assignment page", () => {
      seedLists();

      invalidateRepoIssueCachesForAssignment("owner", "repo", 42);

      expect(forgeIssueListCache.get("issue:owner/repo:open::created:")).toBeUndefined();
      expect(forgeIssueListCache.get("issue:owner/repo:closed::updated:cursor123")).toBeUndefined();
      expect(issueListCache.get("issue:owner/repo:open::created:")).toBeUndefined();
      expect(issueListCache.get("issue:owner/repo:all:search-term:created:")).toBeUndefined();
    });

    it("drops the stats-and-page snapshot so the next poll cannot broadcast stale rows over the renderer's patch", () => {
      seedLists();

      invalidateRepoIssueCachesForAssignment("owner", "repo", 42);

      expect(repoStatsAndPageSnapshotCache.get("owner/repo")).toBeUndefined();
    });

    it("bumps the issue epoch so a list query already in flight cannot write its pre-assignment page back", () => {
      const issueBefore = getRepoListEpoch("issue", "owner", "repo");

      invalidateRepoIssueCachesForAssignment("owner", "repo", 42);

      expect(getRepoListEpoch("issue", "owner", "repo")).toBe(issueBefore + 1);
    });

    it("leaves PR pages and their epoch alone — an assignment says nothing about PRs", () => {
      seedLists();
      const prBefore = getRepoListEpoch("pr", "owner", "repo");

      invalidateRepoIssueCachesForAssignment("owner", "repo", 42);

      expect(forgePRListCache.get("pr:owner/repo:open::created:")).toBe(forgePage);
      expect(prListCache.get("pr:owner/repo:open::created:")).toBe(legacyPage);
      expect(getRepoListEpoch("pr", "owner", "repo")).toBe(prBefore);
    });

    it("leaves other repos untouched", () => {
      seedLists();

      invalidateRepoIssueCachesForAssignment("owner", "repo", 42);

      expect(forgeIssueListCache.get("issue:other/repo:open::created:")).toBe(forgePage);
      expect(issueListCache.get("issue:other/repo:open::created:")).toBe(legacyPage);
      expect(repoStatsAndPageSnapshotCache.get("other/repo")).toBeDefined();
    });

    it("drops the mutated issue's tooltip — it renders assignees too — but not a sibling's", () => {
      issueTooltipCache.clear();
      const tooltip = {
        number: 42,
        title: "t",
        body: "",
        state: "open",
        url: "u",
        assignees: [],
        labels: [],
      } as unknown as Parameters<typeof issueTooltipCache.set>[1];
      issueTooltipCache.set("owner/repo:42", tooltip);
      issueTooltipCache.set("owner/repo:99", tooltip);

      invalidateRepoIssueCachesForAssignment("owner", "repo", 42);

      expect(issueTooltipCache.get("owner/repo:42")).toBeUndefined();
      expect(issueTooltipCache.get("owner/repo:99")).toBe(tooltip);
    });
  });
});

describe("review thread pagination constants", () => {
  it("MAX_REVIEW_THREAD_PAGES is 5", () => {
    expect(MAX_REVIEW_THREAD_PAGES).toBe(5);
  });

  it("REVIEW_THREADS_PER_PAGE is 100", () => {
    expect(REVIEW_THREADS_PER_PAGE).toBe(100);
  });
});
