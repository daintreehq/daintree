import { describe, it, expect } from "vitest";
import { safeRecipeFilename } from "../recipeFilename.js";

describe("safeRecipeFilename", () => {
  it("converts a normal name to lowercase with .json extension", () => {
    expect(safeRecipeFilename("My Recipe")).toBe("my-recipe.json");
  });

  it("strips OS-forbidden characters", () => {
    expect(safeRecipeFilename('foo/bar:baz*qux?"<>|')).toBe("foobarbazqux.json");
  });

  it("strips diacritics", () => {
    expect(safeRecipeFilename("café résumé")).toBe("cafe-resume.json");
  });

  it("collapses multiple spaces and hyphens", () => {
    expect(safeRecipeFilename("a   b---c")).toBe("a-b-c.json");
  });

  it("removes leading/trailing hyphens and dots", () => {
    expect(safeRecipeFilename("-hello.")).toBe("hello.json");
    expect(safeRecipeFilename("...test---")).toBe("test.json");
  });

  it("falls back to 'recipe' for empty result", () => {
    expect(safeRecipeFilename("")).toBe("recipe.json");
    expect(safeRecipeFilename("***")).toBe("recipe.json");
  });

  it("truncates long names to 200 chars", () => {
    const longName = "a".repeat(300);
    const result = safeRecipeFilename(longName);
    expect(result).toBe("a".repeat(200) + ".json");
    expect(result.length).toBe(205);
  });

  it("handles CJK characters (preserved since not stripped by diacritic regex)", () => {
    const result = safeRecipeFilename("测试 Recipe");
    expect(result).toBe("测试-recipe.json");
  });

  it("handles pure whitespace input", () => {
    expect(safeRecipeFilename("   ")).toBe("recipe.json");
  });
});
