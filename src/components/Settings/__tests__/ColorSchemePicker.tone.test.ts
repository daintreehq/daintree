import { describe, it, expect } from "vitest";
import { BUILT_IN_SCHEMES, DEFAULT_SCHEME_ID } from "@/config/terminalColorSchemes";
import { BUILT_IN_APP_SCHEMES, relativeLuminance } from "@shared/theme";
import { resolveSchemeForPreview, schemeTone } from "../ColorSchemePicker";

describe("terminal scheme tone", () => {
  it("puts every light-listed scheme on a brighter background than every dark-listed one", () => {
    const luminance = (bg: string | undefined) => relativeLuminance(bg!);
    const light = BUILT_IN_SCHEMES.filter((s) => schemeTone(s) === "light");
    const dark = BUILT_IN_SCHEMES.filter((s) => schemeTone(s) === "dark");
    expect(light.length).toBeGreaterThan(0);
    expect(dark.length).toBeGreaterThan(0);
    const dimmestLight = Math.min(...light.map((s) => luminance(s.colors.background)));
    const brightestDark = Math.max(...dark.map((s) => luminance(s.colors.background)));
    expect(dimmestLight).toBeGreaterThan(brightestDark);
  });
});

describe("Match app theme preview", () => {
  const match = BUILT_IN_SCHEMES.find((s) => s.id === DEFAULT_SCHEME_ID)!;

  it.each(BUILT_IN_APP_SCHEMES.map((s) => [s.id, s] as const))(
    "paints %s's own terminal background, as the terminals do",
    (id, appScheme) => {
      const preview = resolveSchemeForPreview(match, id);
      const expected = appScheme.tokens["terminal-background"];
      if (!expected) return;
      expect(preview.colors.background?.toLowerCase()).toBe(expected.toLowerCase());
    }
  );
});
