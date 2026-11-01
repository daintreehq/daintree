import { describe, expect, it } from "vitest";
import {
  ACTIVITY_TEXT_INKS,
  ACTIVITY_TEXT_MIN_CONTRAST,
  contrastRatio,
  deltaEOK,
  getThemeContrastWarnings,
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

// The floor under which a two-tone mark of working and completed reads as one
// disc: the closest built-in pair that still visibly splits is movile's, ΔE 0.029.
const WORKING_COMPLETED_MIN_DELTA_E = 0.025;

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
      // Both halves stay visible as a mark on the row they sit on.
      for (const row of resolvePaletteRowBackdrops(scheme.tokens, scheme.type)) {
        expect(
          contrastRatio(completed, row.hex),
          `completed on ${row.label}`
        ).toBeGreaterThanOrEqual(3);
      }
    }
  );

  it("measures the switcher's rows, which can fail where every display surface passes", () => {
    // Dark palettes float at 94% over the plane beneath, so the switcher's row is a
    // colour no display surface spells. An ink lifted only against the shared rows
    // is measured against this one too.
    const daintree = getAppThemeById("daintree")!;
    const rows = resolvePaletteRowBackdrops(daintree.tokens, "dark");
    const shared = resolveDiffTextBackdrops(daintree.tokens);
    const sharedHexes = new Set(shared.map((b) => b.hex));
    expect(rows.some((row) => !sharedHexes.has(row.hex))).toBe(true);
    expect(resolveActivityTextBackdrops(daintree.tokens, "dark")).toHaveLength(
      shared.length + rows.length
    );
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
    const scheme = normalizeAppColorScheme({
      id: "dim-moss",
      name: "Dim moss",
      type: "dark",
      tokens: { "activity-completed": "#3f5a44", "surface-sidebar": "#2a2a2a" },
    });
    const ink = scheme.tokens["activity-completed-text"];
    expect(ink).not.toBe("#3f5a44");
    expect(hueDistance(hexToOklch(ink)!.h, hexToOklch("#3f5a44")!.h)).toBeLessThan(1.5);
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
