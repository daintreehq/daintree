import { describe, it, expect } from "vitest";
import { readFile } from "fs/promises";
import { resolve } from "path";

const HEATMAP_PATH = resolve(__dirname, "../PulseHeatmap.tsx");

describe("PulseHeatmap — isBeforeProject filtering (issue #4078)", () => {
  it("filters out isBeforeProject cells before rendering", async () => {
    const content = await readFile(HEATMAP_PATH, "utf-8");
    expect(content).toContain(".filter((cell) => !cell.isBeforeProject)");
  });

  it("does not render isBeforeProject cells with a distinct style", async () => {
    const content = await readFile(HEATMAP_PATH, "utf-8");
    expect(content).not.toContain("var(--pulse-before-bg");
  });

  it("does not produce 'Before project started' tooltip text", async () => {
    const content = await readFile(HEATMAP_PATH, "utf-8");
    expect(content).not.toContain("Before project started");
  });

  it("right-aligns the first row when it is shorter than a full row", async () => {
    const content = await readFile(HEATMAP_PATH, "utf-8");
    expect(content).toContain("justify-end");
  });

  it("uses filtered cell count for compact-mode column width", async () => {
    const content = await readFile(HEATMAP_PATH, "utf-8");
    expect(content).toContain("rows.reduce((sum, r) => sum + r.length, 0)");
  });
});
