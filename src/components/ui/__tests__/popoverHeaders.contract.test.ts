import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  POPOVER_HEADER_ACTION_CLASS,
  POPOVER_HEADER_CLASS,
  POPOVER_ROW_HOVER_CLASS,
  POPOVER_TITLE_CLASS,
} from "../popoverHeader";
import {
  DOCK_POPOVER_HEADER_CLASS,
  DOCK_POPOVER_ROW_HOVER_CLASS,
} from "@/components/Layout/dockStatusPill";
import {
  HEADER_CHIP_SURFACE,
  HEADER_CHIP_TRIGGER_CLASS,
} from "@/components/Terminal/terminalHeaderChip";

const ROOT = path.resolve(__dirname, "../../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const tokens = (s: string) => s.split(/\s+/).filter(Boolean);

/**
 * Popovers whose header is a title strip. Each renders it from the shared
 * constants instead of spelling its own padding, rule and title ink, which is
 * how the family drifted to six paddings and three title inks. A new titled
 * popover belongs here.
 */
const TITLED_POPOVER_FILES = [
  "src/components/Terminal/SubagentChip.tsx",
  "src/components/Terminal/FindCodexSessionAction.tsx",
  "src/components/Terminal/TerminalNotifyChip.tsx",
  "src/components/HelpPanel/RecentCallsPopover.tsx",
  "src/components/Fleet/FleetCountChip.tsx",
];

/** Every popover this family covers, titled or not: the rules below hold in all of them. */
const POPOVER_FILES = [
  ...TITLED_POPOVER_FILES,
  "src/components/Worktree/ReviewHub/PrChecksPopover.tsx",
  "src/components/Layout/LocalCommitsDropdown.tsx",
  "src/components/Worktree/WorktreeFilterPopover.tsx",
  "src/components/Project/ProjectIdentityEditor.tsx",
  "src/components/Fleet/FleetPickerContent.tsx",
  "src/components/EventInspector/EventFilters.tsx",
];

/** Pane-header chips that open a popover. */
const HEADER_CHIP_TRIGGER_FILES = [
  "src/components/Terminal/SubagentChip.tsx",
  "src/components/Terminal/TerminalNotifyChip.tsx",
];

/** Surfaces whose small icon buttons were hand-rolled 24px boxes. */
const ICON_BUTTON_FILES = [
  "src/components/Terminal/SubagentChip.tsx",
  "src/components/Terminal/FindCodexSessionAction.tsx",
  "src/components/Notifications/NotificationCenterEntry.tsx",
  "src/components/HelpPanel/HelpSessionTabs.tsx",
  "src/components/Panel/PanelHeader.tsx",
];

/** Popover lists whose row hover is the neutral ladder's first step. */
const ROW_HOVER_FILES = [
  "src/components/Fleet/FleetCountChip.tsx",
  "src/components/Fleet/FleetPickerContent.tsx",
  "src/components/HelpPanel/RecentCallsPopover.tsx",
  "src/components/EventInspector/EventFilters.tsx",
];

describe("popover header contract", () => {
  it("the header strip is padding and a divider, with no fill of its own", () => {
    const cls = tokens(POPOVER_HEADER_CLASS);
    expect(cls).toEqual(expect.arrayContaining(["px-3", "py-2", "border-b", "border-divider"]));
    expect(cls.some((t) => /^bg-/.test(t))).toBe(false);
  });

  it("the title is quieter than the content it names", () => {
    const cls = tokens(POPOVER_TITLE_CLASS);
    expect(cls).toContain("text-text-secondary");
    expect(cls).not.toContain("text-text-primary");
  });

  it("the dock status popovers use the same strip and row hover as every other popover", () => {
    expect(DOCK_POPOVER_HEADER_CLASS).toBe(POPOVER_HEADER_CLASS);
    expect(DOCK_POPOVER_ROW_HOVER_CLASS).toBe(POPOVER_ROW_HOVER_CLASS);
  });

  it("every titled popover renders its strip and title from the shared constants", () => {
    const offenders = TITLED_POPOVER_FILES.filter((rel) => {
      const src = read(rel);
      return (
        !/className=\{(cn\()?POPOVER_HEADER_CLASS\b/.test(src) ||
        !/className=\{POPOVER_TITLE_CLASS\}/.test(src)
      );
    });
    expect(offenders).toEqual([]);
  });

  it("no popover in the family spells its own rule token or a stray header inset", () => {
    for (const rel of POPOVER_FILES) {
      const src = read(rel);
      // The divider is `border-divider`; the arbitrary-value spelling and the
      // heavier border ramp both drifted in as header and footer rules.
      expect(src, rel).not.toMatch(/border-\[var\(--border-divider\)\]/);
      expect(src, rel).not.toMatch(/border-[bt] border-border-default\b/);
      expect(src, rel).not.toMatch(/\b(?:border|divide)-border-subtle\b|border-daintree-border/);
      // Title strips are `py-2`; a split `pt-2.5 pb-*` was the drift.
      expect(src, rel).not.toMatch(/\bpt-2\.5 pb-/);
    }
  });

  it("chips that open a popover share one hover fill and keep it while open", () => {
    const cls = tokens(HEADER_CHIP_TRIGGER_CLASS);
    const hoverFill = cls.find((t) => /^hover:bg-/.test(t));
    expect(hoverFill).toBeDefined();
    // The lift has to be a step above the chip's resting surface to be seen.
    const rest = tokens(HEADER_CHIP_SURFACE).find((t) => /^bg-/.test(t));
    expect(hoverFill!.replace(/^hover:/, "")).not.toBe(rest);
    expect(cls).toContain(hoverFill!.replace(/^hover:/, "aria-expanded:"));
    for (const rel of HEADER_CHIP_TRIGGER_FILES) {
      const chips = [...read(rel).matchAll(/cn\(\s*HEADER_CHIP_CLASS,[\s\S]*?\n\s*\)/g)].map(
        (m) => m[0]
      );
      expect(chips.length, rel).toBeGreaterThan(0);
      for (const chip of chips) {
        expect(chip, rel).toContain("HEADER_CHIP_TRIGGER_CLASS");
        // The fill is the shared class's; a local one is how the two chips split.
        expect(chip, rel).not.toMatch(/hover:bg-/);
      }
    }
  });

  it("header strip icon buttons keep the strip at its title height", () => {
    const cls = tokens(POPOVER_HEADER_ACTION_CLASS);
    expect(cls).toContain("-my-1");
  });

  it("small icon buttons are the Button primitive, never a hand-rolled 24px box", () => {
    for (const rel of ICON_BUTTON_FILES) {
      const src = read(rel);
      const handRolled = [
        ...src.matchAll(/<button\b[^>]*?className=(?:"([^"]*)"|\{[^}]*?"([^"]*)")/gs),
      ]
        .map((m) => m[1] ?? m[2] ?? "")
        .filter((cls) => /\bh-6\b/.test(cls) && /\bw-6\b/.test(cls));
      expect(handRolled, rel).toEqual([]);
      expect(src, rel).not.toMatch(/\bw-6 h-6\b|\bh-6 w-6\b/);
    }
  });

  it("popover rows hover on the neutral ladder's first step, not a tint or a heavier step", () => {
    for (const rel of ROW_HOVER_FILES) {
      const src = read(rel);
      expect(src, rel).toContain("POPOVER_ROW_HOVER_CLASS");
      expect(src, rel).not.toMatch(/hover:bg-tint\/\[0\.0[0-9]\]/);
    }
    for (const rel of [
      "src/components/HelpPanel/RecentCallsPopover.tsx",
      "src/components/EventInspector/EventFilters.tsx",
    ]) {
      expect(read(rel), rel).not.toMatch(/hover:bg-overlay-soft/);
    }
  });

  it("an empty popover list is an EmptyState, not a hand-set sentence", () => {
    for (const rel of [
      "src/components/Fleet/FleetCountChip.tsx",
      "src/components/Terminal/FindCodexSessionAction.tsx",
      "src/components/Terminal/SubagentChip.tsx",
      "src/components/HelpPanel/RecentCallsPopover.tsx",
      "src/components/EventInspector/EventFilters.tsx",
    ]) {
      const src = read(rel);
      expect(src, rel).toContain("<EmptyState");
      expect(src, rel).not.toMatch(
        /<p\b[^>]*>\s*(No (other|messages|events)|None|Ask the assistant)[^<]*<\/p>/
      );
    }
  });

  it("a list that is loading shows its rows' shape, not a spinner and a sentence", () => {
    const src = read("src/components/Terminal/FindCodexSessionAction.tsx");
    expect(src).toContain("<Skeleton");
    expect(src).not.toMatch(/<Spinner\b/);
  });
});
