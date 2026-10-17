/**
 * Accent restraint in the sidebar's selection vocabulary (#11992).
 *
 * `sidebar.css` is unlayered, so these rules are decided by source order and a
 * later full-strength rule silently wins over an earlier dimmed one. That makes
 * the cascade itself the thing worth pinning: this reads the stylesheet as text
 * and asserts the ORDER and SHAPE of the accent rules, not their exact values.
 *
 * The rule being defended: an active row shows a full-strength accent edge, but
 * while a control inside it is drawing its own accent focus ring, that edge must
 * recede — two full-strength accent shapes in one frame leave neither reading as
 * the anchor.
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

describe("sidebar selection accent", () => {
  it("dims the active row's accent edge while a control inside it owns the focus ring", () => {
    const offsets = ruleOffsets(
      /\.sidebar-worktree-card\[data-active="true"\](?::not\(\[data-drop-target="true"\]\))?:has\(:focus-visible\)/
    );
    expect(
      offsets.length,
      "expected a rule scoping the active card's edge to the case where a descendant is focus-visible"
    ).toBeGreaterThan(0);

    for (const offset of offsets) {
      const block = blockAt(offset);
      expect(
        /color-mix\([^)]*--theme-accent-primary/.test(block),
        "the focused-descendant rule must use a dimmed (color-mixed) accent, not the full-strength token"
      ).toBe(true);
    }
  });

  it("orders the dimmed rule after the full-strength one so it actually wins", () => {
    // Same specificity would be a coin toss decided by source order, and this
    // file is unlayered — so order is the whole mechanism.
    const base = ruleOffsets(/\.sidebar-worktree-card\[data-active="true"\]\s*\{/);
    const focused = ruleOffsets(
      /\.sidebar-worktree-card\[data-active="true"\](?::not\(\[data-drop-target="true"\]\))?:has\(:focus-visible\)/
    );
    expect(base.length).toBeGreaterThan(0);
    expect(focused.length).toBeGreaterThan(0);
    expect(
      Math.min(...focused),
      "the focused-descendant rule must come after the base active-row rule"
    ).toBeGreaterThan(Math.min(...base));
  });

  it("keeps the selection marker on the right edge in every mode, including forced colors", () => {
    // #9711 round 3, all themes. A left-edge fallback put the marker on the
    // opposite side for exactly the high-contrast users least able to absorb a
    // second, different selection signal.
    const activeRules = ruleOffsets(/\.sidebar-worktree-card\[data-active="true"\]/).map(blockAt);
    expect(activeRules.length).toBeGreaterThan(0);
    for (const block of activeRules) {
      expect(
        /border-left\s*:/.test(block),
        "no active-row rule may mark selection on the left edge"
      ).toBe(false);
      // The inset box-shadow form is a negative x-offset (right edge).
      const inset = block.match(/inset\s+(-?\d+)px\s+0\s+0/);
      if (inset) {
        expect(
          Number(inset[1]),
          "the inset selection marker must sit on the right edge"
        ).toBeLessThan(0);
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
