import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_THEME_POLARITY_VARIABLES, BUILT_IN_APP_SCHEMES } from "@shared/theme/themes";
import { blendOverBackground, contrastRatio, parseRgba } from "@shared/theme/contrast";
import { cn } from "@/lib/utils";
import { CHOICE_SELECTED, CHOICE_SHELL, CHOICE_UNSELECTED } from "../RadioChoice";

/**
 * A choice card's row is the click target, so its edge is the affordance: on a
 * dark theme the ladder's `border-default` (1.1-1.3:1) and `border-strong`
 * (1.2-1.6:1) leave the options reading as loose radios beside their labels
 * (#17891). Every edge the card paints, in every state it paints one, has to
 * clear the 3:1 non-text floor against the surface around it and the fill
 * inside it, in every built-in theme, in neutral ink.
 *
 * Read off the class strings rather than restated here, so swapping an edge for
 * a quieter token, changing a fill under an edge, or adding a hover step that
 * dims it fails this on its own.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const PREFERS_CONTRAST_CSS = fs.readFileSync(
  path.join(REPO_ROOT, "src/styles/host/prefers-contrast.css"),
  "utf8"
);

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

interface Paint {
  variant: string;
  token: string;
}

/**
 * The border colours and background fills a class string paints, each with the
 * variant it is gated on. A token a theme cannot resolve, or an edge written as
 * an arbitrary value or a slash-alpha, cannot be measured and fails here.
 */
function paints(classes: string): { edges: Paint[]; fills: Paint[] } {
  const edges: Paint[] = [];
  const fills: Paint[] = [];
  for (const utility of classes.split(/\s+/)) {
    const split = splitVariant(utility);
    const { variant } = split;
    // `!border-0` and `border-0!` are the same utility, forced.
    const base = split.base.replace(/^!|!$/g, "");
    // A removed (whole or one side) or property-set edge is no edge to measure.
    expect(base, `${utility}: an edge cannot be removed or set by arbitrary property`).not.toMatch(
      /^(?:border(?:-[xyselrtb])?-(?:0|hidden|none)|\[)/
    );
    const edge = base.match(/^border-(.+)$/);
    if (edge && !NON_COLOUR_EDGE.test(edge[1]!)) {
      expect(edge[1], `${utility}: not a measurable edge`).toMatch(/^[a-z-]+$/);
      // `border-border-input` names the `border-input` token and
      // `border-selection-outline` names `selection-outline`.
      edges.push({ variant, token: edge[1]! });
    }
    const fill = base.match(/^bg-(.+)$/);
    if (fill) {
      expect(fill[1], `${utility}: not a measurable fill`).toMatch(/^[a-z-]+$/);
      fills.push({ variant, token: fill[1]! });
    }
  }
  return { edges, fills };
}

// An alpha hex reads as opaque to `contrastRatio`, so a wash is composited here
// and anything this cannot evaluate fails loudly instead of passing.
const over = (value: string, backdrop: string) => {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  const rgba = parseRgba(value);
  if (rgba) return blendOverBackground(rgba.hex, backdrop, rgba.opacity);
  const alphaHex = value.match(/^#([0-9a-f]{6})([0-9a-f]{2})$/i);
  if (alphaHex) {
    return blendOverBackground(`#${alphaHex[1]}`, backdrop, parseInt(alphaHex[2]!, 16) / 255);
  }
  throw new Error(`cannot evaluate ${value} over ${backdrop}`);
};

// A card sits in a dialog (panel on dark, elevated on light), a settings page
// or a pane, so the edge is held against both panel planes.
const SURFACES = ["surface-panel", "surface-panel-elevated"] as const;

// The planes a card is hosted on: the dialog surface of the theme's polarity
// and the panel pages sit on. A dark theme's elevated plane is a drawer or
// popover plane, where a card can still land (a plugin radio group in an overlay
// drawer). The edge is held there against the outside plane in every state and
// against the selected fill inside; only the transient hover wash is spared its
// inside seam there, where it lands at 2.8-2.9:1 on the dark themes.
function hostPlanes(scheme: (typeof BUILT_IN_APP_SCHEMES)[number]): string[] {
  const ref = APP_THEME_POLARITY_VARIABLES[scheme.type]["--theme-surface-dialog"];
  const dialog = ref?.match(/^var\(--theme-([a-z-]+)\)$/)?.[1];
  if (!dialog) throw new Error(`no surface-dialog mapping for ${scheme.type}`);
  return [dialog, "surface-panel"];
}

const EDGE_MIN_CONTRAST = 3;

// `prefers-contrast: more` rebinds theme tokens app-wide (`border-input` to
// `text-secondary`), so the edge it paints is read from the stylesheet.
const INCREASED_CONTRAST_REBINDS = new Map(
  [
    ...PREFERS_CONTRAST_CSS.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(
      /--theme-([a-z-]+)\s*:\s*var\(\s*--theme-([a-z-]+)\s*\)/g
    ),
  ].map((m) => [m[1]!, m[2]!] as const)
);

const unselected = paints(CHOICE_UNSELECTED);
const selected = paints(CHOICE_SELECTED);

const only = (list: Paint[], variant: string) => list.filter((p) => p.variant === variant);

interface State {
  name: string;
  /** The theme token the edge is inked in. */
  edge: string;
  /** The theme token filling the card under the edge, or null for an open card. */
  fill: string | null;
  /**
   * Whether the inside of the edge is measured on every plane. Hover is a
   * transient pointer state, so only the planes a card is hosted on carry it.
   */
  insideOnEveryPlane: boolean;
}

const restEdge = only(unselected.edges, "")[0]!;
const restFill = only(unselected.fills, "")[0]?.token ?? null;
const hoverEdge = only(unselected.edges, "hover:")[0]?.token;
const hoverFill = only(unselected.fills, "hover:")[0]?.token;
const selectedEdge = only(selected.edges, "")[0]!;
const STATES: State[] = [
  { name: "resting", edge: restEdge.token, fill: restFill, insideOnEveryPlane: true },
  // Hover repaints the edge, the fill, or both; what it leaves alone is the
  // resting paint. A fill-only hover keeps the resting edge over its wash.
  ...(hoverEdge || hoverFill
    ? [
        {
          name: "hover",
          edge: hoverEdge ?? restEdge.token,
          fill: hoverFill ?? restFill,
          insideOnEveryPlane: false,
        },
      ]
    : []),
  {
    name: "selected",
    edge: selectedEdge.token,
    fill: only(selected.fills, "")[0]!.token,
    insideOnEveryPlane: true,
  },
];

describe("RadioChoice card edges", () => {
  it("paints each state's edge in a neutral token", () => {
    expect(only(unselected.edges, "")).toHaveLength(1);
    expect(only(selected.edges, "")).toHaveLength(1);
    expect(only(selected.fills, "")).toHaveLength(1);
    // Two utilities for one property in one state leave the later one to win in
    // `cn()`, and this reads the first.
    for (const list of [unselected.edges, unselected.fills, selected.edges, selected.fills]) {
      const variants = list.map((p) => p.variant);
      expect(new Set(variants).size).toBe(variants.length);
    }
    for (const { token } of [...unselected.edges, ...selected.edges]) {
      expect(token).toMatch(NEUTRAL_INK);
    }
  });

  it("only varies an edge or a fill by a state this test measures", () => {
    for (const { variant } of [...unselected.edges, ...unselected.fills]) {
      expect(["", "hover:"]).toContain(variant);
    }
    // `contrast-more:` is measured in its own test; the card is the same
    // otherwise, so it carries no variant fill.
    for (const { variant } of selected.edges) expect(["", "contrast-more:"]).toContain(variant);
    for (const { variant } of selected.fills) expect(variant).toBe("");
  });

  // Composed the way the row does, so a width utility that `cn()` resolves away
  // (a later `border-0`) cannot leave the edge with nothing to paint in.
  it.each([
    ["unselected", CHOICE_UNSELECTED],
    ["selected", CHOICE_SELECTED],
  ])("keeps a bordered box on a %s card for the edge to be painted in", (_state, classes) => {
    expect(cn(CHOICE_SHELL, classes).split(/\s+/)).toContain("border");
  });

  for (const state of STATES) {
    it.each(BUILT_IN_APP_SCHEMES)(
      `holds the ${state.name} edge (${state.edge}) at 3:1 on $id`,
      (scheme) => {
        const tokens = scheme.tokens as Record<string, string>;
        expect(tokens[state.edge], `${state.edge} is not a theme token`).toBeTypeOf("string");

        for (const surface of SURFACES) {
          const plane = tokens[surface]!;
          // The border box is painted over the card's own fill, so the edge
          // composites over the fill and is read against the plane outside it
          // and, when there is one, the fill inside it.
          const fill = state.fill ? over(tokens[state.fill]!, plane) : plane;
          const edge = over(tokens[state.edge]!, fill);
          const against: Array<[string, string]> = [[surface, plane]];
          if (state.fill && (state.insideOnEveryPlane || hostPlanes(scheme).includes(surface))) {
            against.push([state.fill, fill]);
          }
          for (const [what, backdrop] of against) {
            const ratio = contrastRatio(edge, backdrop);
            expect(
              ratio,
              `${scheme.id}: ${state.name} edge against ${what} on ${surface} is ${ratio.toFixed(2)}:1`
            ).toBeGreaterThanOrEqual(EDGE_MIN_CONTRAST);
          }
        }
      }
    );
  }

  // Under increased contrast the resting edge is inked in whatever the
  // stylesheet rebinds `border-input` to, which can be heavier than the chosen
  // card's `selection-outline`. The chosen card has to stay the heavier edge.
  it.each(BUILT_IN_APP_SCHEMES)(
    "keeps the chosen edge heavier than the resting edge under increased contrast on $id",
    (scheme) => {
      const tokens = scheme.tokens as Record<string, string>;
      const resolve = (token: string) => INCREASED_CONTRAST_REBINDS.get(token) ?? token;
      const chosenToken = only(selected.edges, "contrast-more:")[0]?.token ?? selectedEdge.token;

      for (const surface of SURFACES) {
        const plane = tokens[surface]!;
        const chosenFill = over(tokens[only(selected.fills, "")[0]!.token]!, plane);
        const rest = contrastRatio(over(tokens[resolve(restEdge.token)]!, plane), plane);
        const chosen = contrastRatio(over(tokens[resolve(chosenToken)]!, chosenFill), plane);
        expect(
          chosen,
          `${scheme.id} on ${surface}: chosen edge ${chosen.toFixed(2)}:1 vs resting ${rest.toFixed(2)}:1`
        ).toBeGreaterThan(rest);
        // A rebind that moved the resting edge somewhere weaker would pass the
        // ordering on its own.
        expect(
          rest,
          `${scheme.id} on ${surface}: resting edge ${rest.toFixed(2)}:1`
        ).toBeGreaterThanOrEqual(EDGE_MIN_CONTRAST);
      }
    }
  );
});
