import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  getWorktreeType,
  buildSearchableText,
  scoreWorktree,
  computeStatus,
  matchesFilters,
  matchesQuickStateFilter,
  sortWorktrees,
  sortWorktreesByRelevance,
  groupByType,
  hasAnyFilters,
  findIntegrationWorktree,
  filterTriageWorktrees,
  type DerivedWorktreeMeta,
  type FilterState,
} from "../worktreeFilters";
import type { Worktree } from "@shared/types/worktree";

const createMockWorktree = (overrides: Partial<Worktree> = {}): Worktree => ({
  id: "test-id",
  path: "/home/user/project",
  name: "main",
  branch: "main",
  isCurrent: false,
  isMainWorktree: false,
  ...overrides,
});

const createEmptyFilters = (): FilterState => ({
  query: "",
  statusFilters: new Set(),
  typeFilters: new Set(),
  githubFilters: new Set(),
  sessionFilters: new Set(),
  activityFilters: new Set(),
});

const createEmptyMeta = (): DerivedWorktreeMeta => ({
  terminalCount: 0,
  hasWorkingAgent: false,
  hasRunningAgent: false,
  hasWaitingAgent: false,
  hasCompletedAgent: false,
  hasExitedAgent: false,
  hasMergeConflict: false,
  chipState: null,
});

describe("getWorktreeType", () => {
  it("returns 'main' for main worktree", () => {
    const worktree = createMockWorktree({ isMainWorktree: true, branch: "main" });
    expect(getWorktreeType(worktree)).toBe("main");
  });

  it("returns 'detached' for detached HEAD", () => {
    const worktree = createMockWorktree({ isDetached: true, branch: undefined });
    expect(getWorktreeType(worktree)).toBe("detached");
  });

  it("returns 'feature' for feature branches", () => {
    const worktree = createMockWorktree({ branch: "feature/add-login" });
    expect(getWorktreeType(worktree)).toBe("feature");
  });

  it("returns 'feature' for feat alias", () => {
    const worktree = createMockWorktree({ branch: "feat/new-feature" });
    expect(getWorktreeType(worktree)).toBe("feature");
  });

  it("returns 'bugfix' for bugfix branches", () => {
    const worktree = createMockWorktree({ branch: "bugfix/fix-issue-123" });
    expect(getWorktreeType(worktree)).toBe("bugfix");
  });

  it("returns 'bugfix' for fix alias", () => {
    const worktree = createMockWorktree({ branch: "fix/quick-patch" });
    expect(getWorktreeType(worktree)).toBe("bugfix");
  });

  it("returns 'bugfix' for hotfix alias", () => {
    const worktree = createMockWorktree({ branch: "hotfix/critical-bug" });
    expect(getWorktreeType(worktree)).toBe("bugfix");
  });

  it("returns 'refactor' for refactor branches", () => {
    const worktree = createMockWorktree({ branch: "refactor/cleanup-code" });
    expect(getWorktreeType(worktree)).toBe("refactor");
  });

  it("returns 'chore' for chore branches", () => {
    const worktree = createMockWorktree({ branch: "chore/update-deps" });
    expect(getWorktreeType(worktree)).toBe("chore");
  });

  it("returns 'docs' for docs branches", () => {
    const worktree = createMockWorktree({ branch: "docs/update-readme" });
    expect(getWorktreeType(worktree)).toBe("docs");
  });

  it("returns 'test' for test branches", () => {
    const worktree = createMockWorktree({ branch: "test/add-unit-tests" });
    expect(getWorktreeType(worktree)).toBe("test");
  });

  it("returns 'release' for release branches", () => {
    const worktree = createMockWorktree({ branch: "release/v1.0.0" });
    expect(getWorktreeType(worktree)).toBe("release");
  });

  it("returns 'ci' for ci branches", () => {
    const worktree = createMockWorktree({ branch: "ci/update-pipeline" });
    expect(getWorktreeType(worktree)).toBe("ci");
  });

  it("returns 'deps' for deps branches", () => {
    const worktree = createMockWorktree({ branch: "deps/bump-version" });
    expect(getWorktreeType(worktree)).toBe("deps");
  });

  it("returns 'perf' for perf branches", () => {
    const worktree = createMockWorktree({ branch: "perf/optimize-render" });
    expect(getWorktreeType(worktree)).toBe("perf");
  });

  it("returns 'style' for style branches", () => {
    const worktree = createMockWorktree({ branch: "style/format-code" });
    expect(getWorktreeType(worktree)).toBe("style");
  });

  it("returns 'wip' for wip branches", () => {
    const worktree = createMockWorktree({ branch: "wip/experiment" });
    expect(getWorktreeType(worktree)).toBe("wip");
  });

  it("returns 'other' for unknown prefixes", () => {
    const worktree = createMockWorktree({ branch: "my-custom-branch" });
    expect(getWorktreeType(worktree)).toBe("other");
  });

  it("handles case-insensitive matching", () => {
    const worktree = createMockWorktree({ branch: "FEATURE/uppercase" });
    expect(getWorktreeType(worktree)).toBe("feature");
  });
});

describe("buildSearchableText", () => {
  it("includes name", () => {
    const worktree = createMockWorktree({ name: "test-name" });
    expect(buildSearchableText(worktree)).toContain("test-name");
  });

  it("includes branch", () => {
    const worktree = createMockWorktree({ branch: "feature/my-branch" });
    expect(buildSearchableText(worktree)).toContain("feature/my-branch");
  });

  it("does not include path", () => {
    const worktree = createMockWorktree({ path: "/home/user/my-project" });
    expect(buildSearchableText(worktree)).not.toContain("/home/user/my-project");
  });

  it("includes issue number with hash", () => {
    const worktree = createMockWorktree({ issueNumber: 123 });
    expect(buildSearchableText(worktree)).toContain("#123");
  });

  it("includes PR number with hash", () => {
    const worktree = createMockWorktree({ prNumber: 456 });
    expect(buildSearchableText(worktree)).toContain("#456");
  });

  it("does not include summary", () => {
    const worktree = createMockWorktree({ summary: "Working on feature X" });
    expect(buildSearchableText(worktree)).not.toContain("working on feature x");
  });

  it("includes issue title", () => {
    const worktree = createMockWorktree({ issueTitle: "Add dark mode toggle" });
    expect(buildSearchableText(worktree)).toContain("add dark mode toggle");
  });

  it("includes PR title", () => {
    const worktree = createMockWorktree({ prTitle: "Fix authentication bug" });
    expect(buildSearchableText(worktree)).toContain("fix authentication bug");
  });

  it("does not include aiNote", () => {
    const worktree = createMockWorktree({ aiNote: "Agent is implementing tests" });
    expect(buildSearchableText(worktree)).not.toContain("agent is implementing tests");
  });

  it("returns lowercase text", () => {
    const worktree = createMockWorktree({ name: "MyWorktree", branch: "Feature/Test" });
    const text = buildSearchableText(worktree);
    expect(text).toBe(text.toLowerCase());
  });
});

describe("scoreWorktree", () => {
  it("returns 0 for empty query", () => {
    const worktree = createMockWorktree({ name: "test" });
    expect(scoreWorktree(worktree, "")).toBe(0);
  });

  it("returns 0 when no field matches", () => {
    const worktree = createMockWorktree({ name: "main", branch: "main" });
    expect(scoreWorktree(worktree, "nonexistent")).toBe(0);
  });

  it("returns 4 when issueTitle starts with query", () => {
    const worktree = createMockWorktree({ issueTitle: "Authentication refactor" });
    expect(scoreWorktree(worktree, "auth")).toBe(4);
  });

  it("returns 3 when issueTitle contains but does not start with query", () => {
    const worktree = createMockWorktree({ issueTitle: "Fix authentication bug" });
    expect(scoreWorktree(worktree, "auth")).toBe(3);
  });

  it("returns 4 when name starts with query", () => {
    const worktree = createMockWorktree({ name: "auth-feature", issueTitle: undefined });
    expect(scoreWorktree(worktree, "auth")).toBe(4);
  });

  it("returns 3 when name contains but does not start with query", () => {
    const worktree = createMockWorktree({ name: "fix-auth", issueTitle: undefined });
    expect(scoreWorktree(worktree, "auth")).toBe(3);
  });

  it("returns 2 when branch starts with query", () => {
    const worktree = createMockWorktree({
      name: "main",
      branch: "auth-feature",
      issueTitle: undefined,
    });
    expect(scoreWorktree(worktree, "auth")).toBe(2);
  });

  it("returns 1 when branch contains but does not start with query", () => {
    const worktree = createMockWorktree({
      name: "main",
      branch: "feature/auth-fix",
      issueTitle: undefined,
    });
    expect(scoreWorktree(worktree, "auth")).toBe(1);
  });

  it("returns 2 when prTitle starts with query", () => {
    const worktree = createMockWorktree({
      name: "main",
      branch: "main",
      issueTitle: undefined,
      prTitle: "Auth fix for login",
    });
    expect(scoreWorktree(worktree, "auth")).toBe(2);
  });

  it("returns 1 when only prTitle contains query", () => {
    const worktree = createMockWorktree({
      name: "main",
      branch: "main",
      issueTitle: undefined,
      prTitle: "Fix authentication",
    });
    expect(scoreWorktree(worktree, "auth")).toBe(1);
  });

  it("takes max score across all matching fields", () => {
    const worktree = createMockWorktree({
      name: "auth-settings",
      branch: "feature/auth-fix",
      issueTitle: "Fix database auth",
    });
    // name.startsWith = 4, issueTitle.includes = 3, branch.includes = 1 → max = 4
    expect(scoreWorktree(worktree, "auth")).toBe(4);
  });

  it("is case-insensitive", () => {
    const worktree = createMockWorktree({ issueTitle: "Authentication Refactor" });
    expect(scoreWorktree(worktree, "AUTH")).toBe(4);
  });

  it("handles null fields safely", () => {
    const worktree = createMockWorktree({
      name: "test",
      branch: undefined,
      issueTitle: undefined,
      prTitle: undefined,
    });
    expect(scoreWorktree(worktree, "test")).toBe(4);
  });

  it("does not match path", () => {
    const worktree = createMockWorktree({
      name: "main",
      branch: "main",
      path: "/home/user/auth-project",
    });
    expect(scoreWorktree(worktree, "auth")).toBe(0);
  });

  it("does not match summary", () => {
    const worktree = createMockWorktree({
      name: "main",
      branch: "main",
      summary: "Working on authentication",
    });
    expect(scoreWorktree(worktree, "auth")).toBe(0);
  });

  it("does not match aiNote", () => {
    const worktree = createMockWorktree({
      name: "main",
      branch: "main",
      aiNote: "Agent fixing auth",
    });
    expect(scoreWorktree(worktree, "auth")).toBe(0);
  });

  it("issueTitle starts-with ranks above issueTitle contains", () => {
    const startsWith = createMockWorktree({ issueTitle: "Authentication refactor" });
    const contains = createMockWorktree({ issueTitle: "Fix authentication bug" });
    expect(scoreWorktree(startsWith, "auth")).toBeGreaterThan(scoreWorktree(contains, "auth"));
  });
});

describe("sortWorktreesByRelevance", () => {
  it("returns sortWorktrees order when query is empty", () => {
    const worktrees = [
      createMockWorktree({ id: "1", name: "b" }),
      createMockWorktree({ id: "2", name: "a" }),
    ];
    const result = sortWorktreesByRelevance(worktrees, "", "alpha");
    expect(result.map((w) => w.id)).toEqual(["2", "1"]);
  });

  it("sorts by relevance score overriding alpha order", () => {
    const worktrees = [
      createMockWorktree({
        id: "1",
        name: "aaa-worktree",
        branch: "feature/auth-fix",
        issueTitle: "Fix database auth",
      }),
      createMockWorktree({
        id: "2",
        name: "zzz-worktree",
        branch: "main",
        issueTitle: "Authentication refactor",
      }),
    ];
    // Alpha sort would put id:1 (aaa) first, but relevance puts id:2 first (score 4 vs 3)
    const result = sortWorktreesByRelevance(worktrees, "auth", "alpha");
    expect(result[0].id).toBe("2"); // issueTitle starts-with (score 4)
    expect(result[1].id).toBe("1"); // issueTitle contains (score 3)
  });

  it("preserves sortWorktrees order as tiebreaker for equal scores", () => {
    const worktrees = [
      createMockWorktree({ id: "1", name: "z-auth", issueTitle: "auth feature z" }),
      createMockWorktree({ id: "2", name: "a-auth", issueTitle: "auth feature a" }),
    ];
    const result = sortWorktreesByRelevance(worktrees, "auth", "alpha");
    // Both score 4 (issueTitle starts-with), so alpha order preserved
    expect(result[0].id).toBe("2");
    expect(result[1].id).toBe("1");
  });

  it("places score-0 bypass items after scored items", () => {
    const worktrees = [
      createMockWorktree({ id: "1", name: "unrelated", branch: "main" }),
      createMockWorktree({ id: "2", name: "auth-fix", issueTitle: "Auth fix" }),
    ];
    const result = sortWorktreesByRelevance(worktrees, "auth", "alpha");
    expect(result[0].id).toBe("2");
    expect(result[1].id).toBe("1");
  });

  it("keeps main worktree first as tiebreaker when scores are equal", () => {
    const worktrees = [
      createMockWorktree({ id: "1", name: "auth-test", isMainWorktree: true }),
      createMockWorktree({ id: "2", name: "auth-feature" }),
    ];
    const result = sortWorktreesByRelevance(worktrees, "auth", "alpha");
    // Both score 4 (name starts-with), main first via sortWorktrees tiebreaker
    expect(result[0].id).toBe("1");
    expect(result[1].id).toBe("2");
  });
});

describe("computeStatus", () => {
  it("includes 'active' when worktree is active", () => {
    const worktree = createMockWorktree();
    const statuses = computeStatus(worktree, true);
    expect(statuses).toContain("active");
  });

  it("includes 'dirty' when there are changed files", () => {
    const worktree = createMockWorktree({
      worktreeChanges: {
        worktreeId: "test",
        rootPath: "/test",
        changes: [],
        changedFileCount: 5,
      },
    });
    const statuses = computeStatus(worktree, false);
    expect(statuses).toContain("dirty");
  });

  it("includes 'stale' when mood is stale", () => {
    const worktree = createMockWorktree({ mood: "stale" });
    const statuses = computeStatus(worktree, false);
    expect(statuses).toContain("stale");
  });

  it("includes 'idle' when no other status", () => {
    const worktree = createMockWorktree();
    const statuses = computeStatus(worktree, false);
    expect(statuses).toContain("idle");
  });

  it("includes 'idle' when only active", () => {
    const worktree = createMockWorktree();
    const statuses = computeStatus(worktree, true);
    expect(statuses).toContain("idle");
  });
});

describe("matchesFilters", () => {
  it("matches when no filters are set", () => {
    const worktree = createMockWorktree();
    const filters = createEmptyFilters();
    const meta = createEmptyMeta();
    expect(matchesFilters(worktree, filters, meta, false)).toBe(true);
  });

  it("matches query in name", () => {
    const worktree = createMockWorktree({ name: "my-feature-branch" });
    const filters = createEmptyFilters();
    filters.query = "feature";
    const meta = createEmptyMeta();
    expect(matchesFilters(worktree, filters, meta, false)).toBe(true);
  });

  it("does not match when query is not found", () => {
    const worktree = createMockWorktree({ name: "main" });
    const filters = createEmptyFilters();
    filters.query = "nonexistent";
    const meta = createEmptyMeta();
    expect(matchesFilters(worktree, filters, meta, false)).toBe(false);
  });

  it("matches #number shortcut by issueNumber", () => {
    const worktree = createMockWorktree({ issueNumber: 123 });
    const filters = createEmptyFilters();
    filters.query = "#123";
    const meta = createEmptyMeta();
    expect(matchesFilters(worktree, filters, meta, false)).toBe(true);
  });

  it("matches #number shortcut by prNumber", () => {
    const worktree = createMockWorktree({ prNumber: 456 });
    const filters = createEmptyFilters();
    filters.query = "#456";
    const meta = createEmptyMeta();
    expect(matchesFilters(worktree, filters, meta, false)).toBe(true);
  });

  it("matches bare number by issueNumber", () => {
    const worktree = createMockWorktree({ issueNumber: 123 });
    const filters = createEmptyFilters();
    filters.query = "123";
    const meta = createEmptyMeta();
    expect(matchesFilters(worktree, filters, meta, false)).toBe(true);
  });

  it("matches bare number by prNumber", () => {
    const worktree = createMockWorktree({ prNumber: 456 });
    const filters = createEmptyFilters();
    filters.query = "456";
    const meta = createEmptyMeta();
    expect(matchesFilters(worktree, filters, meta, false)).toBe(true);
  });

  it("does not match bare number via text fallback when no issue/PR matches", () => {
    const worktree = createMockWorktree({
      branch: "feature/issue-123-fix",
      issueNumber: undefined,
      prNumber: undefined,
    });
    const filters = createEmptyFilters();
    filters.query = "123";
    const meta = createEmptyMeta();
    expect(matchesFilters(worktree, filters, meta, false)).toBe(false);
  });

  it("matches bare number with whitespace padding", () => {
    const worktree = createMockWorktree({ issueNumber: 123 });
    const filters = createEmptyFilters();
    filters.query = " 123 ";
    const meta = createEmptyMeta();
    expect(matchesFilters(worktree, filters, meta, false)).toBe(true);
  });

  it("does not match #number when neither issueNumber nor prNumber match", () => {
    const worktree = createMockWorktree({ issueNumber: 100, prNumber: 200 });
    const filters = createEmptyFilters();
    filters.query = "#999";
    const meta = createEmptyMeta();
    expect(matchesFilters(worktree, filters, meta, false)).toBe(false);
  });

  it("does not match query that only appears in path", () => {
    const worktree = createMockWorktree({
      name: "main",
      branch: "main",
      path: "/home/user/auth-project",
    });
    const filters = createEmptyFilters();
    filters.query = "auth";
    const meta = createEmptyMeta();
    expect(matchesFilters(worktree, filters, meta, false)).toBe(false);
  });

  it("matches status filter", () => {
    const worktree = createMockWorktree({
      worktreeChanges: {
        worktreeId: "test",
        rootPath: "/test",
        changes: [],
        changedFileCount: 3,
      },
    });
    const filters = createEmptyFilters();
    filters.statusFilters.add("dirty");
    const meta = createEmptyMeta();
    expect(matchesFilters(worktree, filters, meta, false)).toBe(true);
  });

  it("matches type filter", () => {
    const worktree = createMockWorktree({ branch: "feature/test" });
    const filters = createEmptyFilters();
    filters.typeFilters.add("feature");
    const meta = createEmptyMeta();
    expect(matchesFilters(worktree, filters, meta, false)).toBe(true);
  });

  it("matches hasIssue filter", () => {
    const worktree = createMockWorktree({ issueNumber: 123 });
    const filters = createEmptyFilters();
    filters.githubFilters.add("hasIssue");
    const meta = createEmptyMeta();
    expect(matchesFilters(worktree, filters, meta, false)).toBe(true);
  });

  it("matches hasPR filter", () => {
    const worktree = createMockWorktree({ prNumber: 456 });
    const filters = createEmptyFilters();
    filters.githubFilters.add("hasPR");
    const meta = createEmptyMeta();
    expect(matchesFilters(worktree, filters, meta, false)).toBe(true);
  });

  it("matches prOpen filter", () => {
    const worktree = createMockWorktree({ prState: "open" });
    const filters = createEmptyFilters();
    filters.githubFilters.add("prOpen");
    const meta = createEmptyMeta();
    expect(matchesFilters(worktree, filters, meta, false)).toBe(true);
  });

  it("matches hasTerminals filter", () => {
    const worktree = createMockWorktree();
    const filters = createEmptyFilters();
    filters.sessionFilters.add("hasTerminals");
    const meta = createEmptyMeta();
    meta.terminalCount = 2;
    expect(matchesFilters(worktree, filters, meta, false)).toBe(true);
  });

  it("matches working agent filter", () => {
    const worktree = createMockWorktree();
    const filters = createEmptyFilters();
    filters.sessionFilters.add("working");
    const meta = createEmptyMeta();
    meta.hasWorkingAgent = true;
    expect(matchesFilters(worktree, filters, meta, false)).toBe(true);
  });

  describe("activity filters", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2024-01-15T12:00:00Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("matches last15m filter", () => {
      const now = Date.now();
      const worktree = createMockWorktree({
        lastActivityTimestamp: now - 5 * 60 * 1000, // 5 minutes ago
      });
      const filters = createEmptyFilters();
      filters.activityFilters.add("last15m");
      const meta = createEmptyMeta();
      expect(matchesFilters(worktree, filters, meta, false)).toBe(true);
    });

    it("does not match last15m for old activity", () => {
      const now = Date.now();
      const worktree = createMockWorktree({
        lastActivityTimestamp: now - 30 * 60 * 1000, // 30 minutes ago
      });
      const filters = createEmptyFilters();
      filters.activityFilters.add("last15m");
      const meta = createEmptyMeta();
      expect(matchesFilters(worktree, filters, meta, false)).toBe(false);
    });

    it("matches last1h filter", () => {
      const now = Date.now();
      const worktree = createMockWorktree({
        lastActivityTimestamp: now - 30 * 60 * 1000, // 30 minutes ago
      });
      const filters = createEmptyFilters();
      filters.activityFilters.add("last1h");
      const meta = createEmptyMeta();
      expect(matchesFilters(worktree, filters, meta, false)).toBe(true);
    });

    it("matches last24h filter", () => {
      const now = Date.now();
      const worktree = createMockWorktree({
        lastActivityTimestamp: now - 12 * 60 * 60 * 1000, // 12 hours ago
      });
      const filters = createEmptyFilters();
      filters.activityFilters.add("last24h");
      const meta = createEmptyMeta();
      expect(matchesFilters(worktree, filters, meta, false)).toBe(true);
    });

    it("matches last7d filter", () => {
      const now = Date.now();
      const worktree = createMockWorktree({
        lastActivityTimestamp: now - 3 * 24 * 60 * 60 * 1000, // 3 days ago
      });
      const filters = createEmptyFilters();
      filters.activityFilters.add("last7d");
      const meta = createEmptyMeta();
      expect(matchesFilters(worktree, filters, meta, false)).toBe(true);
    });
  });
});

describe("sortWorktrees", () => {
  it("always puts main worktree first", () => {
    const worktrees = [
      createMockWorktree({ id: "1", name: "feature", isMainWorktree: false }),
      createMockWorktree({ id: "2", name: "main", isMainWorktree: true }),
    ];
    const sorted = sortWorktrees(worktrees, "alpha");
    expect(sorted[0].id).toBe("2");
  });

  it("sorts by recent activity (most recent first)", () => {
    const worktrees = [
      createMockWorktree({ id: "1", name: "a", lastActivityTimestamp: 1000 }),
      createMockWorktree({ id: "2", name: "b", lastActivityTimestamp: 3000 }),
      createMockWorktree({ id: "3", name: "c", lastActivityTimestamp: 2000 }),
    ];
    const sorted = sortWorktrees(worktrees, "recent");
    expect(sorted.map((w) => w.id)).toEqual(["2", "3", "1"]);
  });

  it("sorts by creation date (most recent first)", () => {
    const worktrees = [
      createMockWorktree({ id: "1", name: "a", createdAt: 1000 }),
      createMockWorktree({ id: "2", name: "b", createdAt: 3000 }),
      createMockWorktree({ id: "3", name: "c", createdAt: 2000 }),
    ];
    const sorted = sortWorktrees(worktrees, "created");
    expect(sorted.map((w) => w.id)).toEqual(["2", "3", "1"]);
  });

  it("sorts alphabetically by name", () => {
    const worktrees = [
      createMockWorktree({ id: "1", name: "charlie" }),
      createMockWorktree({ id: "2", name: "alpha" }),
      createMockWorktree({ id: "3", name: "bravo" }),
    ];
    const sorted = sortWorktrees(worktrees, "alpha");
    expect(sorted.map((w) => w.name)).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("uses name as tiebreaker for recent sort", () => {
    const worktrees = [
      createMockWorktree({ id: "1", name: "zz", lastActivityTimestamp: 1000 }),
      createMockWorktree({ id: "2", name: "aa", lastActivityTimestamp: 1000 }),
    ];
    const sorted = sortWorktrees(worktrees, "recent");
    expect(sorted.map((w) => w.name)).toEqual(["aa", "zz"]);
  });

  it("handles null timestamps", () => {
    const worktrees = [
      createMockWorktree({ id: "1", name: "a", lastActivityTimestamp: null }),
      createMockWorktree({ id: "2", name: "b", lastActivityTimestamp: 1000 }),
    ];
    const sorted = sortWorktrees(worktrees, "recent");
    expect(sorted[0].id).toBe("2");
  });

  it("uses createdAt when lastActivityTimestamp is null", () => {
    const worktrees = [
      createMockWorktree({ id: "1", name: "old", lastActivityTimestamp: null, createdAt: 1000 }),
      createMockWorktree({ id: "2", name: "new", lastActivityTimestamp: null, createdAt: 5000 }),
    ];
    const sorted = sortWorktrees(worktrees, "recent");
    expect(sorted.map((w) => w.id)).toEqual(["2", "1"]);
  });

  it("uses whichever is higher between lastActivityTimestamp and createdAt", () => {
    const worktrees = [
      createMockWorktree({ id: "1", name: "a", lastActivityTimestamp: 2000, createdAt: 5000 }),
      createMockWorktree({ id: "2", name: "b", lastActivityTimestamp: 4000, createdAt: 1000 }),
    ];
    const sorted = sortWorktrees(worktrees, "recent");
    expect(sorted.map((w) => w.id)).toEqual(["1", "2"]);
  });

  it("ranks worktree with newer lastActivityTimestamp above one with newer createdAt", () => {
    const worktrees = [
      createMockWorktree({ id: "1", name: "a", lastActivityTimestamp: 6000, createdAt: 1000 }),
      createMockWorktree({ id: "2", name: "b", lastActivityTimestamp: null, createdAt: 5000 }),
    ];
    const sorted = sortWorktrees(worktrees, "recent");
    expect(sorted.map((w) => w.id)).toEqual(["1", "2"]);
  });

  it("ranks new worktree with recent createdAt above old worktree with no activity", () => {
    const worktrees = [
      createMockWorktree({ id: "1", name: "old", lastActivityTimestamp: 1000, createdAt: 500 }),
      createMockWorktree({ id: "2", name: "new", lastActivityTimestamp: null, createdAt: 5000 }),
    ];
    const sorted = sortWorktrees(worktrees, "recent");
    expect(sorted.map((w) => w.id)).toEqual(["2", "1"]);
  });

  it("falls back to 0 when both fields are missing", () => {
    const worktrees = [
      createMockWorktree({ id: "1", name: "a", lastActivityTimestamp: null, createdAt: undefined }),
      createMockWorktree({ id: "2", name: "b", lastActivityTimestamp: 1000 }),
    ];
    const sorted = sortWorktrees(worktrees, "recent");
    expect(sorted.map((w) => w.id)).toEqual(["2", "1"]);
  });

  it("handles undefined createdAt", () => {
    const worktrees = [
      createMockWorktree({ id: "1", name: "a", createdAt: undefined }),
      createMockWorktree({ id: "2", name: "b", createdAt: 1000 }),
    ];
    const sorted = sortWorktrees(worktrees, "created");
    expect(sorted[0].id).toBe("2");
  });

  it("does not mutate original array", () => {
    const worktrees = [
      createMockWorktree({ id: "1", name: "b" }),
      createMockWorktree({ id: "2", name: "a" }),
    ];
    const original = [...worktrees];
    sortWorktrees(worktrees, "alpha");
    expect(worktrees).toEqual(original);
  });

  describe("pinned worktrees", () => {
    it("places pinned worktrees first in pin order", () => {
      const worktrees = [
        createMockWorktree({ id: "1", name: "a" }),
        createMockWorktree({ id: "2", name: "b" }),
        createMockWorktree({ id: "3", name: "c" }),
      ];
      const sorted = sortWorktrees(worktrees, "alpha", ["3", "1"]);
      expect(sorted.map((w) => w.id)).toEqual(["3", "1", "2"]);
    });

    it("keeps main worktree first even when other worktrees are pinned", () => {
      const worktrees = [
        createMockWorktree({ id: "1", name: "feature", isMainWorktree: false }),
        createMockWorktree({ id: "2", name: "main", isMainWorktree: true }),
        createMockWorktree({ id: "3", name: "bugfix", isMainWorktree: false }),
      ];
      const sorted = sortWorktrees(worktrees, "alpha", ["1", "3"]);
      expect(sorted[0].id).toBe("2"); // main first
      expect(sorted[1].id).toBe("1"); // first pinned
      expect(sorted[2].id).toBe("3"); // second pinned
    });

    it("applies normal sorting to unpinned worktrees", () => {
      const worktrees = [
        createMockWorktree({ id: "1", name: "z-feature", createdAt: 1000 }),
        createMockWorktree({ id: "2", name: "a-feature", createdAt: 3000 }),
        createMockWorktree({ id: "3", name: "m-feature", createdAt: 2000 }),
        createMockWorktree({ id: "4", name: "pinned", createdAt: 500 }),
      ];
      const sorted = sortWorktrees(worktrees, "created", ["4"]);
      expect(sorted.map((w) => w.id)).toEqual(["4", "2", "3", "1"]);
    });

    it("handles pinnedWorktrees containing deleted worktree IDs", () => {
      const worktrees = [
        createMockWorktree({ id: "1", name: "a" }),
        createMockWorktree({ id: "2", name: "b" }),
      ];
      // "99" doesn't exist in worktrees
      const sorted = sortWorktrees(worktrees, "alpha", ["99", "2"]);
      expect(sorted.map((w) => w.id)).toEqual(["2", "1"]);
    });

    it("maintains pin order across different sort modes", () => {
      const worktrees = [
        createMockWorktree({ id: "1", name: "z", createdAt: 3000, lastActivityTimestamp: 1000 }),
        createMockWorktree({ id: "2", name: "a", createdAt: 1000, lastActivityTimestamp: 3000 }),
        createMockWorktree({ id: "3", name: "m", createdAt: 2000, lastActivityTimestamp: 2000 }),
      ];
      const pinnedOrder = ["1", "3"];

      const sortedByAlpha = sortWorktrees(worktrees, "alpha", pinnedOrder);
      expect(sortedByAlpha[0].id).toBe("1");
      expect(sortedByAlpha[1].id).toBe("3");

      const sortedByCreated = sortWorktrees(worktrees, "created", pinnedOrder);
      expect(sortedByCreated[0].id).toBe("1");
      expect(sortedByCreated[1].id).toBe("3");

      const sortedByRecent = sortWorktrees(worktrees, "recent", pinnedOrder);
      expect(sortedByRecent[0].id).toBe("1");
      expect(sortedByRecent[1].id).toBe("3");
    });

    it("returns unchanged order with empty pinnedWorktrees array", () => {
      const worktrees = [
        createMockWorktree({ id: "1", name: "b" }),
        createMockWorktree({ id: "2", name: "a" }),
      ];
      const sorted = sortWorktrees(worktrees, "alpha", []);
      expect(sorted.map((w) => w.name)).toEqual(["a", "b"]);
    });
  });
});

describe("sortWorktrees manual order", () => {
  it("sorts by manual order", () => {
    const worktrees = [
      createMockWorktree({ id: "1", name: "a" }),
      createMockWorktree({ id: "2", name: "b" }),
      createMockWorktree({ id: "3", name: "c" }),
    ];
    const sorted = sortWorktrees(worktrees, "manual", [], ["3", "1", "2"]);
    expect(sorted.map((w) => w.id)).toEqual(["3", "1", "2"]);
  });

  it("appends worktrees not in manualOrder to the end", () => {
    const worktrees = [
      createMockWorktree({ id: "1", name: "a" }),
      createMockWorktree({ id: "2", name: "b" }),
      createMockWorktree({ id: "3", name: "c" }),
    ];
    const sorted = sortWorktrees(worktrees, "manual", [], ["2"]);
    expect(sorted[0].id).toBe("2");
    // remaining items sorted alphabetically as tiebreaker
    expect(sorted.slice(1).map((w) => w.id)).toEqual(["1", "3"]);
  });

  it("ignores stale IDs in manualOrder", () => {
    const worktrees = [
      createMockWorktree({ id: "1", name: "a" }),
      createMockWorktree({ id: "2", name: "b" }),
    ];
    const sorted = sortWorktrees(worktrees, "manual", [], ["99", "2", "1"]);
    expect(sorted.map((w) => w.id)).toEqual(["2", "1"]);
  });

  it("respects main worktree precedence in manual mode", () => {
    const worktrees = [
      createMockWorktree({ id: "1", name: "feature" }),
      createMockWorktree({ id: "2", name: "main", isMainWorktree: true }),
    ];
    const sorted = sortWorktrees(worktrees, "manual", [], ["1", "2"]);
    expect(sorted[0].id).toBe("2"); // main always first
  });

  it("respects pinned worktree precedence in manual mode", () => {
    const worktrees = [
      createMockWorktree({ id: "1", name: "a" }),
      createMockWorktree({ id: "2", name: "b" }),
      createMockWorktree({ id: "3", name: "c" }),
    ];
    const sorted = sortWorktrees(worktrees, "manual", ["3"], ["1", "2", "3"]);
    expect(sorted[0].id).toBe("3"); // pinned first
    expect(sorted.slice(1).map((w) => w.id)).toEqual(["1", "2"]); // then manual order
  });

  it("falls back to name sort with empty manualOrder", () => {
    const worktrees = [
      createMockWorktree({ id: "1", name: "charlie" }),
      createMockWorktree({ id: "2", name: "alpha" }),
    ];
    const sorted = sortWorktrees(worktrees, "manual", [], []);
    // all items have same position (manualOrder.length = 0), tiebreaker is name
    expect(sorted.map((w) => w.name)).toEqual(["alpha", "charlie"]);
  });
});

describe("groupByType", () => {
  it("groups worktrees by type", () => {
    const worktrees = [
      createMockWorktree({ id: "1", branch: "feature/a" }),
      createMockWorktree({ id: "2", branch: "bugfix/b" }),
      createMockWorktree({ id: "3", branch: "feature/c" }),
    ];
    const groups = groupByType(worktrees, "alpha");
    expect(groups.length).toBe(2);

    const featureGroup = groups.find((g) => g.type === "feature");
    expect(featureGroup?.worktrees.length).toBe(2);

    const bugfixGroup = groups.find((g) => g.type === "bugfix");
    expect(bugfixGroup?.worktrees.length).toBe(1);
  });

  it("puts main group first", () => {
    const worktrees = [
      createMockWorktree({ id: "1", branch: "feature/a" }),
      createMockWorktree({ id: "2", branch: "main", isMainWorktree: true }),
    ];
    const groups = groupByType(worktrees, "alpha");
    expect(groups[0].type).toBe("main");
  });

  it("includes displayName for each group", () => {
    const worktrees = [createMockWorktree({ id: "1", branch: "feature/test" })];
    const groups = groupByType(worktrees, "alpha");
    expect(groups[0].displayName).toBe("Features");
  });

  it("sorts worktrees within groups according to orderBy", () => {
    const worktrees = [
      createMockWorktree({ id: "1", name: "z-feature", branch: "feature/z" }),
      createMockWorktree({ id: "2", name: "a-feature", branch: "feature/a" }),
    ];
    const groups = groupByType(worktrees, "alpha");
    const featureGroup = groups.find((g) => g.type === "feature");
    expect(featureGroup?.worktrees[0].name).toBe("a-feature");
  });

  it("excludes empty groups", () => {
    const worktrees = [createMockWorktree({ id: "1", branch: "feature/a" })];
    const groups = groupByType(worktrees, "alpha");
    expect(groups.length).toBe(1);
    expect(groups.every((g) => g.worktrees.length > 0)).toBe(true);
  });
});

describe("hasAnyFilters", () => {
  it("returns false for empty filters", () => {
    const filters = createEmptyFilters();
    expect(hasAnyFilters(filters)).toBe(false);
  });

  it("returns true when query is set", () => {
    const filters = createEmptyFilters();
    filters.query = "test";
    expect(hasAnyFilters(filters)).toBe(true);
  });

  it("returns true when status filter is set", () => {
    const filters = createEmptyFilters();
    filters.statusFilters.add("active");
    expect(hasAnyFilters(filters)).toBe(true);
  });

  it("returns true when type filter is set", () => {
    const filters = createEmptyFilters();
    filters.typeFilters.add("feature");
    expect(hasAnyFilters(filters)).toBe(true);
  });

  it("returns true when github filter is set", () => {
    const filters = createEmptyFilters();
    filters.githubFilters.add("hasIssue");
    expect(hasAnyFilters(filters)).toBe(true);
  });

  it("returns true when session filter is set", () => {
    const filters = createEmptyFilters();
    filters.sessionFilters.add("hasTerminals");
    expect(hasAnyFilters(filters)).toBe(true);
  });

  it("returns true when activity filter is set", () => {
    const filters = createEmptyFilters();
    filters.activityFilters.add("last24h");
    expect(hasAnyFilters(filters)).toBe(true);
  });
});

describe("findIntegrationWorktree", () => {
  it("returns worktree with branch 'develop'", () => {
    const worktrees = [
      createMockWorktree({ id: "main", branch: "main", isMainWorktree: true }),
      createMockWorktree({ id: "dev", branch: "develop" }),
      createMockWorktree({ id: "feat", branch: "feature/test" }),
    ];
    const result = findIntegrationWorktree(worktrees, "main");
    expect(result?.id).toBe("dev");
  });

  it("returns worktree with branch 'trunk'", () => {
    const worktrees = [
      createMockWorktree({ id: "main", branch: "main", isMainWorktree: true }),
      createMockWorktree({ id: "trunk", branch: "trunk" }),
    ];
    const result = findIntegrationWorktree(worktrees, "main");
    expect(result?.id).toBe("trunk");
  });

  it("returns worktree with branch 'next'", () => {
    const worktrees = [
      createMockWorktree({ id: "main", branch: "main", isMainWorktree: true }),
      createMockWorktree({ id: "next", branch: "next" }),
    ];
    const result = findIntegrationWorktree(worktrees, "main");
    expect(result?.id).toBe("next");
  });

  it("returns null when no integration branch exists", () => {
    const worktrees = [
      createMockWorktree({ id: "main", branch: "main", isMainWorktree: true }),
      createMockWorktree({ id: "feat", branch: "feature/test" }),
    ];
    const result = findIntegrationWorktree(worktrees, "main");
    expect(result).toBeNull();
  });

  it("does not match substrings like 'development' or 'feature/develop'", () => {
    const worktrees = [
      createMockWorktree({ id: "main", branch: "main", isMainWorktree: true }),
      createMockWorktree({ id: "1", branch: "development" }),
      createMockWorktree({ id: "2", branch: "feature/develop" }),
    ];
    const result = findIntegrationWorktree(worktrees, "main");
    expect(result).toBeNull();
  });

  it("does not return the main worktree even if its branch is 'develop'", () => {
    const worktrees = [createMockWorktree({ id: "main", branch: "develop", isMainWorktree: true })];
    const result = findIntegrationWorktree(worktrees, "main");
    expect(result).toBeNull();
  });

  it("returns the first match when multiple integration branches exist", () => {
    const worktrees = [
      createMockWorktree({ id: "main", branch: "main", isMainWorktree: true }),
      createMockWorktree({ id: "dev", branch: "develop" }),
      createMockWorktree({ id: "trunk", branch: "trunk" }),
    ];
    const result = findIntegrationWorktree(worktrees, "main");
    expect(result?.id).toBe("dev");
  });

  it("excludes worktree by mainWorktreeId even when isMainWorktree is false", () => {
    const worktrees = [
      createMockWorktree({ id: "fallback-main", branch: "develop", isMainWorktree: false }),
      createMockWorktree({ id: "feat", branch: "feature/test" }),
    ];
    const result = findIntegrationWorktree(worktrees, "fallback-main");
    expect(result).toBeNull();
  });

  it("matches case-insensitively", () => {
    const worktrees = [
      createMockWorktree({ id: "main", branch: "main", isMainWorktree: true }),
      createMockWorktree({ id: "dev", branch: "Develop" }),
    ];
    const result = findIntegrationWorktree(worktrees, "main");
    expect(result?.id).toBe("dev");
  });

  it("returns null for worktrees with undefined branch", () => {
    const worktrees = [
      createMockWorktree({ id: "main", branch: "main", isMainWorktree: true }),
      createMockWorktree({ id: "detached", branch: undefined }),
    ];
    const result = findIntegrationWorktree(worktrees, "main");
    expect(result).toBeNull();
  });
});

describe("filterTriageWorktrees", () => {
  const buildMetaMap = (entries: [string, Partial<DerivedWorktreeMeta>][]) => {
    const map = new Map<string, DerivedWorktreeMeta>();
    for (const [id, overrides] of entries) {
      map.set(id, { ...createEmptyMeta(), ...overrides });
    }
    return map;
  };

  it("includes worktrees with hasWaitingAgent", () => {
    const worktrees = [createMockWorktree({ id: "w1", name: "feat-a" })];
    const metaMap = buildMetaMap([["w1", { hasWaitingAgent: true }]]);
    const result = filterTriageWorktrees(worktrees, metaMap, undefined, undefined, "");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("w1");
  });

  it("includes worktrees with hasMergeConflict", () => {
    const worktrees = [createMockWorktree({ id: "w1", name: "feat-a" })];
    const metaMap = buildMetaMap([["w1", { hasMergeConflict: true }]]);
    const result = filterTriageWorktrees(worktrees, metaMap, undefined, undefined, "");
    expect(result).toHaveLength(1);
  });

  it("excludes worktrees with no qualifying conditions", () => {
    const worktrees = [createMockWorktree({ id: "w1", name: "feat-a" })];
    const metaMap = buildMetaMap([["w1", {}]]);
    const result = filterTriageWorktrees(worktrees, metaMap, undefined, undefined, "");
    expect(result).toHaveLength(0);
  });

  it("excludes worktrees with missing meta", () => {
    const worktrees = [createMockWorktree({ id: "w1", name: "feat-a" })];
    const metaMap = new Map<string, DerivedWorktreeMeta>();
    const result = filterTriageWorktrees(worktrees, metaMap, undefined, undefined, "");
    expect(result).toHaveLength(0);
  });

  it("excludes main worktree even when qualifying", () => {
    const worktrees = [
      createMockWorktree({ id: "main-id", name: "main", isMainWorktree: true }),
      createMockWorktree({ id: "w1", name: "feat-a" }),
    ];
    const metaMap = buildMetaMap([
      ["main-id", { hasWaitingAgent: true }],
      ["w1", { hasWaitingAgent: true }],
    ]);
    const result = filterTriageWorktrees(worktrees, metaMap, "main-id", undefined, "");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("w1");
  });

  it("excludes integration worktree even when qualifying", () => {
    const worktrees = [
      createMockWorktree({ id: "dev-id", name: "develop", branch: "develop" }),
      createMockWorktree({ id: "w1", name: "feat-a" }),
    ];
    const metaMap = buildMetaMap([
      ["dev-id", { hasWaitingAgent: true }],
      ["w1", { hasMergeConflict: true }],
    ]);
    const result = filterTriageWorktrees(worktrees, metaMap, undefined, "dev-id", "");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("w1");
  });

  it("filters by text search query", () => {
    const worktrees = [
      createMockWorktree({ id: "w1", name: "auth-fix", branch: "bugfix/auth" }),
      createMockWorktree({ id: "w2", name: "payment-feat", branch: "feature/payment" }),
    ];
    const metaMap = buildMetaMap([
      ["w1", { hasMergeConflict: true }],
      ["w2", { hasWaitingAgent: true }],
    ]);
    const result = filterTriageWorktrees(worktrees, metaMap, undefined, undefined, "auth");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("w1");
  });

  it("filters by #number query matching issueNumber", () => {
    const worktrees = [
      createMockWorktree({ id: "w1", name: "feat-a", issueNumber: 42 }),
      createMockWorktree({ id: "w2", name: "feat-b", issueNumber: 99 }),
    ];
    const metaMap = buildMetaMap([
      ["w1", { hasMergeConflict: true }],
      ["w2", { hasWaitingAgent: true }],
    ]);
    const result = filterTriageWorktrees(worktrees, metaMap, undefined, undefined, "#42");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("w1");
  });

  it("returns all qualifying worktrees when query is empty", () => {
    const worktrees = [
      createMockWorktree({ id: "w1", name: "feat-a" }),
      createMockWorktree({ id: "w2", name: "feat-b" }),
      createMockWorktree({ id: "w3", name: "feat-c" }),
    ];
    const metaMap = buildMetaMap([
      ["w1", { hasWaitingAgent: true }],
      ["w2", {}],
      ["w3", { hasMergeConflict: true }],
    ]);
    const result = filterTriageWorktrees(worktrees, metaMap, undefined, undefined, "");
    expect(result).toHaveLength(2);
    expect(result.map((w) => w.id)).toEqual(["w1", "w3"]);
  });
});

describe("matchesQuickStateFilter", () => {
  it('"all" matches everything', () => {
    expect(matchesQuickStateFilter("all", createEmptyMeta())).toBe(true);
  });

  it('"working" matches when hasWorkingAgent and chipState is null', () => {
    const meta = { ...createEmptyMeta(), hasWorkingAgent: true, chipState: null };
    expect(matchesQuickStateFilter("working", meta)).toBe(true);
  });

  it('"working" matches when hasRunningAgent and chipState is null', () => {
    const meta = { ...createEmptyMeta(), hasRunningAgent: true, chipState: null };
    expect(matchesQuickStateFilter("working", meta)).toBe(true);
  });

  it('"working" does NOT match when chipState overrides to "waiting"', () => {
    const meta = { ...createEmptyMeta(), hasWorkingAgent: true, chipState: "waiting" as const };
    expect(matchesQuickStateFilter("working", meta)).toBe(false);
  });

  it('"working" does NOT match when chipState is "complete"', () => {
    const meta = { ...createEmptyMeta(), hasWorkingAgent: true, chipState: "complete" as const };
    expect(matchesQuickStateFilter("working", meta)).toBe(false);
  });

  it('"working" does NOT match when no active agents', () => {
    expect(matchesQuickStateFilter("working", createEmptyMeta())).toBe(false);
  });

  it('"waiting" matches when chipState is "waiting"', () => {
    const meta = { ...createEmptyMeta(), chipState: "waiting" as const };
    expect(matchesQuickStateFilter("waiting", meta)).toBe(true);
  });

  it('"finished" matches chipState "complete"', () => {
    const meta = { ...createEmptyMeta(), chipState: "complete" as const };
    expect(matchesQuickStateFilter("finished", meta)).toBe(true);
  });

  it('"finished" matches chipState "cleanup"', () => {
    const meta = { ...createEmptyMeta(), chipState: "cleanup" as const };
    expect(matchesQuickStateFilter("finished", meta)).toBe(true);
  });

  it('"finished" does NOT match chipState null', () => {
    expect(matchesQuickStateFilter("finished", createEmptyMeta())).toBe(false);
  });

  it('"finished" does NOT match chipState "waiting"', () => {
    const meta = { ...createEmptyMeta(), chipState: "waiting" as const };
    expect(matchesQuickStateFilter("finished", meta)).toBe(false);
  });
});
