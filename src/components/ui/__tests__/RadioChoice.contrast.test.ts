import { describe, expect, it } from "vitest";
import { BUILT_IN_APP_SCHEMES } from "@shared/theme/themes";
import { blendOverBackground, contrastRatio, parseRgba } from "@shared/theme/contrast";
import { CHOICE_SELECTED, CHOICE_UNSELECTED } from "../RadioChoice";

/**
 * A choice card's row is the click target, so its edge is the affordance: on a
 * dark theme the ladder's `border-default` (1.1-1.3:1) and `border-strong`
 * (1.2-1.6:1) leave the options reading as loose radios beside their labels
 * (#17891). Every edge the card paints has to clear the 3:1 non-text floor
 * against the surface it sits on, in every built-in theme, in neutral ink.
 *
 * Read off the class strings rather than restated here, so swapping an edge for
 * a quieter token or adding a hover step that dims it fails this on its own.
 */

// Width (`border-2`), style (`border-dashed`) and side (`border-t`) utilities
// share the `border-` prefix with colour ones; only a colour names a theme token.
const NON_COLOUR_EDGE = /^(?:\d+|solid|dashed|dotted|double|hidden|none|[xyselrtb](?:-\d+)?)$/;

function edgeInks(classes: string): Array<{ variant: string; token: string }> {
  const inks: Array<{ variant: string; token: string }> = [];
  for (const utility of classes.split(/\s+/)) {
    const match = utility.match(/^((?:[a-z-]+:)*)border-(.+)$/);
    if (!match || NON_COLOUR_EDGE.test(match[2]!)) continue;
    expect(
      match[2],
      `${utility}: a slash-alpha edge composites differently on every surface`
    ).not.toMatch(/\//);
    // `border-border-input` names the `border-input` token and
    // `border-selection-outline` names `selection-outline`.
    inks.push({ variant: match[1]!, token: match[2]! });
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

describe("RadioChoice card edges", () => {
  it("paints each state's edge in a neutral border token", () => {
    expect(edgeInks(CHOICE_UNSELECTED).filter((e) => e.variant === "")).toHaveLength(1);
    expect(edgeInks(CHOICE_SELECTED)).toHaveLength(1);
    // Accent is the row's focus ring; a card edge in accent or a status colour
    // would be a second load-bearing hue per focus region.
    for (const { token } of [...edgeInks(CHOICE_UNSELECTED), ...edgeInks(CHOICE_SELECTED)]) {
      expect(token).toMatch(/^(?:border-[a-z]+|selection-outline)$/);
    }
  });

  const cases = [
    ["resting", CHOICE_UNSELECTED, "overlay-soft"],
    ["selected", CHOICE_SELECTED, "overlay-selected"],
  ] as const;

  for (const [state, classes, fillToken] of cases) {
    for (const { variant, token } of edgeInks(classes)) {
      const label = variant ? `${state} ${variant.replace(/:$/, "")}` : state;

      it.each(BUILT_IN_APP_SCHEMES)(
        `holds the ${label} edge (${token}) at 3:1 on $id`,
        (scheme) => {
          const tokens = scheme.tokens as Record<string, string>;
          const ink = tokens[token];
          expect(ink, `${token} is not a theme token`).toBeTypeOf("string");

          for (const surface of SURFACES) {
            const plane = tokens[surface]!;
            // The border box is painted over the card's own fill, so the edge
            // composites over the fill and is read against the plane around it.
            const fill = over(tokens[fillToken]!, plane);
            const edge = over(ink, fill);
            const ratio = contrastRatio(edge, plane);
            expect(
              ratio,
              `${scheme.id}: ${label} edge on ${surface} is ${ratio.toFixed(2)}:1`
            ).toBeGreaterThanOrEqual(EDGE_MIN_CONTRAST);
          }
        }
      );
    }
  }
});
