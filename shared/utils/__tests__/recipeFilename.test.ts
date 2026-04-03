import { describe, expect, it } from "vitest";
import { safeRecipeFilename, stableInRepoId, isInRepoRecipeId } from "../recipeFilename.js";

describe("safeRecipeFilename", () => {
  it("converts a simple name to lowercase with .json extension", () => {
    expect(safeRecipeFilename("My Recipe")).toBe("my-recipe.json");
  });

  it("strips diacritics", () => {
    expect(safeRecipeFilename("café résumé")).toBe("cafe-resume.json");
  });

  it("strips OS-forbidden characters", () => {
    expect(safeRecipeFilename('test<>:"/\\|?*')).toBe("test.json");
  });

  it("collapses multiple spaces and hyphens", () => {
    expect(safeRecipeFilename("a   b---c")).toBe("a-b-c.json");
  });

  it("falls back to 'recipe' for empty input", () => {
    expect(safeRecipeFilename("")).toBe("recipe.json");
    expect(safeRecipeFilename("   ")).toBe("recipe.json");
  });

  it("truncates at 200 characters", () => {
    const longName = "a".repeat(250);
    const filename = safeRecipeFilename(longName);
    expect(filename).toBe("a".repeat(200) + ".json");
  });
});

describe("stableInRepoId", () => {
  it("returns an inrepo- prefixed ID derived from the name", () => {
    expect(stableInRepoId("My Recipe")).toBe("inrepo-my-recipe");
  });

  it("deterministic: same name always produces same ID", () => {
    expect(stableInRepoId("Test")).toBe(stableInRepoId("Test"));
  });
});

describe("isInRepoRecipeId", () => {
  it("returns true for inrepo- prefixed IDs", () => {
    expect(isInRepoRecipeId("inrepo-my-recipe")).toBe(true);
  });

  it("returns false for other IDs", () => {
    expect(isInRepoRecipeId("recipe-12345-abc")).toBe(false);
    expect(isInRepoRecipeId("global-1")).toBe(false);
  });
});
