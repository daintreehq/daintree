// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  BUILT_IN_APP_SCHEMES,
  STATUS_INK_CONTRAST,
  SYNTAX_CANVAS_FLOORS,
  SYNTAX_CANVAS_SURFACE,
  contrastRatio,
  getAppThemeCssVariables,
  hexToOklch,
  isHexColor,
  type AppColorScheme,
  type AppThemeTokenKey,
} from "@shared/theme";
import {
  ALL_CVD_TOKENS,
  BLUE_YELLOW_OVERRIDES,
  RED_GREEN_OVERRIDES,
} from "@shared/theme/colorVisionOverrides";
import { applyAppThemeToRoot, applyColorVisionMode } from "../applyAppTheme";

// Every syntax and graphical status ink a mode swaps in has to hold the floor the
// theme's own ink is held to, on the surfaces that theme actually paints it on.
// Measured on what `applyColorVisionMode` writes to the root, not on the maps.

const MODES = [
  ["red-green", RED_GREEN_OVERRIDES],
  ["blue-yellow", BLUE_YELLOW_OVERRIDES],
] as const;

type Mode = (typeof MODES)[number][0];

function paint(scheme: AppColorScheme, mode: Mode) {
  const root = document.createElement("div");
  applyAppThemeToRoot(root, scheme);
  applyColorVisionMode(root, mode, scheme);
  return { root, read: (token: AppThemeTokenKey) => readInk(root, token) };
}

function readInk(root: HTMLElement, token: AppThemeTokenKey): string {
  const value = root.style.getPropertyValue(`--theme-${token}`);
  // An empty or non-hex read would measure NaN and slip past every floor.
  expect(isHexColor(value), `${token} is written as hex (got "${value}")`).toBe(true);
  return value;
}

/** Each token the mode fits, beside the surfaces it is measured on and its floor. */
function fittedInks(overrides: Record<string, string>) {
  const syntax = SYNTAX_CANVAS_FLOORS.map(
    ([token, floor]) => [token, [SYNTAX_CANVAS_SURFACE], floor] as const
  );
  const status = STATUS_INK_CONTRAST.inks.map(
    (token) => [token, STATUS_INK_CONTRAST.surfaces, STATUS_INK_CONTRAST.minimum] as const
  );
  return [...syntax, ...status].filter(([token]) => `--theme-${token}` in overrides);
}

describe("colour-vision modes hold the theme's contrast floors (#15580)", () => {
  for (const [mode, overrides] of MODES) {
    it.each(BUILT_IN_APP_SCHEMES)(`${mode} on $id: every fitted ink clears its floor`, (scheme) => {
      const { read } = paint(scheme, mode);
      const failures: string[] = [];
      for (const [token, surfaces, floor] of fittedInks(overrides)) {
        const ink = read(token);
        for (const surface of surfaces) {
          const ratio = contrastRatio(ink, scheme.tokens[surface]);
          if (!(ratio >= floor)) {
            failures.push(`${token} ${ink} on ${surface} is ${ratio.toFixed(2)}:1, floor ${floor}`);
          }
        }
      }
      expect(failures).toEqual([]);
    });

    it.each(BUILT_IN_APP_SCHEMES)(`${mode} on $id: fitted inks keep the mode's hue`, (scheme) => {
      const { read } = paint(scheme, mode);
      for (const [token] of fittedInks(overrides)) {
        const seed = hexToOklch(overrides[`--theme-${token}`]!)!;
        const ink = hexToOklch(read(token))!;
        if (seed.c < 0.005) {
          expect(ink.c, `${token} stays neutral`).toBeLessThan(0.005);
          continue;
        }
        const angle = Math.abs(ink.h - seed.h) % 360;
        expect(Math.min(angle, 360 - angle), `${token} hue`).toBeLessThan(2.5);
        expect(ink.c, `${token} chroma`).toBeGreaterThan(seed.c * 0.5);
      }
    });
  }

  it.each(BUILT_IN_APP_SCHEMES)("turning the modes off restores every token on $id", (scheme) => {
    const base = getAppThemeCssVariables(scheme);
    const { root } = paint(scheme, "red-green");
    applyColorVisionMode(root, "blue-yellow", scheme);
    applyColorVisionMode(root, "default", scheme);
    for (const token of ALL_CVD_TOKENS) {
      expect(root.style.getPropertyValue(token), token).toBe(base[token] ?? "");
    }
  });

  it("writes the raw map when there is no scheme to fit against", () => {
    for (const [mode, overrides] of MODES) {
      const root = document.createElement("div");
      applyColorVisionMode(root, mode);
      for (const [token] of fittedInks(overrides)) {
        expect(root.style.getPropertyValue(`--theme-${token}`), `${mode} ${token}`).toBe(
          overrides[`--theme-${token}`]
        );
      }
    }
  });
});
