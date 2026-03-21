import { describe, it, expect } from "vitest";
import { getTerminalScrollbarDefaults, getTerminalThemeFromAppScheme } from "../terminal.js";
import { BUILT_IN_APP_SCHEMES } from "../themes.js";
import type { AppColorScheme } from "../types.js";

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
  it("derives scrollbar from activity-idle token for hex values", () => {
    const scheme = BUILT_IN_APP_SCHEMES[0];
    const theme = getTerminalThemeFromAppScheme(scheme);
    // Daintree's activity-idle is #555C58 → rgba(85, 92, 88, ...)
    expect(theme.scrollbarSliderBackground).toBe("rgba(85, 92, 88, 0.4)");
    expect(theme.scrollbarSliderHoverBackground).toBe("rgba(85, 92, 88, 0.6)");
    expect(theme.scrollbarSliderActiveBackground).toBe("rgba(85, 92, 88, 0.8)");
  });

  it("falls back to generic defaults when activity-idle is not hex", () => {
    const scheme: AppColorScheme = {
      ...BUILT_IN_APP_SCHEMES[0],
      tokens: {
        ...BUILT_IN_APP_SCHEMES[0].tokens,
        "activity-idle": "oklch(0.5 0 0)",
      },
    };
    const theme = getTerminalThemeFromAppScheme(scheme);
    expect(theme.scrollbarSliderBackground).toBe("rgba(255, 255, 255, 0.20)");
  });

  it("uses light generic defaults for non-hex light scheme", () => {
    const scheme: AppColorScheme = {
      ...BUILT_IN_APP_SCHEMES[0],
      type: "light",
      tokens: {
        ...BUILT_IN_APP_SCHEMES[0].tokens,
        "activity-idle": "oklch(0.5 0 0)",
      },
    };
    const theme = getTerminalThemeFromAppScheme(scheme);
    expect(theme.scrollbarSliderBackground).toBe("rgba(0, 0, 0, 0.20)");
  });
});
