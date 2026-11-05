import { describe, expect, it } from "vitest";
import type { ITheme } from "@xterm/xterm";
import { getColorVisionTerminalWrites } from "../colorVisionOverrides.js";
import { getThemeContrastWarnings } from "../contrast.js";
import { hexToOklch } from "../oklch.js";
import { getTerminalThemeFromAppScheme } from "../terminal.js";
import { BUILT_IN_APP_SCHEMES } from "../themes.js";
import { APP_THEME_TOKEN_KEYS, type AppColorScheme, type AppThemeTokenKey } from "../types.js";

function createTestScheme(
  type: "dark" | "light",
  idle: string,
  overrides: Partial<AppColorScheme["tokens"]> = {}
): AppColorScheme {
  const tokens = Object.fromEntries(
    APP_THEME_TOKEN_KEYS.map((key) => [key, "#101010"])
  ) as AppColorScheme["tokens"];

  Object.assign(tokens, {
    "activity-idle": idle,
    "terminal-background": "#111111",
    "terminal-foreground": "#f5f5f5",
    "terminal-cursor": "#22aa88",
    "terminal-cursor-accent": "#111111",
    "terminal-selection": "#334455",
    "terminal-black": "#111111",
    "terminal-red": "#dd6666",
    "terminal-green": "#44cc88",
    "terminal-yellow": "#ddaa33",
    "terminal-blue": "#5599dd",
    "terminal-magenta": "#aa66dd",
    "terminal-cyan": "#22bbbb",
    "terminal-white": "#eeeeee",
    "terminal-bright-black": "#666666",
    "terminal-bright-red": "#ff8888",
    "terminal-bright-green": "#66eeaa",
    "terminal-bright-yellow": "#ffcc55",
    "terminal-bright-blue": "#77bbff",
    "terminal-bright-magenta": "#cc88ff",
    "terminal-bright-cyan": "#55eeee",
    "terminal-bright-white": "#ffffff",
    ...overrides,
  });

  return {
    id: `test-${type}`,
    name: `Test ${type}`,
    type,
    builtin: false,
    tokens,
  };
}

describe("getTerminalThemeFromAppScheme", () => {
  it("derives scrollbar colors from hex activity-idle", () => {
    const theme = getTerminalThemeFromAppScheme(createTestScheme("dark", "#112233"));

    expect(theme.scrollbarSliderBackground).toBe("rgba(17, 34, 51, 0.4)");
    expect(theme.scrollbarSliderHoverBackground).toBe("rgba(17, 34, 51, 0.6)");
    expect(theme.scrollbarSliderActiveBackground).toBe("rgba(17, 34, 51, 0.8)");
  });

  it("falls back to dark scrollbar defaults when activity-idle is not hex", () => {
    const theme = getTerminalThemeFromAppScheme(createTestScheme("dark", "oklch(0.5 0 0)"));

    expect(theme.scrollbarSliderBackground).toBe("rgba(255, 255, 255, 0.20)");
    expect(theme.scrollbarSliderHoverBackground).toBe("rgba(255, 255, 255, 0.40)");
    expect(theme.scrollbarSliderActiveBackground).toBe("rgba(255, 255, 255, 0.50)");
  });

  it("falls back to light scrollbar defaults when activity-idle is not hex", () => {
    const theme = getTerminalThemeFromAppScheme(createTestScheme("light", "oklch(0.5 0 0)"));

    expect(theme.scrollbarSliderBackground).toBe("rgba(0, 0, 0, 0.20)");
    expect(theme.scrollbarSliderHoverBackground).toBe("rgba(0, 0, 0, 0.40)");
    expect(theme.scrollbarSliderActiveBackground).toBe("rgba(0, 0, 0, 0.50)");
  });
});

describe("getTerminalThemeFromAppScheme under a colour-vision mode (#16272)", () => {
  const MODES = ["red-green", "blue-yellow"] as const;
  const CASES = MODES.flatMap((mode) =>
    BUILT_IN_APP_SCHEMES.map((scheme) => [mode, scheme.id, scheme] as const)
  );

  const SLOT_TOKENS: ReadonlyArray<readonly [keyof ITheme, AppThemeTokenKey]> = [
    ["selectionBackground", "terminal-selection"],
    ["black", "terminal-black"],
    ["red", "terminal-red"],
    ["green", "terminal-green"],
    ["yellow", "terminal-yellow"],
    ["blue", "terminal-blue"],
    ["magenta", "terminal-magenta"],
    ["cyan", "terminal-cyan"],
    ["white", "terminal-white"],
    ["brightBlack", "terminal-bright-black"],
    ["brightRed", "terminal-bright-red"],
    ["brightGreen", "terminal-bright-green"],
    ["brightYellow", "terminal-bright-yellow"],
    ["brightBlue", "terminal-bright-blue"],
    ["brightMagenta", "terminal-bright-magenta"],
    ["brightCyan", "terminal-bright-cyan"],
    ["brightWhite", "terminal-bright-white"],
  ];

  function overlay(scheme: AppColorScheme, writes: Record<string, string>): AppColorScheme {
    const tokens = { ...scheme.tokens };
    for (const [name, value] of Object.entries(writes)) {
      tokens[name.slice("--theme-".length) as AppThemeTokenKey] = value;
    }
    return { ...scheme, tokens };
  }

  // The terminal checks' findings on a palette that the scheme's own palette
  // doesn't already draw.
  function addedTerminalWarnings(scheme: AppColorScheme, painted: AppColorScheme): string[] {
    const terminal = (s: AppColorScheme) =>
      getThemeContrastWarnings(s)
        .filter((warning) => warning.kind === "terminal-legibility")
        .map((warning) => warning.message);
    const own = new Set(terminal(scheme));
    return terminal(painted).filter((message) => !own.has(message));
  }

  it.each(CASES)("%s on %s paints the mode's fitted inks and nothing else", (mode, _id, scheme) => {
    const painted = overlay(scheme, getColorVisionTerminalWrites(mode, scheme));
    expect(getTerminalThemeFromAppScheme(scheme, mode)).toEqual(
      getTerminalThemeFromAppScheme(painted)
    );
  });

  it.each(CASES)("%s on %s passes the terminal contrast checks", (mode, _id, scheme) => {
    const painted = overlay(scheme, getColorVisionTerminalWrites(mode, scheme));
    expect(addedTerminalWarnings(scheme, painted)).toEqual([]);
  });

  it.each(CASES)("%s on %s keeps the theme's own selection", (mode, _id, scheme) => {
    expect(getTerminalThemeFromAppScheme(scheme, mode).selectionBackground).toBe(
      scheme.tokens["terminal-selection"]
    );
  });

  it.each(BUILT_IN_APP_SCHEMES.map((scheme) => [scheme.id, scheme] as const))(
    "default mode on %s paints the scheme's own terminal tokens",
    (_id, scheme) => {
      const before = { ...scheme.tokens };
      const theme = getTerminalThemeFromAppScheme(scheme, "default");
      for (const [slot, token] of SLOT_TOKENS) {
        expect(theme[slot], slot).toBe(scheme.tokens[token]);
      }
      expect(scheme.tokens).toEqual(before);
    }
  );

  it.each(MODES)("%s fits its inks to a light terminal background at their own hues", (mode) => {
    const scheme = createTestScheme("light", "#666666", { "terminal-background": "#e0e0e0" });
    const raw = getColorVisionTerminalWrites(mode);
    // The authored inks are too light for this background, so there is a fit to make.
    expect(addedTerminalWarnings(scheme, overlay(scheme, raw)).length).toBeGreaterThan(0);

    const fitted = getColorVisionTerminalWrites(mode, scheme);
    expect(addedTerminalWarnings(scheme, overlay(scheme, fitted))).toEqual([]);
    const moved = Object.keys(fitted).filter((name) => fitted[name] !== raw[name]);
    expect(moved.length).toBeGreaterThan(0);
    for (const name of moved) {
      const seed = hexToOklch(raw[name]!)!;
      const ink = hexToOklch(fitted[name]!)!;
      const angle = Math.abs(ink.h - seed.h) % 360;
      expect(Math.min(angle, 360 - angle), `${name} hue`).toBeLessThan(2.5);
      expect(ink.l, `${name} darkens on a light background`).toBeLessThan(seed.l);
    }
  });

  it("leaves the raw inks when the terminal background isn't hex", () => {
    const scheme = createTestScheme("dark", "#666666", {
      "terminal-background": "color-mix(in oklab, #000 50%, #fff)",
    });
    expect(getColorVisionTerminalWrites("red-green", scheme)).toEqual(
      getColorVisionTerminalWrites("red-green")
    );
  });
});
