import { describe, expect, it } from "vitest";
import {
  differenceEuclidean,
  filterDeficiencyDeuter,
  filterDeficiencyProt,
  modeOklab,
  parse,
  useMode,
} from "culori";
import {
  ACTIVITY_TEXT_INKS,
  ACTIVITY_TEXT_MIN_CONTRAST,
  blendOverBackground,
  contrastRatio,
  deltaEOK,
  getThemeContrastWarnings,
  parseRgba,
  resolveActivityTextBackdrops,
  resolveDiffTextBackdrops,
  resolvePaletteRowBackdrops,
} from "../contrast.js";
import { hexToOklch, type OklchColor } from "../oklch.js";
import {
  BUILT_IN_APP_SCHEMES,
  deriveActivityTextInks,
  getAppThemeById,
  normalizeAppColorScheme,
} from "../themes.js";
import type { AppThemeTokenKey } from "../types.js";

const INKS = Object.entries(ACTIVITY_TEXT_INKS) as Array<[AppThemeTokenKey, AppThemeTokenKey]>;

// eslint-disable-next-line react-hooks/rules-of-hooks -- culori config, not a React hook
useMode(modeOklab);

const oklabDistance = differenceEuclidean("oklab");

const RED_GREEN_FILTERS = [
  ["protanopia", filterDeficiencyProt(1)],
  ["deuteranopia", filterDeficiencyDeuter(1)],
] as const;

// The floors under which a two-tone mark of working and completed reads as one
// disc. The closest built-in pair that still visibly splits is movile's: ΔE 0.029,
// and 0.017 under deuteranopia.
const WORKING_COMPLETED_MIN_DELTA_E = 0.025;
const WORKING_COMPLETED_MIN_CVD_DELTA_E = 0.015;

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** ΔH in OKLCH, which scales with chroma, so a near-grey ink's rounding is ignored. */
function hueDifference(a: OklchColor, b: OklchColor): number {
  return 2 * Math.sqrt(a.c * b.c) * Math.sin((hueDistance(a.h, b.h) * Math.PI) / 360);
}

describe("activity sentence inks (#15866)", () => {
  it.each(BUILT_IN_APP_SCHEMES.map((s) => [s.id, s] as const))(
    "%s: every ink holds AA on each row and on the switcher's own rows",
    (_id, scheme) => {
      const rows = resolvePaletteRowBackdrops(scheme.tokens, scheme.type);
      // At rest and highlighted, on the solid surface and (dark) on each plane
      // the translucent palette can float over.
      expect(rows).toHaveLength(scheme.type === "dark" ? 10 : 2);
      const backdrops = [...resolveDiffTextBackdrops(scheme.tokens), ...rows];
      for (const [, key] of INKS) {
        for (const backdrop of backdrops) {
          const ratio = contrastRatio(scheme.tokens[key], backdrop.hex);
          expect(
            ratio,
            `${key} on ${backdrop.label}: ${ratio.toFixed(2)}:1`
          ).toBeGreaterThanOrEqual(ACTIVITY_TEXT_MIN_CONTRAST);
        }
      }
    }
  );

  it.each(BUILT_IN_APP_SCHEMES.map((s) => [s.id, s] as const))(
    "%s: each ink keeps its activity ink's hue and only moves away from the surfaces",
    (_id, scheme) => {
      for (const [source, key] of INKS) {
        const ink = hexToOklch(scheme.tokens[key])!;
        const activity = hexToOklch(scheme.tokens[source])!;
        expect(hueDifference(ink, activity), `${key} hue`).toBeLessThan(0.003);
        if (scheme.type === "dark") expect(ink.l).toBeGreaterThanOrEqual(activity.l - 1e-6);
        else expect(ink.l).toBeLessThanOrEqual(activity.l + 1e-6);
      }
    }
  );

  it.each(BUILT_IN_APP_SCHEMES.map((s) => [s.id, s] as const))(
    "%s: working and completed split the two-tone mark",
    (_id, scheme) => {
      const working = scheme.tokens["activity-working"];
      const completed = scheme.tokens["activity-completed"];
      expect(deltaEOK(working, completed)).toBeGreaterThanOrEqual(WORKING_COMPLETED_MIN_DELTA_E);
      // A red-green reader loses most of the chroma between two greens, so the
      // split has to survive on what's left, which is mostly lightness.
      for (const [deficiency, filter] of RED_GREEN_FILTERS) {
        const seen = oklabDistance(filter(parse(working)!), filter(parse(completed)!));
        expect(seen, `${deficiency} ΔE`).toBeGreaterThanOrEqual(WORKING_COMPLETED_MIN_CVD_DELTA_E);
      }
      // Both halves stay visible as a mark on the row they sit on.
      for (const row of resolvePaletteRowBackdrops(scheme.tokens, scheme.type)) {
        for (const [half, ink] of [
          ["working", working],
          ["completed", completed],
        ] as const) {
          expect(contrastRatio(ink, row.hex), `${half} on ${row.label}`).toBeGreaterThanOrEqual(3);
        }
      }
    }
  );

  it("measures the switcher's rows, translucent dark palette included", () => {
    // Dark palettes float at 94% over the plane beneath, so the switcher's row is a
    // colour no display surface spells; each one is measured at rest and under the
    // highlight.
    const daintree = getAppThemeById("daintree")!;
    const t = daintree.tokens;
    const highlight = parseRgba(t["overlay-highlight"])!;
    const rows = new Set(resolvePaletteRowBackdrops(t, "dark").map((row) => row.hex));
    for (const plane of [
      "surface-grid",
      "surface-canvas",
      "surface-panel",
      "surface-panel-elevated",
    ] as const) {
      const palette = blendOverBackground(t["surface-sidebar"], t[plane], 0.94);
      expect(rows.has(palette), `palette over ${plane}`).toBe(true);
      const highlighted = blendOverBackground(highlight.hex, palette, highlight.opacity);
      expect(rows.has(highlighted), `highlighted over ${plane}`).toBe(true);
    }
    const all = new Set(resolveActivityTextBackdrops(t, "dark").map((b) => b.hex));
    for (const row of rows) expect(all.has(row)).toBe(true);
  });

  it("settles for the floor where a surface leaves no room for the headroom", () => {
    // White on #767676 is 4.54:1: AA, but under the 4.55:1 the derivation aims for.
    const daintree = getAppThemeById("daintree")!;
    const tokens = { ...daintree.tokens, tint: "#000000", "activity-working": "#808080" };
    for (const key of [
      "surface-grid",
      "surface-sidebar",
      "surface-canvas",
      "surface-panel",
      "surface-panel-elevated",
    ] as const) {
      tokens[key] = "#767676";
    }
    for (const key of [
      "overlay-subtle",
      "overlay-soft",
      "overlay-highlight",
      "overlay-selected",
    ] as const) {
      tokens[key] = "rgba(0, 0, 0, 0)";
    }
    const ink = deriveActivityTextInks(tokens, "dark")["activity-working-text"]!;
    for (const backdrop of resolveActivityTextBackdrops(tokens, "dark")) {
      expect(contrastRatio(ink, backdrop.hex), backdrop.label).toBeGreaterThanOrEqual(
        ACTIVITY_TEXT_MIN_CONTRAST
      );
    }
  });

  it("gates a theme whose sentence inks are the bare activity inks", () => {
    // Daintree's completed ink reads 4.37:1 on its highlighted switcher row.
    const daintree = getAppThemeById("daintree")!;
    const tokens = { ...daintree.tokens };
    for (const [source, key] of INKS) tokens[key] = daintree.tokens[source];
    const messages = getThemeContrastWarnings({ ...daintree, tokens })
      .filter((w) => w.kind === "low-contrast")
      .map((w) => w.message);
    expect(messages.some((m) => m.startsWith("activity-completed-text on "))).toBe(true);
  });

  it("reports an ink it can't measure instead of passing it", () => {
    const daintree = getAppThemeById("daintree")!;
    const warnings = getThemeContrastWarnings({
      ...daintree,
      tokens: {
        ...daintree.tokens,
        "activity-waiting-text": "color-mix(in oklab, orange 50%, gray)",
      },
    });
    expect(
      warnings.some((w) => w.kind === "unevaluable" && w.message.includes("activity-waiting-text"))
    ).toBe(true);
  });

  it("re-lifts from an imported theme's own activity ink and surfaces", () => {
    // A plum nowhere near the green of the theme it is normalised over, on a
    // sidebar it can't read on, so the twin has to come from this import.
    const plum = "#4a3a5e";
    const scheme = normalizeAppColorScheme({
      id: "dim-plum",
      name: "Dim plum",
      type: "dark",
      tokens: { "activity-completed": plum, "surface-sidebar": "#3a3a3a" },
    });
    expect(contrastRatio(plum, "#3a3a3a")).toBeLessThan(ACTIVITY_TEXT_MIN_CONTRAST);
    const ink = scheme.tokens["activity-completed-text"];
    expect(ink).not.toBe(plum);
    expect(hueDistance(hexToOklch(ink)!.h, hexToOklch(plum)!.h)).toBeLessThan(1.5);
    for (const backdrop of resolveActivityTextBackdrops(scheme.tokens, "dark")) {
      expect(contrastRatio(ink, backdrop.hex), backdrop.label).toBeGreaterThanOrEqual(
        ACTIVITY_TEXT_MIN_CONTRAST
      );
    }
    expect(
      getThemeContrastWarnings(scheme).filter((w) => w.message.includes("activity-completed-text"))
    ).toEqual([]);
  });

  it("keeps a sentence ink the theme names, even one the gate rejects", () => {
    const scheme = normalizeAppColorScheme({
      id: "named-activity-ink",
      name: "Named activity ink",
      type: "dark",
      tokens: { "activity-working-text": "#305030" },
    });
    expect(scheme.tokens["activity-working-text"]).toBe("#305030");
    expect(
      getThemeContrastWarnings(scheme).some((w) =>
        w.message.startsWith("activity-working-text on ")
      )
    ).toBe(true);
  });

  it("derives nothing for an activity ink the tokens don't carry", () => {
    const daintree = getAppThemeById("daintree")!;
    const { "activity-waiting": _omitted, ...tokens } = daintree.tokens;
    expect(deriveActivityTextInks(tokens, "dark")).not.toHaveProperty("activity-waiting-text");
  });
});
