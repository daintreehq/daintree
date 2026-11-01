/**
 * Color-vision-deficiency override maps, and the writes a mode makes over a
 * theme, kept out of the runtime applyAppTheme module so they can be tested
 * without importing DOM-coupled renderer code.
 *
 * Each map stores hardcoded hex values that replace theme tokens when a CVD mode
 * is active. The maps are hand-authored to maintain distinguishability under
 * protanopia / deuteranopia (red-green) and tritanopia (blue-yellow).
 */

import {
  ACTIVITY_TEXT_INKS,
  STATUS_INK_CONTRAST,
  STATUS_TEXT_INKS,
  SYNTAX_CANVAS_FLOORS,
  SYNTAX_CANVAS_SURFACE,
  isHexColor,
} from "./contrast.js";
import { liftToContrast } from "./oklch.js";
import {
  deriveActivityTextInks,
  deriveDestructiveAction,
  deriveDiffTextInks,
  deriveStatusTextInks,
} from "./themes.js";
import type { AppColorScheme, AppThemeTokenKey, ColorVisionMode } from "./types.js";

// Status base token -> its derived surface-wash token. When CVD mode patches a
// status base color, the pre-baked surface rgba (computed from the *original*
// hue) would otherwise leak through on banners/pills that consume the surface
// token directly (e.g. GridNotificationBar's bg-status-*-surface). Re-deriving
// the surface from the override keeps the wash on-hue.
const STATUS_SURFACE_TOKENS: Record<string, string> = {
  "--theme-status-success": "--theme-status-success-surface",
  "--theme-status-danger": "--theme-status-danger-surface",
  "--theme-status-warning": "--theme-status-warning-surface",
  "--theme-status-info": "--theme-status-info-surface",
};

// Status base token -> its text-grade twin, which git status letters paint. Like
// the churn inks below it is lifted against the active theme's own surfaces, so
// the raw override stands in here and `applyColorVisionMode` lifts it whenever
// it has the scheme.
const STATUS_TEXT_TOKENS: Record<string, string> = {
  "--theme-status-success": "--theme-status-success-text",
  "--theme-status-danger": "--theme-status-danger-text",
  "--theme-status-warning": "--theme-status-warning-text",
  "--theme-status-info": "--theme-status-info-text",
};

// Activity ink -> its text-grade twin, which the switcher's status sentences
// paint. Lifted the same way as the status letter inks above.
const ACTIVITY_TEXT_TOKENS: Record<string, string> = Object.fromEntries(
  Object.entries(ACTIVITY_TEXT_INKS).map(([activity, text]) => [
    `--theme-${activity}`,
    `--theme-${text}`,
  ])
);

// Wash alpha for the derived surfaces. The engine uses 0.10 (dark) / 0.08
// (light); these static overrides apply across both polarities, and the
// perceptual gap between those alphas on a low-alpha wash is negligible — the
// hue match is what matters under CVD.
const CVD_STATUS_SURFACE_ALPHA = 0.1;

// Status base token -> the diff tokens re-derived from it. The light-mode
// diff-viewer CSS (.light .diff-viewer) reads the pre-baked --color-diff-*
// tokens, which themes.ts derives from status-success / status-danger at
// theme-build time. Patching --theme-status-* at runtime doesn't re-derive
// these, so a CVD override would otherwise leave light-mode diff fills, edit
// highlights, and gutters on the original (non-CVD) hue. Re-derive them here.
// Dark mode is unaffected (its CSS reads --color-status-* directly), so we use
// the light-polarity alphas only.
//
// The churn text inks are lifted against the active theme's own surfaces, which
// a theme-independent map can't know. The raw override stands in here, and
// `applyColorVisionMode` lifts it whenever it has the scheme.
const CVD_DIFF_BACKGROUND_ALPHA = 0.1;
const CVD_DIFF_EDIT_BACKGROUND_ALPHA = 0.2;

const STATUS_DIFF_TOKENS: Record<
  string,
  { background: string; editBackground: string; gutter: string; text: string }
> = {
  "--theme-status-success": {
    background: "--theme-diff-insert-background",
    editBackground: "--theme-diff-insert-edit-background",
    gutter: "--theme-diff-gutter-insert",
    text: "--theme-diff-text-insert",
  },
  "--theme-status-danger": {
    background: "--theme-diff-delete-background",
    editBackground: "--theme-diff-delete-edit-background",
    gutter: "--theme-diff-gutter-delete",
    text: "--theme-diff-text-delete",
  },
};

// Expects a 3- or 6-digit hex string (the form every override value uses).
// Non-hex input (oklch(), rgb(), 8-digit hex) yields rgba(NaN, …), which CSS
// silently drops — keep the maps hex-only.
function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace("#", "");
  const expanded =
    clean.length === 3
      ? clean
          .split("")
          .map((char) => `${char}${char}`)
          .join("")
      : clean;
  const red = parseInt(expanded.slice(0, 2), 16);
  const green = parseInt(expanded.slice(2, 4), 16);
  const blue = parseInt(expanded.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function withStatusSurfaces(overrides: Record<string, string>): Record<string, string> {
  const result = { ...overrides };
  for (const [baseToken, surfaceToken] of Object.entries(STATUS_SURFACE_TOKENS)) {
    const hex = overrides[baseToken];
    if (hex) result[surfaceToken] = hexToRgba(hex, CVD_STATUS_SURFACE_ALPHA);
  }
  for (const [baseToken, textToken] of Object.entries({
    ...STATUS_TEXT_TOKENS,
    ...ACTIVITY_TEXT_TOKENS,
  })) {
    const hex = overrides[baseToken];
    if (hex) result[textToken] = hex;
  }
  return result;
}

function withDiffSurfaces(overrides: Record<string, string>): Record<string, string> {
  const result = { ...overrides };
  for (const [baseToken, diffTokens] of Object.entries(STATUS_DIFF_TOKENS)) {
    const hex = overrides[baseToken];
    if (!hex) continue;
    result[diffTokens.background] = hexToRgba(hex, CVD_DIFF_BACKGROUND_ALPHA);
    result[diffTokens.editBackground] = hexToRgba(hex, CVD_DIFF_EDIT_BACKGROUND_ALPHA);
    result[diffTokens.gutter] = hex;
    result[diffTokens.text] = hex;
  }
  return result;
}

export const RED_GREEN_OVERRIDES: Record<string, string> = withDiffSurfaces(
  withStatusSurfaces({
    "--theme-status-success": "#009e73",
    "--theme-status-danger": "#fe6100",
    "--theme-activity-active": "#648fff",
    "--theme-activity-working": "#648fff",
    "--theme-pr-open": "#648fff",
    "--theme-pr-closed": "#fe6100",
    "--theme-terminal-selection": "#1a1f2e",
    "--theme-terminal-red": "#d55e00",
    "--theme-terminal-green": "#009e73",
    "--theme-terminal-bright-red": "#fe6100",
    "--theme-terminal-bright-green": "#48c9a0",
    "--theme-terminal-magenta": "#cc79a7",
    "--theme-terminal-bright-magenta": "#d98fc4",
    "--theme-syntax-comment": "#999999",
    "--theme-syntax-punctuation": "#555555",
    "--theme-syntax-number": "#0072B2",
    "--theme-syntax-string": "#E69F00",
    "--theme-syntax-operator": "#555555",
    "--theme-syntax-keyword": "#D55E00",
    "--theme-syntax-function": "#0072B2",
    "--theme-syntax-link": "#0072B2",
    "--theme-syntax-quote": "#009E73",
    "--theme-syntax-chip": "#CC79A7",
    "--theme-category-blue": "#0072b2",
    "--theme-category-orange": "#e69f00",
    "--theme-category-teal": "#009e73",
    "--theme-category-pink": "#cc79a7",
    "--theme-category-amber": "#d55e00",
    "--theme-category-violet": "#785ef0",
    "--theme-category-indigo": "#648fff",
    "--theme-category-cyan": "#56b4e9",
  })
);

export const BLUE_YELLOW_OVERRIDES: Record<string, string> = withDiffSurfaces(
  withStatusSurfaces({
    "--theme-status-warning": "#94a3b8",
    "--theme-activity-waiting": "#94a3b8",
    "--theme-pr-merged": "#f97316",
    "--theme-terminal-yellow": "#cc79a7",
    "--theme-terminal-blue": "#0072b2",
    "--theme-terminal-bright-yellow": "#d98fc4",
    "--theme-terminal-bright-blue": "#56b4e9",
    "--theme-status-info": "#333333",
    "--theme-syntax-comment": "#999999",
    "--theme-syntax-punctuation": "#555555",
    "--theme-syntax-number": "#CC79A7",
    "--theme-syntax-string": "#E69F00",
    "--theme-syntax-operator": "#555555",
    "--theme-syntax-keyword": "#D55E00",
    "--theme-syntax-function": "#56B4E9",
    "--theme-syntax-link": "#0072B2",
    "--theme-syntax-quote": "#F0E442",
    "--theme-syntax-chip": "#009E73",
    "--theme-category-blue": "#dc267f",
    "--theme-category-orange": "#fe6100",
    "--theme-category-teal": "#009e73",
    "--theme-category-pink": "#d55e00",
    "--theme-category-amber": "#ffb000",
    "--theme-category-violet": "#785ef0",
    "--theme-category-indigo": "#648fff",
    "--theme-category-cyan": "#228833",
  })
);

export const ALL_CVD_TOKENS: ReadonlySet<string> = new Set([
  ...Object.keys(RED_GREEN_OVERRIDES),
  ...Object.keys(BLUE_YELLOW_OVERRIDES),
]);

const COLOR_VISION_OVERRIDES: Partial<Record<ColorVisionMode, Record<string, string>>> = {
  "red-green": RED_GREEN_OVERRIDES,
  "blue-yellow": BLUE_YELLOW_OVERRIDES,
};

// Each text ink lifted from a status ink, beside the status ink it follows.
const LIFTED_TEXT_INKS: ReadonlyArray<readonly [AppThemeTokenKey, AppThemeTokenKey]> = [
  ["diff-text-insert", "status-success"],
  ["diff-text-delete", "status-danger"],
  ...(Object.entries(STATUS_TEXT_INKS) as Array<[AppThemeTokenKey, AppThemeTokenKey]>).map(
    ([status, text]) => [text, status] as const
  ),
  ...(Object.entries(ACTIVITY_TEXT_INKS) as Array<[AppThemeTokenKey, AppThemeTokenKey]>).map(
    ([activity, text]) => [text, activity] as const
  ),
];

// Headroom over each floor for the compositor rounding a channel the other way,
// the same margin the theme's own derived inks take.
const FIT_HEADROOM = 0.05;

/**
 * Everything a colour-vision mode writes over `scheme`. The maps hold one hex per
 * token for both polarities, so each syntax and graphical status ink a mode swaps
 * in is moved along lightness, at its own hue, until it holds the floor this
 * theme's own ink is held to on this theme's surfaces (#15580). The text inks and
 * the destructive fill that follow a status or activity ink are then derived from
 * the ink the mode actually paints, the way the theme derives its own; one whose
 * source ink the mode leaves alone keeps the theme's. Without a scheme the map's raw values
 * are all there is.
 */
export function getColorVisionWrites(
  mode: ColorVisionMode,
  scheme?: AppColorScheme
): Record<string, string> {
  const overrides = COLOR_VISION_OVERRIDES[mode];
  if (!overrides) return {};
  const writes = { ...overrides };
  if (!scheme) return writes;
  const effective: Partial<Record<AppThemeTokenKey, string>> = { ...scheme.tokens };
  for (const [name, value] of Object.entries(overrides)) {
    effective[name.slice("--theme-".length) as AppThemeTokenKey] = value;
  }

  const fit = (
    token: AppThemeTokenKey,
    surfaces: readonly AppThemeTokenKey[],
    minimum: number
  ): void => {
    const seed = overrides[`--theme-${token}`];
    if (seed === undefined) return;
    // A surface the hex maths can't read (a custom theme's `color-mix()`) is left
    // out rather than guessed at; with none left the raw value stands.
    const backdrops = surfaces
      .map((surface) => scheme.tokens[surface])
      .filter((value): value is string => typeof value === "string" && isHexColor(value));
    let ink = liftToContrast(seed, backdrops, minimum + FIT_HEADROOM, scheme.type);
    // A custom surface can leave room for the floor but not the headroom over it
    // (a dark canvas at #767676 takes white to 4.54:1); the floor still holds.
    if (ink === seed) ink = liftToContrast(seed, backdrops, minimum, scheme.type);
    effective[token] = ink;
    writes[`--theme-${token}`] = ink;
  };
  for (const [token, floor] of SYNTAX_CANVAS_FLOORS) fit(token, [SYNTAX_CANVAS_SURFACE], floor);
  for (const token of STATUS_INK_CONTRAST.inks) {
    fit(token, STATUS_INK_CONTRAST.surfaces, STATUS_INK_CONTRAST.minimum);
  }

  const inks: Partial<Record<AppThemeTokenKey, string>> = {
    ...deriveDiffTextInks(effective, scheme.type),
    ...deriveStatusTextInks(effective, scheme.type),
    ...deriveActivityTextInks(effective, scheme.type),
  };
  for (const [token, status] of LIFTED_TEXT_INKS) {
    const ink = inks[token];
    if (`--theme-${status}` in overrides && ink !== undefined) writes[`--theme-${token}`] = ink;
  }
  // The destructive button's fills are derived from the danger ink too, so a mode
  // that swaps the danger hue re-derives them rather than leaving the old red.
  if ("--theme-status-danger" in overrides) {
    for (const [token, value] of Object.entries(deriveDestructiveAction(effective, scheme.type))) {
      if (value !== undefined) writes[`--theme-${token}`] = value;
    }
  }
  return writes;
}
