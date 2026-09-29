import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DOCK_CHIP_CLASS, DOCK_CHIP_OPEN_CLASS, DOCK_STATE_GLYPH_CLASS } from "../dockChipStyles";
import { DOCK_STATUS_PILL_CLASS, DOCK_STATUS_PILL_OPEN_CLASS } from "../dockStatusPill";

/**
 * The dock is one family: the worktree's chips, the project's status pills,
 * and the four status popovers. These are the rules that keep it one family,
 * stated as rules rather than as today's class names.
 */

const LAYOUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.resolve(LAYOUT, "../..");
const read = (file: string) => fs.readFileSync(path.join(LAYOUT, file), "utf8");

const CHIPS = ["DockedTerminalItem.tsx", "DockedTabGroup.tsx", "DockedNonPtyPanelItem.tsx"];
const POPOVERS = [
  "WaitingContainer.tsx",
  "BackgroundContainer.tsx",
  "StatusContainer.tsx",
  "TrashContainer.tsx",
];
const POPOVER_ROWS = [...POPOVERS, "TrashBinItem.tsx", "TrashGroupItem.tsx"];

const utilities = (classes: string) => classes.split(/\s+/).filter(Boolean);
const fillsOf = (classes: string, variant = "") =>
  utilities(classes).filter((u) => u.startsWith(`${variant}bg-`));

describe("dock chips", () => {
  it("spell their surface once, in the shared constants", () => {
    for (const file of CHIPS) {
      const source = read(file);
      expect(source, file).toContain("DOCK_CHIP_CLASS");
      expect(source, file).toContain("DOCK_CHIP_OPEN_CLASS");
      expect(source, `${file} respells the open state`).not.toMatch(/--dock-item-bg-active/);
      expect(source, `${file} respells the chip surface`).not.toMatch(/--dock-item-bg-hover/);
    }
  });

  it("open is a neutral lift: no ring, and nothing accent in the class or its token defaults", () => {
    expect(utilities(DOCK_CHIP_OPEN_CLASS).some((u) => /(^|:)ring/.test(u))).toBe(false);
    expect(DOCK_CHIP_OPEN_CLASS).not.toMatch(/accent/);

    const css = fs.readFileSync(path.join(SRC, "index.css"), "utf8");
    for (const token of ["--dock-item-bg-active", "--dock-item-border-active"]) {
      const declaration = css.match(new RegExp(`${token}:\\s*([^;]+);`));
      expect(declaration, token).not.toBeNull();
      expect(declaration![1], token).not.toMatch(/accent/);
    }
  });

  it("chip and pill hover lift to the same fill", () => {
    expect(fillsOf(DOCK_CHIP_CLASS, "hover:")).toEqual(fillsOf(DOCK_STATUS_PILL_CLASS, "hover:"));
  });

  it("an open chip or pill keeps its open fill while pointed at", () => {
    for (const open of [DOCK_CHIP_OPEN_CLASS, DOCK_STATUS_PILL_OPEN_CLASS]) {
      const rest = fillsOf(open);
      expect(rest.length, open).toBeGreaterThan(0);
      expect(fillsOf(open, "hover:"), open).toEqual(rest.map((fill) => `hover:${fill}`));
    }
  });

  it("draw the agent-state glyph at the size the tab strip draws it", () => {
    const sizes = (classes: string) =>
      utilities(classes)
        .filter((u) => /^[wh]-/.test(u))
        .sort();
    const tabButton = fs.readFileSync(path.join(SRC, "components/Panel/TabButton.tsx"), "utf8");
    const tabGlyphs = Array.from(
      tabButton.matchAll(/<StateIcon\s+className=\{cn\(\s*"([^"]+)"/g),
      (m) => sizes(m[1]!)
    );
    expect(tabGlyphs.length).toBeGreaterThan(0);
    for (const glyph of tabGlyphs) expect(glyph).toEqual(sizes(DOCK_STATE_GLYPH_CLASS));

    // Every state or activity glyph in the dock's chips takes the shared size.
    for (const file of ["DockedTerminalItem.tsx", "DockedTabGroup.tsx", "DockActivityCue.tsx"]) {
      const glyphs = Array.from(
        read(file).matchAll(/<(StateIcon|SpinnerCircle|CheckCircle2)\s+className=\{([^}]+)\}/g),
        (m) => m[2]!
      );
      expect(glyphs.length, file).toBeGreaterThan(0);
      for (const className of glyphs) expect(className, file).toContain("DOCK_STATE_GLYPH_CLASS");
    }
  });
});

describe("dock status popovers", () => {
  it("share one header, one scrolling list, and one row hover", () => {
    for (const file of POPOVERS) {
      const source = read(file);
      expect(source, file).toContain("DOCK_POPOVER_HEADER_CLASS");
      expect(source, file).toMatch(/<DockPopoverList\b/);
      expect(source, `${file} caps its own list height`).not.toMatch(/max-h-\[/);
      expect(source, `${file} paints its own header strip`).not.toMatch(/bg-surface-canvas\//);
    }
    for (const file of POPOVER_ROWS) {
      const source = read(file);
      expect(source, `${file} spells its own row hover`).not.toMatch(/hover:bg-tint/);
      expect(source, `${file} spells its own row focus fill`).not.toMatch(/focus-visible:bg-/);
      if (source.includes("data-dock-row")) {
        expect(source, file).toContain("DOCK_POPOVER_ROW_HOVER_CLASS");
      }
    }
  });

  it("every popover's rows join the keyboard model and every pill opens into it", () => {
    for (const file of POPOVERS) {
      const source = read(file);
      expect(source, file).toContain("focusHandoff.onTriggerClick");
      expect(source, file).toContain("focusHandoff.onOpenAutoFocus");
      expect(source, file).toContain("focusHandoff.onContentKeyDown");
    }
    for (const file of [
      "WaitingContainer.tsx",
      "BackgroundContainer.tsx",
      "StatusContainer.tsx",
      "TrashBinItem.tsx",
      "TrashGroupItem.tsx",
    ]) {
      expect(read(file), file).toMatch(/data-dock-row=""/);
    }
  });
});
