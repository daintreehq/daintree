import { describe, it, expect } from "vitest";
import { readFile } from "fs/promises";
import { resolve } from "path";

const CONTEXT_PATH = resolve(__dirname, "../useContentGridContext.tsx");
const FLEET_SCOPE_PATH = resolve(__dirname, "../ContentGridFleetScope.tsx");
const DEFAULT_PATH = resolve(__dirname, "../ContentGridDefault.tsx");

describe("ContentGrid panel motion (issue #6162)", () => {
  it("does not run a CSS grid-template-columns transition on either grid container", async () => {
    const fleetContent = await readFile(FLEET_SCOPE_PATH, "utf-8");
    const defaultContent = await readFile(DEFAULT_PATH, "utf-8");
    // The CSS transition would fight per-panel framer-motion FLIP. Removed
    // when motion was moved into SortableTerminal / fleet motion.div wrappers.
    expect(fleetContent).not.toContain("grid-template-columns ${GRID_TRANSITION_DURATION_MS}");
    expect(defaultContent).not.toContain("grid-template-columns ${GRID_TRANSITION_DURATION_MS}");
    expect(fleetContent).not.toMatch(/transition:\s*isProjectSwitching/);
    expect(defaultContent).not.toMatch(/transition:\s*isProjectSwitching/);
  });

  it("imports framer-motion primitives needed for FLIP", async () => {
    const fleetContent = await readFile(FLEET_SCOPE_PATH, "utf-8");
    const defaultContent = await readFile(DEFAULT_PATH, "utf-8");
    expect(fleetContent).toContain('from "framer-motion"');
    expect(fleetContent).toContain("AnimatePresence");
    expect(fleetContent).toContain("LayoutGroup");
    expect(defaultContent).toContain('from "framer-motion"');
    expect(defaultContent).toContain("LayoutGroup");
    expect(fleetContent).toContain("<m.div");
    expect(fleetContent).not.toMatch(/<motion\./);
    expect(defaultContent).not.toMatch(/<motion\./);
  });

  it("scopes FLIP coordination per grid via LayoutGroup", async () => {
    const fleetContent = await readFile(FLEET_SCOPE_PATH, "utf-8");
    const defaultContent = await readFile(DEFAULT_PATH, "utf-8");
    expect(defaultContent).toContain('LayoutGroup id="main-grid"');
    expect(fleetContent).toContain('LayoutGroup id="fleet-grid"');
  });

  it("derives a shared layoutTransition that drops to 0 during project switch", async () => {
    const content = await readFile(CONTEXT_PATH, "utf-8");
    expect(content).toMatch(
      /duration:\s*isProjectSwitching\s*\?\s*0\s*:\s*GRID_TRANSITION_DURATION_MS\s*\/\s*1000/
    );
  });

  it("passes layoutTransition to every SortableTerminal in the main grid", async () => {
    const content = await readFile(DEFAULT_PATH, "utf-8");
    const sortableMatches = content.match(/<SortableTerminal\b/g) ?? [];
    const propMatches = content.match(/layoutTransition=\{ctx\.layoutTransition\}/g) ?? [];
    expect(sortableMatches.length).toBeGreaterThan(0);
    expect(propMatches.length).toBe(sortableMatches.length);
  });

  it("snaps FLIP translations to integer pixels to avoid xterm canvas blur", async () => {
    const content = await readFile(CONTEXT_PATH, "utf-8");
    expect(content).toContain("pixelSnapTransform");
    expect(content).toContain("Math.round(tx)");
    expect(content).toContain("Math.round(ty)");
    // pixelSnapTransform is exported and used in fleet scope
    const fleetContent = await readFile(FLEET_SCOPE_PATH, "utf-8");
    expect(fleetContent).toMatch(/transformTemplate=\{pixelSnapTransform\}/);
  });

  it("suppresses xterm resizes for the FLIP window when gridCols changes", async () => {
    const content = await readFile(CONTEXT_PATH, "utf-8");
    expect(content).toContain("prevGridColsRef");
    expect(content).toContain("suppressResizesDuringLayoutTransition");
    expect(content).toMatch(/colsChanged\s*&&\s*!isProjectSwitching/);
    expect(content).toContain("GRID_PLACEHOLDER_ID");
  });

  it("wraps fleet panels in AnimatePresence with initial={false}", async () => {
    const content = await readFile(FLEET_SCOPE_PATH, "utf-8");
    expect(content).toContain("<AnimatePresence initial={false}>");
  });
});
