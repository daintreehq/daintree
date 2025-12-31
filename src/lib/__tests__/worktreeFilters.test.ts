import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  getWorktreeType,
  buildSearchableText,
  computeStatus,
  matchesFilters,
  sortWorktrees,
  groupByType,
  hasAnyFilters,
  type DerivedWorktreeMeta,
  type FilterState,
} from "../worktreeFilters";
import type { Worktree } from "@shared/types/domain";

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
  hasErrors: false,
  terminalCount: 0,
  hasWorkingAgent: false,
  hasRunningAgent: false,
  hasWaitingAgent: false,
  hasFailedAgent: false,
  hasCompletedAgent: false,
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

  it("includes path", () => {
    const worktree = createMockWorktree({ path: "/home/user/my-project" });
    expect(buildSearchableText(worktree)).toContain("/home/user/my-project");
  });

  it("includes issue number with hash", () => {
    const worktree = createMockWorktree({ issueNumber: 123 });
    expect(buildSearchableText(worktree)).toContain("#123");
  });

  it("includes PR number with hash", () => {
    const worktree = createMockWorktree({ prNumber: 456 });
    expect(buildSearchableText(worktree)).toContain("#456");
  });

  it("includes summary", () => {
    const worktree = createMockWorktree({ summary: "Working on feature X" });
    expect(buildSearchableText(worktree)).toContain("working on feature x");
  });

  it("includes aiNote", () => {
    const worktree = createMockWorktree({ aiNote: "Agent is implementing tests" });
    expect(buildSearchableText(worktree)).toContain("agent is implementing tests");
  });

  it("returns lowercase text", () => {
    const worktree = createMockWorktree({ name: "MyWorktree", branch: "Feature/Test" });
    const text = buildSearchableText(worktree);
    expect(text).toBe(text.toLowerCase());
  });
});

describe("computeStatus", () => {
  it("includes 'active' when worktree is active", () => {
    const worktree = createMockWorktree();
    const statuses = computeStatus(worktree, true, false);
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
    const statuses = computeStatus(worktree, false, false);
    expect(statuses).toContain("dirty");
  });

  it("includes 'error' when mood is error", () => {
    const worktree = createMockWorktree({ mood: "error" });
    const statuses = computeStatus(worktree, false, false);
    expect(statuses).toContain("error");
  });

  it("includes 'error' when hasErrors is true", () => {
    const worktree = createMockWorktree();
    const statuses = computeStatus(worktree, false, true);
    expect(statuses).toContain("error");
  });

  it("includes 'stale' when mood is stale", () => {
    const worktree = createMockWorktree({ mood: "stale" });
    const statuses = computeStatus(worktree, false, false);
    expect(statuses).toContain("stale");
  });

  it("includes 'idle' when no other status", () => {
    const worktree = createMockWorktree();
    const statuses = computeStatus(worktree, false, false);
    expect(statuses).toContain("idle");
  });

  it("includes 'idle' when only active", () => {
    const worktree = createMockWorktree();
    const statuses = computeStatus(worktree, true, false);
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
