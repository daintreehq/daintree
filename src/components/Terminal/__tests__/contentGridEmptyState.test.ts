import { describe, it, expect } from "vitest";
import { readFile } from "fs/promises";
import { resolve } from "path";

const GRID_PATH = resolve(__dirname, "../ContentGrid.tsx");

describe("ContentGrid EmptyState — RecipeRunner integration", () => {
  it("hero section uses reduced spacing (mb-6 / mb-4)", async () => {
    const content = await readFile(GRID_PATH, "utf-8");
    expect(content).toContain('"mb-6 flex flex-col items-center text-center"');
    expect(content).toContain('"relative group mb-4"');
  });

  it("tip text uses /70 opacity, not /60", async () => {
    const content = await readFile(GRID_PATH, "utf-8");
    expect(content).toContain("text-daintree-text/70 text-center");
    expect(content).not.toContain("text-daintree-text/60 text-center");
  });

  it("renders RecipeRunner component instead of inline recipe list", async () => {
    const content = await readFile(GRID_PATH, "utf-8");
    expect(content).toContain("<RecipeRunner");
    expect(content).toContain('from "./RecipeRunner/RecipeRunner"');
    // No inline recipe list markup should remain
    expect(content).not.toContain('role="list"');
    expect(content).not.toContain("handleRunRecipe");
  });
});
