import { describe, expect, it } from "vitest";
import { BUILT_IN_APP_SCHEMES } from "@shared/theme/themes";
import { blendOverBackground, contrastRatio, parseRgba } from "@shared/theme/contrast";
import { CHOICE_SELECTED, CHOICE_UNSELECTED } from "../RadioChoice";

/**
 * A choice card's row is the click target, so its edge is the affordance: on a
 * dark theme the ladder's `border-default` (1.1-1.3:1) and `border-strong`
 * (1.2-1.6:1) leave the options reading as loose radios beside their labels
 * (#17891). Every edge the card paints has to clear the 3:1 non-text floor
 * against the surface around it and the fill inside it, in every built-in
 * theme, in neutral ink.
 *
 * Read off the class strings rather than restated here, so swapping an edge for
 * a quieter token or adding a hover step that dims it fails this on its own.
 */

// Width (`border-2`), style (`border-dashed`) and side (`border-t`) utilities
// share the `border-` prefix with colour ones; only a colour names a theme token.
const NON_COLOUR_EDGE = /^(?:\d+|solid|dashed|dotted|double|hidden|none|[xyselrtb](?:-\d+)?)$/;

// A neutral ink is a border token, the indicator ink, or the text ink the
// increased-contrast step borrows; accent and status hues are not.
const NEUTRAL_INK = /^(?:border-[a-z]+|selection-outline|text-primary|text-secondary)$/;

/** Splits `hover:contrast-more:border-x` at the last `:` outside any `[...]`. */
function splitVariant(utility: string): { variant: string; base: string } {
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < utility.length; i++) {
    const ch = utility[i];
    if (ch === "[") depth++;
    else if (ch === "]") depth--;
    else if (ch === ":" && depth === 0) cut = i;
  }
  return { variant: utility.slice(0, cut + 1), base: utility.slice(cut + 1) };
}

function edgeInks(classes: string): Array<{ variant: string; token: string }> {
  const inks: Array<{ variant: string; token: string }> = [];
  for (const utility of classes.split(/\s+/)) {
    const { variant, base } = splitVariant(utility);
    const match = base.match(/^border-(.+)$/);
    if (!match || NON_COLOUR_EDGE.test(match[1]!)) continue;
    expect(
      match[1],
      `${utility}: an arbitrary or slash-alpha edge cannot be measured against a surface`
    ).toMatch(/^[a-z-]+$/);
    // `border-border-input` names the `border-input` token and
    // `border-selection-outline` names `selection-outline`.
    inks.push({ variant, token: match[1]! });
  }
  return inks;
}

const over = (value: string, backdrop: string) => {
  const rgba = parseRgba(value);
  return rgba ? blendOverBackground(rgba.hex, backdrop, rgba.opacity) : value;
};

// A card sits in a dialog (panel on dark, elevated on light), a settings page
// or a popover, so it is held against both panel planes.
const SURFACES = ["surface-panel", "surface-panel-elevated"] as const;
const EDGE_MIN_CONTRAST = 3;

// What is painted inside the border box for each state an edge appears in. The
// resting card is unfilled; hover and selected lay their wash under the edge.
const FILL_UNDER_EDGE: Record<string, string | null> = {
  "": null,
  "hover:": "overlay-soft",
};

describe("RadioChoice card edges", () => {
  const unselected = edgeInks(CHOICE_UNSELECTED);
  const selected = edgeInks(CHOICE_SELECTED);

  it("paints each state's edge in a neutral token", () => {
    expect(unselected.filter((e) => e.variant === "")).toHaveLength(1);
    expect(selected.filter((e) => e.variant === "")).toHaveLength(1);
    for (const { token } of [...unselected, ...selected]) expect(token).toMatch(NEUTRAL_INK);
  });

  it("only varies an edge by a state this test measures", () => {
    for (const { variant } of unselected) expect(Object.keys(FILL_UNDER_EDGE)).toContain(variant);
    // `contrast-more:` rebinds `border-input` and the text inks app-wide, so it
    // is measured as the ink it names; the tokens it rebinds are theme-resolved.
    for (const { variant } of selected) expect(["", "contrast-more:"]).toContain(variant);
  });

  const cases = [
    ...unselected.map((e) => ({
      state: "resting",
      ...e,
      fill: FILL_UNDER_EDGE[e.variant] ?? null,
    })),
    ...selected.map((e) => ({ state: "selected", ...e, fill: "overlay-selected" })),
  ];

  for (const { state, variant, token, fill: fillToken } of cases) {
    const label = variant ? `${state} ${variant.replace(/:$/, "")}` : state;

    it.each(BUILT_IN_APP_SCHEMES)(`holds the ${label} edge (${token}) at 3:1 on $id`, (scheme) => {
      const tokens = scheme.tokens as Record<string, string>;
      const ink = tokens[token];
      expect(ink, `${token} is not a theme token`).toBeTypeOf("string");

      for (const surface of SURFACES) {
        const plane = tokens[surface]!;
        // The border box is painted over the card's own fill, so the edge
        // composites over the fill and is read against the plane outside it
        // and, when there is one, the fill inside it.
        const fill = fillToken ? over(tokens[fillToken]!, plane) : plane;
        const edge = over(ink!, fill);
        const against: Array<[string, string]> = [[surface, plane]];
        if (fillToken) against.push([fillToken, fill]);
        for (const [what, backdrop] of against) {
          const ratio = contrastRatio(edge, backdrop);
          expect(
            ratio,
            `${scheme.id}: ${label} edge against ${what} on ${surface} is ${ratio.toFixed(2)}:1`
          ).toBeGreaterThanOrEqual(EDGE_MIN_CONTRAST);
        }
      }
    });
  }
});
