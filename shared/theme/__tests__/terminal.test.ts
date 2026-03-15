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
    // Canopy's activity-idle is #52525b → rgba(82, 82, 91, ...)
    expect(theme.scrollbarSliderBackground).toBe("rgba(82, 82, 91, 0.4)");
    expect(theme.scrollbarSliderHoverBackground).toBe("rgba(82, 82, 91, 0.6)");
    expect(theme.scrollbarSliderActiveBackground).toBe("rgba(82, 82, 91, 0.8)");
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

  it("maps Fiordland scheme tokens correctly", () => {
    const fiordland = BUILT_IN_APP_SCHEMES.find((s) => s.id === "fiordland")!;
    const theme = getTerminalThemeFromAppScheme(fiordland);
    expect(theme.background).toBe("#070D12");
    expect(theme.foreground).toBe("#D4E0D6");
    expect(theme.selectionBackground).toBe("#1A2C22");
    expect(theme.red).toBe("#F7768E");
    expect(theme.green).toBe("#9ECE6A");
    expect(theme.brightWhite).toBe("#C0CAF5");
    // activity-idle #3D4E5C → rgba(61, 78, 92, ...)
    expect(theme.scrollbarSliderBackground).toBe("rgba(61, 78, 92, 0.4)");
    expect(theme.scrollbarSliderHoverBackground).toBe("rgba(61, 78, 92, 0.6)");
    expect(theme.scrollbarSliderActiveBackground).toBe("rgba(61, 78, 92, 0.8)");
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
