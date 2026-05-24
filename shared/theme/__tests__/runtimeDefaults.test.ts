import { describe, expect, it } from "vitest";
import { PANEL_KIND_BRAND_COLORS } from "../entityColors.js";
import type { ThemePalette } from "../palette.js";
import { createSemanticTokens } from "../semantic.js";
import {
  ANSI_CYAN_FALLBACK,
  ANSI_MAGENTA_FALLBACK,
  BUILT_IN_APP_SCHEMES,
  normalizeAppColorScheme,
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
