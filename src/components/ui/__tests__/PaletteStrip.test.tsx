// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { APP_THEME_PREVIEW_KEYS } from "@shared/theme";
import type { AppColorScheme } from "@shared/types/appTheme";
import { PaletteStrip } from "../PaletteStrip";

const scheme = {
  id: "test",
  name: "Test",
  type: "dark" as const,
  builtin: false,
  heroImage: "/themes/test.webp",
  tokens: {
    [APP_THEME_PREVIEW_KEYS.accent]: "#ff0000",
    [APP_THEME_PREVIEW_KEYS.success]: "#00ff00",
    [APP_THEME_PREVIEW_KEYS.warning]: "#ffff00",
    [APP_THEME_PREVIEW_KEYS.danger]: "#ff00ff",
    [APP_THEME_PREVIEW_KEYS.text]: "#ffffff",
    [APP_THEME_PREVIEW_KEYS.border]: "#333333",
    [APP_THEME_PREVIEW_KEYS.panel]: "#111111",
    [APP_THEME_PREVIEW_KEYS.sidebar]: "#222222",
  },
} as AppColorScheme;

describe("PaletteStrip", () => {
  it("renders 8 swatch chips", () => {
    const { container } = render(<PaletteStrip scheme={scheme} />);
    const chips = container.querySelectorAll(".w-3.h-3");
    expect(chips).toHaveLength(8);
  });

  it("each swatch chip uses the correct token color as background", () => {
    const { container } = render(<PaletteStrip scheme={scheme} />);
    const chips = container.querySelectorAll<HTMLDivElement>(".w-3.h-3");
    const expectedColors = [
      scheme.tokens[APP_THEME_PREVIEW_KEYS.accent],
      scheme.tokens[APP_THEME_PREVIEW_KEYS.success],
      scheme.tokens[APP_THEME_PREVIEW_KEYS.warning],
      scheme.tokens[APP_THEME_PREVIEW_KEYS.danger],
      scheme.tokens[APP_THEME_PREVIEW_KEYS.text],
      scheme.tokens[APP_THEME_PREVIEW_KEYS.border],
      scheme.tokens[APP_THEME_PREVIEW_KEYS.panel],
      scheme.tokens[APP_THEME_PREVIEW_KEYS.sidebar],
    ];
    chips.forEach((chip, i) => {
      const hex = expectedColors[i]!;
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      expect(chip.style.backgroundColor).toBe(`rgb(${r}, ${g}, ${b})`);
    });
  });
});
