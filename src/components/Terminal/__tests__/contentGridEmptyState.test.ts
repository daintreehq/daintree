import { describe, it, expect } from "vitest";
import { readFile } from "fs/promises";
import { resolve } from "path";

const GRID_PATH = resolve(__dirname, "../ContentGrid.tsx");

describe("ContentGrid EmptyState — polish (issue #4406)", () => {
  it("hero section uses reduced spacing (mb-6 / mb-4)", async () => {
    const content = await readFile(GRID_PATH, "utf-8");
    // Hero wrapper
    expect(content).toContain('"mb-6 flex flex-col items-center text-center"');
    // Icon container
    expect(content).toContain('"relative group mb-4"');
  });

  it("recipe summary is conditionally rendered to avoid duplicating name", async () => {
    const content = await readFile(GRID_PATH, "utf-8");
    expect(content).toContain("recipeSummary !== recipe.name");
    expect(content).toContain("recipeSummary &&");
  });

  it("tip text uses /70 opacity, not /60", async () => {
    const content = await readFile(GRID_PATH, "utf-8");
    expect(content).toContain("text-canopy-text/70 text-center");
    // The tip <p> should not use /60
    expect(content).not.toContain("text-canopy-text/60 text-center");
  });

  it("recipe list uses aria-label instead of heading element", async () => {
    const content = await readFile(GRID_PATH, "utf-8");
    // The redesigned compact list uses role="list" with aria-label instead of an <h4> heading
    expect(content).toContain('role="list"');
    expect(content).toContain('aria-label="Recipes"');
    // No <h4> recipes heading should exist
    const headingMatch = content.match(/<h4[^>]*>[\s\S]*?Recipes[\s\S]*?<\/h4>/);
    expect(headingMatch).toBeNull();
  });
});
