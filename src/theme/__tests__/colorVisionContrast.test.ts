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
  normalizeAppColorScheme,
  type AppColorScheme,
  type AppThemeTokenKey,
} from "@shared/theme";
import {
  ALL_CVD_TOKENS,
  BLUE_YELLOW_OVERRIDES,
  RED_GREEN_OVERRIDES,
  getColorVisionWrites,
} from "@shared/theme/colorVisionOverrides";
import type { ColorVisionMode } from "@shared/types";
import { applyAppThemeToRoot, applyColorVisionMode } from "../applyAppTheme";

// Every syntax and graphical status ink on screen under a mode has to hold the
// floor the theme's own ink is held to, on the surfaces that theme paints it on.
// Measured on what `applyColorVisionMode` leaves on the root, not on the maps.

const MODES = [
  ["red-green", RED_GREEN_OVERRIDES],
  ["blue-yellow", BLUE_YELLOW_OVERRIDES],
] as const;

const DESTRUCTIVE_TOKENS = [
  "--theme-destructive-fill",
  "--theme-destructive-fill-hover",
  "--theme-destructive-fill-active",
  "--theme-destructive-foreground",
] as const;

const INK_FLOORS: ReadonlyArray<readonly [AppThemeTokenKey, readonly AppThemeTokenKey[], number]> =
  [
    ...SYNTAX_CANVAS_FLOORS.map(
      ([token, floor]) => [token, [SYNTAX_CANVAS_SURFACE], floor] as const
    ),
    ...STATUS_INK_CONTRAST.inks.map(
      (token) => [token, STATUS_INK_CONTRAST.surfaces, STATUS_INK_CONTRAST.minimum] as const
    ),
  ];

function paint(scheme: AppColorScheme, mode: ColorVisionMode): HTMLElement {
  const root = document.createElement("div");
  applyAppThemeToRoot(root, scheme);
  applyColorVisionMode(root, mode, scheme);
  return root;
}

function readInk(root: HTMLElement, token: AppThemeTokenKey): string {
  const value = root.style.getPropertyValue(`--theme-${token}`);
  // An empty or non-hex read would measure NaN and slip past every floor.
  expect(isHexColor(value), `${token} is written as hex (got "${value}")`).toBe(true);
  return value;
}

function floorFailures(root: HTMLElement, scheme: AppColorScheme): string[] {
  const failures: string[] = [];
  for (const [token, surfaces, floor] of INK_FLOORS) {
    const ink = readInk(root, token);
    for (const surface of surfaces) {
      const ratio = contrastRatio(ink, scheme.tokens[surface]);
      if (!(ratio >= floor)) {
        failures.push(`${token} ${ink} on ${surface} is ${ratio.toFixed(2)}:1, floor ${floor}`);
      }
    }
  }
  return failures;
}

describe("colour-vision modes hold the theme's contrast floors (#15580)", () => {
  for (const [mode, overrides] of MODES) {
    it.each(BUILT_IN_APP_SCHEMES)(
      `${mode} on $id: every ink on screen clears its floor`,
      (scheme) => {
        expect(floorFailures(paint(scheme, mode), scheme)).toEqual([]);
      }
    );

    it.each(BUILT_IN_APP_SCHEMES)(`${mode} on $id: fitted inks keep the mode's hue`, (scheme) => {
      const root = paint(scheme, mode);
      const fitted = INK_FLOORS.filter(([token]) => `--theme-${token}` in overrides);
      expect(fitted.length).toBeGreaterThan(0);
      for (const [token] of fitted) {
        const seed = hexToOklch(overrides[`--theme-${token}`]!)!;
        const ink = hexToOklch(readInk(root, token))!;
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

  it.each(BUILT_IN_APP_SCHEMES)(
    "every switch leaves exactly the active mode's writes on $id",
    (scheme) => {
      const base = getAppThemeCssVariables(scheme);
      const root = document.createElement("div");
      applyAppThemeToRoot(root, scheme);
      const sequence: ColorVisionMode[] = [
        "red-green",
        "blue-yellow",
        "red-green",
        "default",
        "blue-yellow",
        "default",
      ];
      for (const mode of sequence) {
        applyColorVisionMode(root, mode, scheme);
        const writes = getColorVisionWrites(mode, scheme);
        for (const token of [...ALL_CVD_TOKENS, ...DESTRUCTIVE_TOKENS]) {
          expect(root.style.getPropertyValue(token), `${token} after ${mode}`).toBe(
            writes[token] ?? base[token] ?? ""
          );
        }
      }
    }
  );

  it("writes the raw map, and nothing derived, when there is no scheme to fit against", () => {
    for (const [mode, overrides] of MODES) {
      const root = document.createElement("div");
      applyColorVisionMode(root, mode);
      for (const [token, value] of Object.entries(overrides)) {
        expect(root.style.getPropertyValue(token), `${mode} ${token}`).toBe(value);
      }
      for (const token of DESTRUCTIVE_TOKENS) {
        expect(root.style.getPropertyValue(token), `${mode} ${token}`).toBe("");
      }
    }
  });

  it("still reaches the floor on a canvas that leaves no room for the headroom over it", () => {
    // White on #767676 is 4.54:1: past the 4.5:1 floor, short of floor plus headroom.
    const scheme = normalizeAppColorScheme({
      id: "tight-canvas",
      name: "Tight canvas",
      type: "dark",
      tokens: { "surface-canvas": "#767676" },
    });
    const root = paint(scheme, "red-green");
    const punctuation = readInk(root, "syntax-punctuation");
    expect(contrastRatio(punctuation, "#767676")).toBeGreaterThanOrEqual(4.5);
  });
});
