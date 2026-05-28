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

  it("strips a trailing hyphen exposed by truncation", () => {
    // 199 chars + a space → space becomes hyphen at position 199; slice cuts
    // exactly at position 200, so the trailing hyphen must be stripped after.
    const filename = safeRecipeFilename("a".repeat(199) + " more text here");
    expect(filename).toBe("a".repeat(199) + ".json");
    expect(filename).not.toContain("-.");
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
  it("returns true for legacy inrepo- prefixed IDs (string form)", () => {
    expect(isInRepoRecipeId("inrepo-my-recipe")).toBe(true);
  });

  it("returns false for other IDs (string form)", () => {
    expect(isInRepoRecipeId("recipe-12345-abc")).toBe(false);
    expect(isInRepoRecipeId("global-1")).toBe(false);
  });

  it("returns true for a recipe with scope 'inrepo' even when the id is opaque", () => {
    expect(isInRepoRecipeId({ id: "recipe-12345-abc", scope: "inrepo" })).toBe(true);
  });

  it("returns true for a legacy recipe object (inrepo- id, no scope)", () => {
    expect(isInRepoRecipeId({ id: "inrepo-my-recipe" })).toBe(true);
  });

  it("returns false for a recipe object with an opaque id and no in-repo scope", () => {
    expect(isInRepoRecipeId({ id: "recipe-12345-abc" })).toBe(false);
    expect(isInRepoRecipeId({ id: "recipe-12345-abc", scope: undefined })).toBe(false);
  });
});
