import { describe, expect, it } from "vitest";
import {
  DISPLAY_SURFACES,
  STATUS_TEXT_CONTRAST,
  STATUS_TEXT_INKS,
  blendOverBackground,
  contrastRatio,
  deriveStatusTextInk,
  getThemeContrastWarnings,
  parseRgba,
} from "../contrast.js";
import { BUILT_IN_APP_SCHEMES, getAppThemeById, normalizeAppColorScheme } from "../themes.js";
import type { AppColorScheme, AppColorSchemeTokens, AppThemeTokenKey } from "../types.js";

type Tokens = Partial<Record<AppThemeTokenKey, string>>;

const DARK: Tokens = {
  "surface-grid": "#0b0d10",
  "surface-sidebar": "#111418",
  "surface-canvas": "#14171c",
  "surface-panel": "#1a1e24",
  "surface-panel-elevated": "#22272e",
  "text-primary": "#eef1f4",
};

const LIGHT: Tokens = {
  "surface-grid": "#f4f5f7",
  "surface-sidebar": "#eceef1",
  "surface-canvas": "#ffffff",
  "surface-panel": "#fafbfc",
  "surface-panel-elevated": "#ffffff",
  "text-primary": "#14171c",
};

/** Every pixel the letter can land on, rebuilt here from the tokens rather than shared with the code under test. */
function backdrops(graphical: string, tokens: Tokens): string[] {
  return DISPLAY_SURFACES.flatMap((key) => {
    const surface = tokens[key]!;
    const rows = [surface];
    for (const fill of ["overlay-subtle", "overlay-highlight"] as const) {
      const rgba = tokens[fill] ? parseRgba(tokens[fill]) : null;
      if (rgba) rows.push(blendOverBackground(rgba.hex, surface, rgba.opacity));
    }
    return rows.flatMap((row) => [row, blendOverBackground(graphical, row, 0.15)]);
  });
}

function worstContrast(ink: string, graphical: string, tokens: Tokens): number {
  return Math.min(...backdrops(graphical, tokens).map((bg) => contrastRatio(ink, bg)));
}

describe("deriveStatusTextInk", () => {
  it("keeps an ink that already reads as text everywhere", () => {
    const graphical = "#5ee08a";
    expect(worstContrast(graphical, graphical, DARK)).toBeGreaterThanOrEqual(4.5);
    expect(deriveStatusTextInk(graphical, DARK)).toBe(graphical);
  });

  it.each([
    ["dark", DARK, "#3f7a52"],
    ["light", LIGHT, "#3f9a5e"],
  ] as const)(
    "moves a %s-theme graphical ink only as far as AA needs",
    (_polarity, tokens, graphical) => {
      expect(worstContrast(graphical, graphical, tokens)).toBeLessThan(4.5);

      const ink = deriveStatusTextInk(graphical, tokens);
      expect(worstContrast(ink, graphical, tokens)).toBeGreaterThanOrEqual(4.5);

      // The least step that passes: the mix one percent closer to the hue fails.
      const textPrimary = tokens["text-primary"]!;
      const step = Array.from({ length: 101 }, (_, i) => i).find(
        (i) => blendOverBackground(textPrimary, graphical, i / 100) === ink
      );
      expect(step).toBeGreaterThan(0);
      const previous = blendOverBackground(textPrimary, graphical, (step! - 1) / 100);
      expect(worstContrast(previous, graphical, tokens)).toBeLessThan(4.5);
    }
  );

  it("answers to the hovered and selected row, not just the bare surface", () => {
    const graphical = "#3f7a52";
    const rows: Tokens = {
      ...DARK,
      "overlay-subtle": "rgba(255, 255, 255, 0.04)",
      "overlay-highlight": "rgba(255, 255, 255, 0.1)",
    };
    const ink = deriveStatusTextInk(graphical, rows);
    expect(worstContrast(ink, graphical, rows)).toBeGreaterThanOrEqual(4.5);
    // The bare-surface answer would be under AA on the selected row.
    const restOnly = deriveStatusTextInk(graphical, DARK);
    expect(worstContrast(restOnly, graphical, rows)).toBeLessThan(4.5);
  });

  it("leaves an ink it can't measure as the graphical colour", () => {
    expect(deriveStatusTextInk("var(--brand-green)", DARK)).toBe("var(--brand-green)");
    expect(
      deriveStatusTextInk("#3f7a52", {
        ...DARK,
        "text-primary": "color-mix(in oklab, white 90%, black)",
      })
    ).toBe("#3f7a52");
  });
});

describe("status text inks in themes", () => {
  it.each(BUILT_IN_APP_SCHEMES.map((scheme) => [scheme.id, scheme] as const))(
    "%s keeps each ink on its own hue",
    (_id, scheme) => {
      for (const [graphicalKey, textKey] of Object.entries(STATUS_TEXT_INKS) as Array<
        [AppThemeTokenKey, AppThemeTokenKey]
      >) {
        // The letter has to stay a coloured mark, not collapse into body text.
        expect(scheme.tokens[textKey], textKey).not.toBe(
          blendOverBackground(scheme.tokens["text-primary"], scheme.tokens[graphicalKey], 1)
        );
      }
    }
  );

  it("re-derives from an imported theme's own surfaces", () => {
    const scheme = normalizeAppColorScheme({
      type: "dark",
      tokens: { "surface-panel": "#3a3d42", "status-success": "#4f8a5f" },
    });
    const ink = scheme.tokens["status-success-text"];
    const wash = blendOverBackground("#4f8a5f", "#3a3d42", STATUS_TEXT_CONTRAST.washOpacity);
    expect(contrastRatio(ink, "#3a3d42")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(ink, wash)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps an ink the theme names, and the gate reports it when it falls short", () => {
    const base = getAppThemeById("bali")!;
    const weak = base.tokens["status-success"];
    const scheme: AppColorScheme = normalizeAppColorScheme({
      ...base,
      tokens: { ...base.tokens, "status-success-text": weak } as AppColorSchemeTokens,
    });
    expect(scheme.tokens["status-success-text"]).toBe(weak);
    expect(
      getThemeContrastWarnings(scheme).some(
        (warning) =>
          warning.kind === "low-contrast" && warning.message.startsWith("status-success-text on")
      )
    ).toBe(true);
  });
});
