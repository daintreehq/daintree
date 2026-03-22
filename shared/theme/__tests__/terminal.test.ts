import { describe, expect, it } from "vitest";
import { getTerminalScrollbarDefaults, getTerminalThemeFromAppScheme } from "../terminal.js";
import { APP_THEME_TOKEN_KEYS, type AppColorScheme } from "../types.js";

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

describe("getTerminalScrollbarDefaults", () => {
  it("returns white-channel values for dark mode", () => {
    const defaults = getTerminalScrollbarDefaults("dark");
    expect(defaults.scrollbarSliderBackground).toBe("rgba(255, 255, 255, 0.20)");
    expect(defaults.scrollbarSliderHoverBackground).toBe("rgba(255, 255, 255, 0.40)");
    expect(defaults.scrollbarSliderActiveBackground).toBe("rgba(255, 255, 255, 0.50)");
  });

  it("returns black-channel values for light mode", () => {
    const defaults = getTerminalScrollbarDefaults("light");
    expect(defaults.scrollbarSliderBackground).toBe("rgba(0, 0, 0, 0.20)");
    expect(defaults.scrollbarSliderHoverBackground).toBe("rgba(0, 0, 0, 0.40)");
    expect(defaults.scrollbarSliderActiveBackground).toBe("rgba(0, 0, 0, 0.50)");
  });
});

describe("getTerminalThemeFromAppScheme", () => {
  it("maps terminal tokens and derives scrollbar colors from hex activity-idle", () => {
    const theme = getTerminalThemeFromAppScheme(createTestScheme("dark", "#112233"));

    expect(theme.background).toBe("#111111");
    expect(theme.foreground).toBe("#f5f5f5");
    expect(theme.cursor).toBe("#22aa88");
    expect(theme.selectionBackground).toBe("#334455");
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
