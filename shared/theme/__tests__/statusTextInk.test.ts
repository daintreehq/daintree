import { describe, expect, it } from "vitest";
import {
  STATUS_TEXT_CONTRAST,
  STATUS_TEXT_INKS,
  blendOverBackground,
  contrastRatio,
  getThemeContrastWarnings,
  resolveDiffTextBackdrops,
  resolveStatusTextBackdrops,
} from "../contrast.js";
import { hexToOklch, type OklchColor } from "../oklch.js";
import {
  BUILT_IN_APP_SCHEMES,
  deriveStatusTextInks,
  getAppThemeById,
  normalizeAppColorScheme,
} from "../themes.js";
import type { AppThemeTokenKey } from "../types.js";

const INKS = Object.entries(STATUS_TEXT_INKS) as Array<[AppThemeTokenKey, AppThemeTokenKey]>;
const { minimum, washOpacity } = STATUS_TEXT_CONTRAST;

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Perceptual hue difference (ΔH in OKLCH), which scales with chroma. The angle
 * alone is unstable on a near-grey ink: 8-bit rounding turns highlands' grey-blue
 * info ink by 3° without any visible change. 0.003 is 1.5° at a chroma of 0.1.
 */
function hueDifference(a: OklchColor, b: OklchColor): number {
  return 2 * Math.sqrt(a.c * b.c) * Math.sin((hueDistance(a.h, b.h) * Math.PI) / 360);
}

describe("git status letter inks (#15424)", () => {
  it.each(BUILT_IN_APP_SCHEMES.map((s) => [s.id, s] as const))(
    "%s: every ink holds AA on each row backdrop, bare and under its own wash",
    (_id, scheme) => {
      for (const [source, key] of INKS) {
        const rows = resolveDiffTextBackdrops(scheme.tokens);
        const backdrops = resolveStatusTextBackdrops(scheme.tokens[source], scheme.tokens);
        // Each row backdrop, then the same row under the letter's own wash.
        expect(backdrops).toHaveLength(rows.length * 2);
        for (const row of rows) {
          const wash = blendOverBackground(scheme.tokens[source], row.hex, washOpacity);
          for (const backdrop of [row.hex, wash]) {
            const ratio = contrastRatio(scheme.tokens[key], backdrop);
            expect(ratio, `${key} over ${row.label}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
              minimum
            );
          }
        }
      }
    }
  );

  it.each(BUILT_IN_APP_SCHEMES.map((s) => [s.id, s] as const))(
    "%s: each ink keeps its status ink's hue and only moves away from the surfaces",
    (_id, scheme) => {
      for (const [source, key] of INKS) {
        const ink = hexToOklch(scheme.tokens[key])!;
        const status = hexToOklch(scheme.tokens[source])!;
        expect(hueDifference(ink, status), `${key} hue`).toBeLessThan(0.003);
        if (scheme.type === "dark") expect(ink.l).toBeGreaterThanOrEqual(status.l - 1e-6);
        else expect(ink.l).toBeLessThanOrEqual(status.l + 1e-6);
      }
    }
  );

  it("measures the wash, which can fail where the bare row passes", () => {
    // A wash of the letter's own hue pulls the backdrop toward the ink, so an
    // ink that only just clears the bare surface falls under AA on its badge.
    const daintree = getAppThemeById("daintree")!;
    const elevated = daintree.tokens["surface-panel-elevated"];
    const green = "#22b45a";
    const wash = blendOverBackground(green, elevated, washOpacity);
    expect(contrastRatio(green, elevated)).toBeGreaterThanOrEqual(minimum);
    expect(contrastRatio(green, wash)).toBeLessThan(minimum);

    const ink = deriveStatusTextInks({ ...daintree.tokens, "status-success": green }, "dark")[
      "status-success-text"
    ]!;
    expect(contrastRatio(ink, wash)).toBeGreaterThanOrEqual(minimum);
  });

  it("gates a theme whose letter inks are the bare status inks", () => {
    const bali = getAppThemeById("bali")!;
    const tokens = { ...bali.tokens };
    for (const [source, key] of INKS) tokens[key] = bali.tokens[source];
    const messages = getThemeContrastWarnings({ ...bali, tokens })
      .filter((w) => w.kind === "low-contrast")
      .map((w) => w.message);
    for (const [, key] of INKS) {
      expect(messages.some((m) => m.startsWith(`${key} on `))).toBe(true);
    }
  });

  it("reports a status ink whose wash it can't composite instead of passing it", () => {
    const daintree = getAppThemeById("daintree")!;
    const warnings = getThemeContrastWarnings({
      ...daintree,
      tokens: { ...daintree.tokens, "status-info": "color-mix(in oklab, blue 50%, gray)" },
    });
    expect(
      warnings.some((w) => w.kind === "unevaluable" && w.message.includes("status-info-text"))
    ).toBe(true);
  });

  it("re-lifts from an imported theme's own status ink and surfaces", () => {
    const scheme = normalizeAppColorScheme({
      id: "dim-teal",
      name: "Dim teal",
      type: "dark",
      tokens: { "status-success": "#1f5560", "surface-panel-elevated": "#3a3a3a" },
    });
    const ink = scheme.tokens["status-success-text"];
    expect(ink).not.toBe("#1f5560");
    expect(hueDistance(hexToOklch(ink)!.h, hexToOklch("#1f5560")!.h)).toBeLessThan(1.5);
    for (const backdrop of resolveStatusTextBackdrops("#1f5560", scheme.tokens)) {
      expect(contrastRatio(ink, backdrop.hex), backdrop.label).toBeGreaterThanOrEqual(minimum);
    }
    expect(
      getThemeContrastWarnings(scheme).filter((w) => w.message.includes("status-success-text"))
    ).toEqual([]);
  });

  it("keeps a letter ink the theme names, even one the gate rejects", () => {
    const scheme = normalizeAppColorScheme({
      id: "named-ink",
      name: "Named ink",
      type: "dark",
      tokens: { "status-danger-text": "#603030" },
    });
    expect(scheme.tokens["status-danger-text"]).toBe("#603030");
    expect(
      getThemeContrastWarnings(scheme).some((w) => w.message.startsWith("status-danger-text on "))
    ).toBe(true);
  });
});
