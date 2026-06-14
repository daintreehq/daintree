import { describe, expect, it } from "vitest";
import { PANEL_KIND_BRAND_COLORS } from "../entityColors.js";
import type { ThemePalette } from "../palette.js";
import { createSemanticTokens } from "../semantic.js";
import {
  ANSI_CYAN_FALLBACK,
  ANSI_MAGENTA_FALLBACK,
  BUILT_IN_APP_SCHEMES,
  getAppThemeCssVariables,
  normalizeAppColorScheme,
  resolveGrainImage,
} from "../themes.js";

function makePaletteWithoutTerminal(): ThemePalette {
  return {
    type: "dark",
    surfaces: {
      grid: "#101010",
      sidebar: "#181818",
      canvas: "#202020",
      panel: "#282828",
      elevated: "#303030",
    },
    text: {
      primary: "#f5f5f5",
      secondary: "#bbbbbb",
      muted: "#888888",
      inverse: "#101010",
    },
    border: "#333333",
    accent: "#6860D4",
    status: {
      success: "#22c55e",
      warning: "#f59e0b",
      danger: "#ef4444",
      info: "#3b82f6",
    },
    activity: {
      active: "#22c55e",
      idle: "#666666",
      working: "#3b82f6",
      waiting: "#f59e0b",
    },
    syntax: {
      comment: "#707b90",
      punctuation: "#c5d0f5",
      number: "#efb36b",
      string: "#95c879",
      operator: "#8acfe1",
      keyword: "#bc9cef",
      function: "#84adf8",
      link: "#72c1ea",
      quote: "#adb5bb",
      chip: "#7fd4cf",
    },
  };
}

describe("ANSI terminal fallbacks for plugin themes without a terminal sub-palette", () => {
  it("uses ANSI magenta and cyan when palette.terminal is omitted", () => {
    const tokens = createSemanticTokens(makePaletteWithoutTerminal());
    expect(tokens["terminal-magenta"]).toBe(ANSI_MAGENTA_FALLBACK);
    expect(tokens["terminal-cyan"]).toBe(ANSI_CYAN_FALLBACK);
    expect(tokens["terminal-bright-magenta"]).toBe(ANSI_MAGENTA_FALLBACK);
    expect(tokens["terminal-bright-cyan"]).toBe(ANSI_CYAN_FALLBACK);
  });

  it("does not leak the (purple-adjacent) accent into the magenta slot", () => {
    const palette = makePaletteWithoutTerminal();
    const tokens = createSemanticTokens(palette);
    expect(tokens["terminal-magenta"]).not.toBe(palette.accent);
    expect(tokens["terminal-bright-magenta"]).not.toBe(palette.accent);
  });

  it("does not leak the activity-active hue into the cyan slot", () => {
    const palette = makePaletteWithoutTerminal();
    const tokens = createSemanticTokens(palette);
    expect(tokens["terminal-cyan"]).not.toBe(palette.activity.active);
    expect(tokens["terminal-bright-cyan"]).not.toBe(palette.activity.active);
  });

  it("applies the ANSI fallback through compilePaletteToTokens (normalizeAppColorScheme path)", () => {
    // Mirror coverage: themes.ts and semantic.ts implement the same fix in
    // parallel. This guards against future divergence by exercising the
    // built-in compile path used by BUILT_IN_APP_SCHEMES.
    const scheme = normalizeAppColorScheme({ palette: makePaletteWithoutTerminal() });
    expect(scheme.tokens["terminal-magenta"]).toBe(ANSI_MAGENTA_FALLBACK);
    expect(scheme.tokens["terminal-cyan"]).toBe(ANSI_CYAN_FALLBACK);
    expect(scheme.tokens["terminal-bright-magenta"]).toBe(ANSI_MAGENTA_FALLBACK);
    expect(scheme.tokens["terminal-bright-cyan"]).toBe(ANSI_CYAN_FALLBACK);
  });

  it("falls back per-slot when palette.terminal exists but specific keys are absent", () => {
    const palette = makePaletteWithoutTerminal();
    // Cast through unknown to model a plugin theme JSON with partial terminal config.
    const partial = {
      ...palette,
      terminal: { selection: "#444444", magenta: "#ff00ff" } as unknown,
    } as ThemePalette;
    const tokens = createSemanticTokens(partial);
    expect(tokens["terminal-magenta"]).toBe("#ff00ff");
    expect(tokens["terminal-cyan"]).toBe(ANSI_CYAN_FALLBACK);
    expect(tokens["terminal-bright-magenta"]).toBe(ANSI_MAGENTA_FALLBACK);
    expect(tokens["terminal-bright-cyan"]).toBe(ANSI_CYAN_FALLBACK);
  });

  it("explicit palette overrides still win over the ANSI fallback", () => {
    const palette: ThemePalette = {
      ...makePaletteWithoutTerminal(),
      terminal: {
        selection: "#444444",
        red: "#ff0000",
        green: "#00ff00",
        yellow: "#ffff00",
        blue: "#0000ff",
        magenta: "#ff00ff",
        cyan: "#00ffff",
        brightRed: "#ff8888",
        brightGreen: "#88ff88",
        brightYellow: "#ffff88",
        brightBlue: "#8888ff",
        brightMagenta: "#ff88ff",
        brightCyan: "#88ffff",
        brightWhite: "#ffffff",
      },
    };
    const tokens = createSemanticTokens(palette);
    expect(tokens["terminal-magenta"]).toBe("#ff00ff");
    expect(tokens["terminal-cyan"]).toBe("#00ffff");
    expect(tokens["terminal-bright-magenta"]).toBe("#ff88ff");
    expect(tokens["terminal-bright-cyan"]).toBe("#88ffff");
  });
});

describe("scrollbar-track default — subtle gutter tint", () => {
  it("every built-in theme resolves a non-transparent, derived track tint", () => {
    for (const scheme of BUILT_IN_APP_SCHEMES) {
      const track = scheme.tokens["scrollbar-track"];
      expect(track, scheme.id).not.toBe("transparent");
      // withAlpha(text-primary, 0.03) emits an rgba() triplet at 3% opacity.
      expect(track, scheme.id).toMatch(/^rgba\(\d+, \d+, \d+, 0\.03\)$/);
    }
  });

  it("an explicit scrollbar-track override wins over the derived default", () => {
    const scheme = normalizeAppColorScheme({
      palette: makePaletteWithoutTerminal(),
      tokens: { "scrollbar-track": "#abcdef" },
    });
    expect(scheme.tokens["scrollbar-track"]).toBe("#abcdef");
  });
});

describe("scrim-blur defaults — material lengths, themeable per scheme", () => {
  it("every built-in theme resolves both scrim blur tokens as non-negative px lengths", () => {
    for (const scheme of BUILT_IN_APP_SCHEMES) {
      for (const key of ["scrim-blur", "scrim-blur-palette"] as const) {
        const value = scheme.tokens[key];
        expect(value, `${scheme.id} ${key}`).toMatch(/^\d+(\.\d+)?px$/);
        expect(parseFloat(value), `${scheme.id} ${key} non-negative`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("an explicit override wins over the engine default (0 is legal — clarity themes)", () => {
    const scheme = normalizeAppColorScheme({
      palette: makePaletteWithoutTerminal(),
      tokens: { "scrim-blur": "18px", "scrim-blur-palette": "0px" },
    });
    expect(scheme.tokens["scrim-blur"]).toBe("18px");
    expect(scheme.tokens["scrim-blur-palette"]).toBe("0px");
  });
});

describe("grain material defaults — opacity scalar + blend keyword", () => {
  it("every built-in theme resolves grain-opacity in (0, 1) and a blend keyword", () => {
    for (const scheme of BUILT_IN_APP_SCHEMES) {
      const opacity = parseFloat(scheme.tokens["grain-opacity"]);
      expect(Number.isFinite(opacity), `${scheme.id} grain-opacity numeric`).toBe(true);
      expect(opacity, `${scheme.id} grain-opacity > 0`).toBeGreaterThan(0);
      expect(opacity, `${scheme.id} grain-opacity < 1`).toBeLessThan(1);
      expect(scheme.tokens["grain-blend"], `${scheme.id} grain-blend keyword`).toMatch(
        /^[a-z][a-z-]*$/
      );
    }
  });

  it("explicit grain overrides win over the engine defaults", () => {
    const scheme = normalizeAppColorScheme({
      palette: makePaletteWithoutTerminal(),
      tokens: { "grain-opacity": "0.035", "grain-blend": "screen" },
    });
    expect(scheme.tokens["grain-opacity"]).toBe("0.035");
    expect(scheme.tokens["grain-blend"]).toBe("screen");
  });
});

describe("grainCharacter — curated texture resolution and conditional emission", () => {
  it("each curated character resolves to a distinct, non-empty data-URI background-image", () => {
    const coarse = resolveGrainImage("coarse");
    const paper = resolveGrainImage("paper");
    for (const value of [coarse, paper]) {
      expect(value).toBeTruthy();
      expect(value).toMatch(/^url\("data:image\/svg\+xml,/);
    }
    expect(coarse).not.toBe(paper);
  });

  it("curated data-URIs decode to seamless-tiling SVG turbulence documents", () => {
    for (const character of ["coarse", "paper"] as const) {
      const value = resolveGrainImage(character)!;
      const encoded = value.slice('url("data:image/svg+xml,'.length, -'")'.length);
      const svg = decodeURIComponent(encoded);
      expect(svg, `${character} decodes to svg`).toMatch(/^<svg /);
      expect(svg, `${character} uses feTurbulence`).toContain("<feTurbulence");
      expect(svg, `${character} tiles seamlessly`).toContain("stitchTiles='stitch'");
    }
  });

  it("'none' resolves to the none keyword; unset and 'fine' emit nothing", () => {
    expect(resolveGrainImage("none")).toBe("none");
    expect(resolveGrainImage("fine")).toBeUndefined();
    expect(resolveGrainImage(undefined)).toBeUndefined();
  });

  it("a palette without grainCharacter emits NO --grain-image var (CSS keeps the bundled asset)", () => {
    const scheme = normalizeAppColorScheme({ palette: makePaletteWithoutTerminal() });
    const variables = getAppThemeCssVariables(scheme);
    expect(Object.keys(variables)).not.toContain("--grain-image");
  });

  it("a strategy grainCharacter emits --grain-image through the extension pipeline", () => {
    const palette = makePaletteWithoutTerminal();
    const coarseScheme = normalizeAppColorScheme({
      palette: { ...palette, strategy: { grainCharacter: "coarse" } },
    });
    expect(getAppThemeCssVariables(coarseScheme)["--grain-image"]).toBe(
      resolveGrainImage("coarse")
    );

    const noneScheme = normalizeAppColorScheme({
      palette: { ...palette, strategy: { grainCharacter: "none" } },
    });
    expect(getAppThemeCssVariables(noneScheme)["--grain-image"]).toBe("none");
  });

  it("an explicitly authored grain-image extension wins over the strategy field", () => {
    const palette = makePaletteWithoutTerminal();
    const scheme = normalizeAppColorScheme({
      palette: { ...palette, strategy: { grainCharacter: "coarse" } },
      extensions: { "grain-image": "none" },
    });
    expect(getAppThemeCssVariables(scheme)["--grain-image"]).toBe("none");
  });
});

describe("PANEL_KIND_BRAND_COLORS — agent vs dev-preview distinctness", () => {
  it("agent and dev-preview resolve to different theme tokens", () => {
    expect(PANEL_KIND_BRAND_COLORS.agent).not.toBe(PANEL_KIND_BRAND_COLORS["dev-preview"]);
  });

  it("dev-preview no longer collides with the accent on purple-accent themes", () => {
    expect(PANEL_KIND_BRAND_COLORS["dev-preview"]).not.toBe("var(--theme-accent-primary)");
    expect(PANEL_KIND_BRAND_COLORS["dev-preview"]).not.toBe("var(--theme-category-violet)");
  });

  it("all panel kinds have distinct colors", () => {
    const values = Object.values(PANEL_KIND_BRAND_COLORS);
    expect(new Set(values).size).toBe(values.length);
  });
});
