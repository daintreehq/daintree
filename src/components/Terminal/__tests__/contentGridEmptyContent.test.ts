import { describe, it, expect } from "vitest";
import { readFile } from "fs/promises";
import { resolve } from "path";

const GRID_PATH = resolve(__dirname, "../ContentGrid.tsx");

describe("ContentGrid emptyContent prop (issue #4254)", () => {
  it("ContentGridProps includes emptyContent prop", async () => {
    const content = await readFile(GRID_PATH, "utf-8");
    expect(content).toContain("emptyContent?: React.ReactNode");
  });

  it("renders emptyContent instead of EmptyState when provided", async () => {
    const content = await readFile(GRID_PATH, "utf-8");
    // The grid should use nullish coalescing to prefer emptyContent over EmptyState
    expect(content).toContain("emptyContent ?? (");
    expect(content).toContain("<EmptyState");
  });

  it("destructures emptyContent from props", async () => {
    const content = await readFile(GRID_PATH, "utf-8");
    expect(content).toMatch(/\{\s*className.*emptyContent.*\}\s*:\s*ContentGridProps/s);
  });
});
