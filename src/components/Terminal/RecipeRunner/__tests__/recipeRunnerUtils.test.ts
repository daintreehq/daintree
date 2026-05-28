import { describe, it, expect, beforeEach } from "vitest";
import {
  computeFrecency,
  buildRecipeSections,
  rankSearchResults,
  getRecipeFuse,
  nextDuplicateName,
  _resetRecipeFuseCacheForTests,
} from "../recipeRunnerUtils";
import type { TerminalRecipe } from "@/types";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function makeRecipe(
  overrides: Partial<TerminalRecipe> & { id: string; name: string }
): TerminalRecipe {
  return {
    terminals: [{ type: "terminal", env: {} }],
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("computeFrecency", () => {
  it("returns 0 for empty history", () => {
    expect(computeFrecency([], Date.now())).toBe(0);
  });

  it("returns 100 for a single usage at current time", () => {
    const now = Date.now();
    expect(computeFrecency([now], now)).toBeCloseTo(100, 5);
  });

  it("returns ~50 for a single usage exactly 7 days ago", () => {
    const now = Date.now();
    expect(computeFrecency([now - SEVEN_DAYS_MS], now)).toBeCloseTo(50, 1);
  });

  it("returns ~25 for a single usage exactly 14 days ago", () => {
    const now = Date.now();
    expect(computeFrecency([now - 2 * SEVEN_DAYS_MS], now)).toBeCloseTo(25, 1);
  });

  it("sums contributions from multiple timestamps", () => {
    const now = Date.now();
    const score = computeFrecency([now, now - SEVEN_DAYS_MS], now);
    expect(score).toBeCloseTo(150, 1); // 100 + 50
  });
});

describe("buildRecipeSections", () => {
  it("places showInEmptyState recipes in pinned", () => {
    const recipes = [
      makeRecipe({ id: "1", name: "A", showInEmptyState: true }),
      makeRecipe({ id: "2", name: "B", showInEmptyState: false, lastUsedAt: Date.now() }),
    ];
    const sections = buildRecipeSections(recipes);
    expect(sections.pinned.map((r) => r.id)).toEqual(["1"]);
    expect(sections.recent.map((r) => r.id)).toEqual(["2"]);
  });

  it("caps recent at 5", () => {
    const recipes = Array.from({ length: 8 }, (_, i) =>
      makeRecipe({ id: String(i), name: `R${i}`, lastUsedAt: Date.now() - i * 1000 })
    );
    const sections = buildRecipeSections(recipes);
    expect(sections.recent).toHaveLength(5);
  });

  it("puts remaining recipes in all, sorted alphabetically", () => {
    const recipes = [
      makeRecipe({ id: "1", name: "Zebra" }),
      makeRecipe({ id: "2", name: "Apple" }),
      makeRecipe({ id: "3", name: "Mango", showInEmptyState: true }),
    ];
    const sections = buildRecipeSections(recipes);
    expect(sections.all.map((r) => r.name)).toEqual(["Apple", "Zebra"]);
  });

  it("includes all passed recipes without additional filtering", () => {
    const recipes = [
      makeRecipe({ id: "1", name: "Global", worktreeId: undefined }),
      makeRecipe({ id: "2", name: "WT1", worktreeId: "wt-1" }),
    ];
    const sections = buildRecipeSections(recipes);
    const allIds = [...sections.pinned, ...sections.recent, ...sections.all].map((r) => r.id);
    expect(allIds).toContain("1");
    expect(allIds).toContain("2");
    expect(allIds).toHaveLength(2);
  });
});

describe("rankSearchResults", () => {
  it("returns empty for no matches", () => {
    const recipes = [makeRecipe({ id: "1", name: "Deploy" })];
    const results = rankSearchResults(recipes, "zzzzz", Date.now());
    expect(results).toHaveLength(0);
  });

  it("ranks exact matches higher", () => {
    const recipes = [
      makeRecipe({ id: "1", name: "deploy production" }),
      makeRecipe({ id: "2", name: "deploy staging" }),
    ];
    const results = rankSearchResults(recipes, "deploy production", Date.now());
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.recipe.id).toBe("1");
  });

  it("boosts frequently used recipes via frecency", () => {
    const now = Date.now();
    const recipes = [
      makeRecipe({ id: "1", name: "test runner", usageHistory: [] }),
      makeRecipe({ id: "2", name: "test suite", usageHistory: [now, now, now, now, now] }),
    ];
    const results = rankSearchResults(recipes, "test", now);
    expect(results.length).toBe(2);
    expect(results[0]!.recipe.id).toBe("2");
  });

  it("returns empty for empty recipe array", () => {
    const results = rankSearchResults([], "query", Date.now());
    expect(results).toHaveLength(0);
  });
});

describe("getRecipeFuse caching", () => {
  beforeEach(() => {
    _resetRecipeFuseCacheForTests();
  });

  it("returns the same Fuse instance for arrays with identical id+name content", () => {
    const a = [makeRecipe({ id: "1", name: "Build" }), makeRecipe({ id: "2", name: "Test" })];
    const b = [makeRecipe({ id: "1", name: "Build" }), makeRecipe({ id: "2", name: "Test" })];
    expect(getRecipeFuse(a)).toBe(getRecipeFuse(b));
  });

  it("does not rebuild when only metadata (lastUsedAt, usageHistory) changes", () => {
    // Reproduces the original bug shape: every runRecipe call rewrites
    // lastUsedAt, which produced a new array reference and busted the cache.
    const before = [makeRecipe({ id: "1", name: "Deploy", lastUsedAt: 1 })];
    const after = [
      makeRecipe({ id: "1", name: "Deploy", lastUsedAt: 2, usageHistory: [Date.now()] }),
    ];
    expect(getRecipeFuse(before)).toBe(getRecipeFuse(after));
  });

  it("rebuilds when a recipe is renamed", () => {
    const before = [makeRecipe({ id: "1", name: "Old" })];
    const after = [makeRecipe({ id: "1", name: "New" })];
    expect(getRecipeFuse(before)).not.toBe(getRecipeFuse(after));
  });

  it("rebuilds when a recipe is added or removed", () => {
    const before = [makeRecipe({ id: "1", name: "A" })];
    const after = [makeRecipe({ id: "1", name: "A" }), makeRecipe({ id: "2", name: "B" })];
    expect(getRecipeFuse(before)).not.toBe(getRecipeFuse(after));
  });

  it("doesn't collide between recipe sets that share field-separator chars", () => {
    // Length-prefixed key prevents a name containing the separator from
    // colliding with a different recipe set's serialization.
    const a = [makeRecipe({ id: "1,2", name: "X" })];
    const b = [makeRecipe({ id: "1", name: ",2:1:X" })];
    expect(getRecipeFuse(a)).not.toBe(getRecipeFuse(b));
  });
});

describe("rankSearchResults frecency freshness", () => {
  beforeEach(() => {
    _resetRecipeFuseCacheForTests();
  });

  it("uses the current usageHistory even when the Fuse cache is reused", () => {
    const now = Date.now();
    // First call seeds the Fuse cache with usageHistory:[].
    const before = [makeRecipe({ id: "r1", name: "test", usageHistory: [] })];
    rankSearchResults(before, "test", now);

    // Second call hits the cached Fuse instance but should still see the
    // freshest usageHistory from the input list, so frecency reflects it.
    const after = [makeRecipe({ id: "r1", name: "test", usageHistory: [now, now, now] })];
    const results = rankSearchResults(after, "test", now);
    expect(results[0]?.recipe.usageHistory).toEqual([now, now, now]);
  });
});

describe("nextDuplicateName", () => {
  it("returns 'Foo (Copy)' when no copies exist yet", () => {
    expect(nextDuplicateName("Foo", new Set())).toBe("Foo (Copy)");
  });

  it("strips existing '(Copy)' suffix so duplicating a copy doesn't nest", () => {
    expect(nextDuplicateName("Foo (Copy)", new Set(["Foo (Copy)"]))).toBe("Foo (Copy 2)");
  });

  it("strips existing '(Copy N)' suffix and increments past the highest taken slot", () => {
    const taken = new Set(["Foo (Copy)", "Foo (Copy 2)"]);
    expect(nextDuplicateName("Foo (Copy 2)", taken)).toBe("Foo (Copy 3)");
  });

  it("never returns a name that is already taken", () => {
    const taken = new Set(["Recipe", "Recipe (Copy)"]);
    const result = nextDuplicateName("Recipe", taken);
    expect(taken.has(result)).toBe(false);
    expect(result).toBe("Recipe (Copy 2)");
  });

  it("pre-truncates very long names so copies don't collide on the on-disk filename", () => {
    // Without root pre-truncation, " (Copy)" gets sliced off by safeRecipeFilename's
    // 200-char cap and every candidate would map to the same filename on disk.
    const longName = "a".repeat(220);
    const result = nextDuplicateName(longName, new Set([longName]));
    expect(result).not.toBe(longName);
    expect(result.length).toBeLessThanOrEqual(180 + " (Copy)".length);
  });
});

describe("buildRecipeSections edge cases", () => {
  it("returns empty sections for empty recipes", () => {
    const sections = buildRecipeSections([]);
    expect(sections.pinned).toHaveLength(0);
    expect(sections.recent).toHaveLength(0);
    expect(sections.all).toHaveLength(0);
  });

  it("handles all recipes pinned", () => {
    const recipes = [
      makeRecipe({ id: "1", name: "A", showInEmptyState: true }),
      makeRecipe({ id: "2", name: "B", showInEmptyState: true }),
    ];
    const sections = buildRecipeSections(recipes);
    expect(sections.pinned).toHaveLength(2);
    expect(sections.recent).toHaveLength(0);
    expect(sections.all).toHaveLength(0);
  });
});
