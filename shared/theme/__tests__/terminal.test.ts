import { describe, it, expect } from "vitest";
import { getTerminalScrollbarDefaults, getTerminalThemeFromAppScheme } from "../terminal";
import { BUILT_IN_APP_SCHEMES } from "../themes";
import type { AppColorScheme } from "../types";

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
  it("uses dark scrollbar defaults for dark app scheme", () => {
    const scheme = BUILT_IN_APP_SCHEMES[0];
    const theme = getTerminalThemeFromAppScheme(scheme);
    expect(theme.scrollbarSliderBackground).toBe("rgba(255, 255, 255, 0.20)");
  });

  it("uses light scrollbar defaults for light app scheme", () => {
    const lightScheme: AppColorScheme = {
      ...BUILT_IN_APP_SCHEMES[0],
      type: "light",
    };
    const theme = getTerminalThemeFromAppScheme(lightScheme);
    expect(theme.scrollbarSliderBackground).toBe("rgba(0, 0, 0, 0.20)");
  });
});
