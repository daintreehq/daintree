/**
 * Accent restraint in the sidebar's selection vocabulary (#11992).
 *
 * `sidebar.css` is unlayered, so these rules are decided by source order and a
 * later full-strength rule silently wins over an earlier dimmed one. That makes
 * the cascade itself the thing worth pinning: this reads the stylesheet as text
 * and asserts the ORDER and SHAPE of the accent rules, not their exact values.
 *
 * The rule being defended: an active row shows a full-strength accent edge, but
 * while any control in the sidebar is drawing its own accent focus ring, that
 * edge must recede to a neutral ink — two full-strength accent shapes in one
 * frame leave neither reading as the anchor.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import {
  BUILT_IN_APP_SCHEMES,
  blendOverBackground,
  contrastRatio,
  parseRgba,
} from "../../../../../shared/theme/index.js";
import type { AppThemeTokenKey } from "../../../../../shared/theme/index.js";

const CSS = readFileSync(
  path.resolve(__dirname, "../../../../styles/components/sidebar.css"),
  "utf8"
);

/** Source offsets of every rule whose selector matches `pattern`. */
function ruleOffsets(pattern: RegExp): number[] {
  const offsets: number[] = [];
  const re = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g"
  );
  for (const match of CSS.matchAll(re)) {
    if (match.index !== undefined) offsets.push(match.index);
  }
  return offsets;
}

/** The declaration block that starts at `offset`. */
function blockAt(offset: number): string {
  const open = CSS.indexOf("{", offset);
  const close = CSS.indexOf("}", open);
  return CSS.slice(open + 1, close);
}

// The receded edge is scoped to the whole sidebar: a ring on any of its
// controls is a second accent in front of the user, not only one inside the row.
const FOCUSED_ACTIVE =
  /\.sidebar-root:has\(:focus-visible[^{]*?\)\s+\.sidebar-worktree-card\[data-active="true"\](?::not\(\[data-drop-target="true"\]\))?\s*\{/;

/** Every `inset Xpx 0 0 <colour>` edge in a declaration block. */
function insetEdges(block: string): { x: number; colour: string }[] {
  return [...block.matchAll(/inset\s+(-?\d+)px\s+0\s+0\s+([^,;]+)/g)].map((m) => ({
    x: Number(m[1]),
    colour: m[2]!.trim(),
  }));
}

describe("sidebar selection accent", () => {
  it("recedes the active row's accent edge while a sidebar control owns the focus ring", () => {
    const offsets = ruleOffsets(FOCUSED_ACTIVE);
    expect(
      offsets.length,
      "expected a rule scoping the active card's edge to the case where a sidebar control is focus-visible"
    ).toBeGreaterThan(0);

    for (const offset of offsets) {
      const edges = insetEdges(blockAt(offset));
      expect(edges.length, "the focused rule must still draw a selection edge").toBeGreaterThan(0);
      for (const { colour } of edges) {
        expect(
          colour.includes("--theme-accent-primary"),
          `the focused rule must recede to a neutral edge, not the accent (got ${colour})`
        ).toBe(false);
      }
    }
  });

  it("orders the receded rule after the full-strength one so it actually wins", () => {
    // Same specificity would be a coin toss decided by source order, and this
    // file is unlayered — so order is the whole mechanism.
    const base = ruleOffsets(/\.sidebar-worktree-card\[data-active="true"\]\s*\{/);
    const focused = ruleOffsets(FOCUSED_ACTIVE);
    expect(base.length).toBeGreaterThan(0);
    expect(focused.length).toBeGreaterThan(0);
    expect(
      Math.min(...focused),
      "the focused rule must come after the base active-row rule"
    ).toBeGreaterThan(Math.min(...base));
  });

  it("keeps the selection marker on the right edge in every mode, including forced colors", () => {
    // #9711 round 3, all themes. A left-edge fallback put the marker on the
    // opposite side for exactly the high-contrast users least able to absorb a
    // second, different selection signal. The keyboard cursor's neutral
    // `selection-outline` edge is the one mark allowed on the left: it is the
    // cursor, not the selection.
    const activeRules = ruleOffsets(/\.sidebar-worktree-card\[data-active="true"\]/).map(blockAt);
    expect(activeRules.length).toBeGreaterThan(0);
    for (const block of activeRules) {
      expect(
        /border-left\s*:/.test(block),
        "no active-row rule may mark selection on the left edge"
      ).toBe(false);
      for (const { x, colour } of insetEdges(block)) {
        if (colour.includes("--theme-selection-outline")) continue;
        expect(x, `the inset selection marker (${colour}) must sit on the right edge`).toBeLessThan(
          0
        );
      }
    }
  });
});

/**
 * The sidebar's keyboard cursor is marked by a 2px left inset edge, and it is
 * the only mark a keyboard user has there: the row's focus ring is suppressed
 * and hover reveals the same toolbar. So the edge owes WCAG 1.4.11's 3:1 on
 * every built-in theme.
 *
 * This reads whichever theme token the rule names and measures it, rather
 * than pinning the token: any ink that clears 3:1 everywhere passes.
 */
function keyboardCursorEdgeToken(): AppThemeTokenKey {
  const selector = CSS.indexOf('[data-keyboard-cursor="true"]\n  .sidebar-worktree-card');
  expect(selector, "keyboard-cursor card rule not found in sidebar.css").toBeGreaterThan(-1);
  const block = CSS.slice(CSS.indexOf("{", selector), CSS.indexOf("}", selector));
  const match = block.match(/--card-edge:\s*inset 2px 0 0 var\(--theme-([a-z-]+)\)/);
  expect(match, "keyboard-cursor edge must be a single theme token").not.toBeNull();
  return match![1] as AppThemeTokenKey;
}

describe("sidebar keyboard cursor edge", () => {
  const key = keyboardCursorEdgeToken();

  it.each(BUILT_IN_APP_SCHEMES.map((s) => [s.id, s] as const))(
    "clears 3:1 on the sidebar in %s",
    (_, scheme) => {
      const ink = scheme.tokens[key];
      const bg = scheme.tokens["surface-sidebar"];
      const alpha = parseRgba(ink);
      const painted = alpha ? blendOverBackground(alpha.hex, bg, alpha.opacity) : ink;
      const ratio = contrastRatio(painted, bg);
      expect(
        ratio,
        `${scheme.id} ${key} (${ink}) is ${ratio.toFixed(2)}:1 on ${bg}`
      ).toBeGreaterThanOrEqual(3);
    }
  );
});
