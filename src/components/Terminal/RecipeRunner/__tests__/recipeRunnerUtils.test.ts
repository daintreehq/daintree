import { describe, it, expect } from "vitest";
import { computeFrecency, buildRecipeSections, rankSearchResults } from "../recipeRunnerUtils";
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
