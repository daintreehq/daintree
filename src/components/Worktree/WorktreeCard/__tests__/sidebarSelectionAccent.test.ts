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

// The rule that steps the active card's edge back while an accent focus ring
// is drawn somewhere in the sidebar. Scoped to the whole sidebar root, since a
// ring on any of its controls competes with the edge, not only one in the row.
const RECEDE_RULE =
  /\.sidebar-root:has\(:focus-visible[^{]*\)\s*\.sidebar-worktree-card\[data-active="true"\]/;

/** Every `inset Xpx 0 0 var(--theme-token)` term in a block, with its x offset. */
function insetEdges(block: string): Array<{ x: number; token: string }> {
  return Array.from(block.matchAll(/inset\s+(-?\d+)px\s+0\s+0\s+var\(--theme-([a-z-]+)\)/g)).map(
    (m) => ({ x: Number(m[1]), token: m[2]! })
  );
}

describe("sidebar selection accent", () => {
  it("steps the active edge to a neutral ink while an accent focus ring shows in the sidebar", () => {
    const offsets = ruleOffsets(RECEDE_RULE);
    expect(
      offsets.length,
      "expected a rule scoping the active card's edge to a focus-visible control in the sidebar"
    ).toBeGreaterThan(0);

    for (const offset of offsets) {
      const edges = insetEdges(blockAt(offset));
      expect(edges.length).toBeGreaterThan(0);
      for (const edge of edges) {
        // Not a faded accent: the stepped edge is a different, neutral token.
        expect(edge.token).not.toBe("accent-primary");
        expect(edge.x, "the stepped edge stays on the right").toBeLessThan(0);
      }
    }
  });

  it("does not step back for the two focus targets that draw no accent ring", () => {
    // The grid's own focus marks its cursor with a neutral edge and the search
    // field's focus is neutral by ruling, so neither is a second accent.
    const selector = CSS.match(RECEDE_RULE)?.[0] ?? "";
    const has =
      selector.match(/:has\((:focus-visible[^{]*?)\)\s*\.sidebar-worktree-card/)?.[1] ?? "";
    expect(has).toContain(':not([role="grid"])');
    expect(has).toContain(":not(input)");
  });

  it("keeps the full-strength accent edge when the sidebar loses focus", () => {
    // Focus spends most of its time in a terminal, so the unfocused sidebar is
    // the state selection is usually read in; a faded accent fell under 3:1.
    expect(CSS).not.toMatch(/\.sidebar-root:not\(:focus-within\)/);
    const activeBlocks = ruleOffsets(/\.sidebar-worktree-card\[data-active="true"\]/).map(blockAt);
    for (const block of activeBlocks) {
      expect(block).not.toMatch(/color-mix\([^)]*--theme-accent-primary/);
    }
  });

  it("orders the stepped rule after the full-strength one so it actually wins", () => {
    // Same specificity would be a coin toss decided by source order, and this
    // file is unlayered — so order is the whole mechanism.
    const base = ruleOffsets(/\.sidebar-worktree-card\[data-active="true"\]\s*\{/);
    const stepped = ruleOffsets(RECEDE_RULE);
    expect(base.length).toBeGreaterThan(0);
    expect(stepped.length).toBeGreaterThan(0);
    expect(
      Math.min(...stepped),
      "the stepped rule must come after the base active-row rule"
    ).toBeGreaterThan(Math.min(...base));
  });

  it("keeps the selection accent on the right edge in every mode, including forced colors", () => {
    // #9711 round 3, all themes. A left-edge fallback put the marker on the
    // opposite side for exactly the high-contrast users least able to absorb a
    // second, different selection signal. The keyboard cursor may now draw on
    // the active card's LEFT edge, but only in the neutral cursor ink; the
    // accent itself never moves off the right.
    const activeRules = ruleOffsets(/\.sidebar-worktree-card\[data-active="true"\]/).map(blockAt);
    expect(activeRules.length).toBeGreaterThan(0);
    for (const block of activeRules) {
      expect(
        /border-left\s*:/.test(block),
        "no active-row rule may mark selection on the left edge"
      ).toBe(false);
      for (const edge of insetEdges(block)) {
        if (edge.token === "accent-primary") {
          expect(edge.x, "the accent selection marker must sit on the right edge").toBeLessThan(0);
        } else if (edge.x > 0) {
          expect(edge.token, "a left edge on the active card is the cursor's neutral ink").toBe(
            "selection-outline"
          );
        }
      }
    }
  });

  it("marks the keyboard cursor on the active card without dropping the accent", () => {
    // Tab often lands the cursor on the active row; with no mark there nothing
    // changed on screen when focus arrived (WCAG 2.4.7).
    const offsets = ruleOffsets(
      /\[data-keyboard-cursor="true"\]\s*\.sidebar-worktree-card(?:\[data-label\])?\[data-active="true"\]/
    );
    expect(offsets.length).toBe(2);
    for (const offset of offsets) {
      const block = blockAt(offset);
      expect(insetEdges(block).some((e) => e.token === "accent-primary" && e.x < 0)).toBe(true);
      // A left edge, or on a labelled card (whose left edge is its colour bar)
      // a perimeter, in the cursor's neutral ink.
      expect(block).toContain("var(--theme-selection-outline)");
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
