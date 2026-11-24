import { describe, it, expect, beforeEach } from "vitest";
import {
  computeFrecency,
  buildRecipeSections,
  rankSearchResults,
  getRecipeFuse,
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

  it("returns every match beyond 50", () => {
    const recipes = Array.from({ length: 80 }, (_, i) =>
      makeRecipe({ id: `r${i}`, name: `deploy ${i}` })
    );
    expect(rankSearchResults(recipes, "deploy", Date.now())).toHaveLength(80);
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

describe("buildRecipeSections edge cases", () => {
  it("returns empty sections for empty recipes", () => {
    const sections = buildRecipeSections([]);
    expect(sections.pinned).toHaveLength(0);
    expect(sections.recent).toHaveLength(0);
    expect(sections.all).toHaveLength(0);
  });
});
