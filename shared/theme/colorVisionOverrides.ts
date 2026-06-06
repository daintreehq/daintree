/**
 * Color-vision-deficiency override maps extracted from the runtime applyAppTheme
 * module so they can be tested without importing DOM-coupled renderer code.
 *
 * Each map stores hardcoded hex values that replace theme tokens when a CVD mode
 * is active. The maps are hand-authored to maintain distinguishability under
 * protanopia / deuteranopia (red-green) and tritanopia (blue-yellow).
 */

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
const CVD_DIFF_BACKGROUND_ALPHA = 0.1;
const CVD_DIFF_EDIT_BACKGROUND_ALPHA = 0.2;

const STATUS_DIFF_TOKENS: Record<
  string,
  { background: string; editBackground: string; gutter: string }
> = {
  "--theme-status-success": {
    background: "--theme-diff-insert-background",
    editBackground: "--theme-diff-insert-edit-background",
    gutter: "--theme-diff-gutter-insert",
  },
  "--theme-status-danger": {
    background: "--theme-diff-delete-background",
    editBackground: "--theme-diff-delete-edit-background",
    gutter: "--theme-diff-gutter-delete",
  },
};

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
