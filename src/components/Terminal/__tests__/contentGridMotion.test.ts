import { describe, it, expect } from "vitest";
import { readFile } from "fs/promises";
import { resolve } from "path";

const GRID_PATH = resolve(__dirname, "../ContentGrid.tsx");

describe("ContentGrid panel motion (issue #6162)", () => {
  it("does not run a CSS grid-template-columns transition on either grid container", async () => {
    const content = await readFile(GRID_PATH, "utf-8");
    // The CSS transition would fight per-panel framer-motion FLIP. Removed
    // when motion was moved into SortableTerminal / fleet motion.div wrappers.
    expect(content).not.toContain("grid-template-columns ${GRID_TRANSITION_DURATION_MS}");
    expect(content).not.toMatch(/transition:\s*isProjectSwitching/);
  });

  it("imports framer-motion primitives needed for FLIP", async () => {
    const content = await readFile(GRID_PATH, "utf-8");
    expect(content).toContain('from "framer-motion"');
    expect(content).toContain("AnimatePresence");
    expect(content).toContain("LayoutGroup");
    expect(content).toContain("motion");
  });

  it("scopes FLIP coordination per grid via LayoutGroup", async () => {
    const content = await readFile(GRID_PATH, "utf-8");
    expect(content).toContain('LayoutGroup id="main-grid"');
    expect(content).toContain('LayoutGroup id="fleet-grid"');
  });

  it("derives a shared layoutTransition that drops to 0 during project switch", async () => {
    const content = await readFile(GRID_PATH, "utf-8");
    expect(content).toMatch(
      /duration:\s*isProjectSwitching\s*\?\s*0\s*:\s*GRID_TRANSITION_DURATION_MS\s*\/\s*1000/
    );
  });

  it("passes layoutTransition to every SortableTerminal in the main grid", async () => {
    const content = await readFile(GRID_PATH, "utf-8");
    const sortableMatches = content.match(/<SortableTerminal\b/g) ?? [];
    const propMatches = content.match(/layoutTransition=\{layoutTransition\}/g) ?? [];
    expect(sortableMatches.length).toBeGreaterThan(0);
    expect(propMatches.length).toBe(sortableMatches.length);
  });

  it("snaps FLIP translations to integer pixels to avoid xterm canvas blur", async () => {
    const content = await readFile(GRID_PATH, "utf-8");
    expect(content).toContain("pixelSnapTransform");
    expect(content).toContain("Math.round(tx)");
    expect(content).toContain("Math.round(ty)");
    expect(content).toMatch(/transformTemplate=\{pixelSnapTransform\}/);
  });

  it("suppresses xterm resizes for the FLIP window when gridCols changes", async () => {
    const content = await readFile(GRID_PATH, "utf-8");
    expect(content).toContain("prevGridColsRef");
    expect(content).toContain("suppressResizesDuringLayoutTransition");
    // The call must be guarded by both colsChanged and !isProjectSwitching so
    // it doesn't fire during project hydration (preserves #4467) or on pure
    // panel reorders within the same column count.
    expect(content).toMatch(/colsChanged\s*&&\s*!isProjectSwitching/);
    expect(content).toContain("GRID_PLACEHOLDER_ID");
  });

  it("wraps fleet panels in AnimatePresence with initial={false}", async () => {
    const content = await readFile(GRID_PATH, "utf-8");
    expect(content).toContain("<AnimatePresence initial={false}>");
  });
});
