import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

const TERMINAL_DOCK_PATH = path.resolve(__dirname, "../TerminalDockRegion.tsx");

// Regression coverage for #9527: an empty dock was made `inert`, which killed
// pointer events and focus across the whole region — including the always-
// rendered launch button and right-click menu in ContentDock. The fix swaps
// `inert` for a conditional landmark role so the empty dock stays interactive
// while still hiding the dead-end landmark from screen readers.
describe("TerminalDockRegion — empty dock interactivity (#9527)", () => {
  let source: string;
  beforeEach(async () => {
    source = await fs.readFile(TERMINAL_DOCK_PATH, "utf-8");
  });

  it("never inerts the dock region", () => {
    // `inert` is a DOM-level kill switch with no CSS escape hatch for children,
    // so it cannot be used while keeping the launch button interactive. Match
    // the JSX attribute form so the explanatory comment above it is allowed.
    expect(source).not.toMatch(/inert=/);
  });

  it("conditionally drops the landmark role when the dock is empty", () => {
    expect(source).toMatch(/role=\{shouldInertDock \? "none" : "region"\}/);
  });

  it("drops the landmark name in lockstep with the role", () => {
    // role="none" with a stale aria-label is contradictory; the name must be
    // removed atomically with the role.
    expect(source).toMatch(/aria-label=\{shouldInertDock \? undefined : "Dock"\}/);
  });

  it("keeps tabIndex=-1 so macroFocusStore can programmatically focus the region", () => {
    expect(source).toMatch(/tabIndex=\{-1\}/);
  });

  it("preserves the empty-dock guard derivation", () => {
    expect(source).toMatch(/const shouldInertDock = !hasDocked && !hasStatus;/);
  });

  it("keeps the macro-focus visibility gate keyed on hasDocked only", () => {
    // This is the independent keyboard macro-nav guard that excludes an empty
    // dock from region cycling — it must stay keyed on hasDocked, not hasStatus.
    expect(source).toMatch(/setVisibility\("dock", hasDocked\)/);
  });
});
