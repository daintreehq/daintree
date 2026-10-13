import { describe, it, expect } from "vitest";
import { safeRecipeFilename } from "../recipeFilename.js";

describe("safeRecipeFilename", () => {
  it("removes leading/trailing hyphens and dots", () => {
    expect(safeRecipeFilename("-hello.")).toBe("hello.json");
    expect(safeRecipeFilename("...test---")).toBe("test.json");
  });

  it("handles CJK characters (preserved since not stripped by diacritic regex)", () => {
    const result = safeRecipeFilename("测试 Recipe");
    expect(result).toBe("测试-recipe.json");
  });
});
