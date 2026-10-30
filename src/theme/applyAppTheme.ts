import {
  STATUS_TEXT_INKS,
  deriveDestructiveAction,
  deriveDiffTextInks,
  deriveStatusTextInks,
  getAppThemeById,
  getAppThemeCssVariables,
  resolveAppTheme,
  type AppColorScheme,
  type AppThemeTokenKey,
} from "@shared/theme";
import {
  RED_GREEN_OVERRIDES,
  BLUE_YELLOW_OVERRIDES,
  ALL_CVD_TOKENS,
} from "@shared/theme/colorVisionOverrides.js";
import type { ColorVisionMode } from "@shared/types";

// Re-export for consumers that haven't migrated to @shared/theme
export { RED_GREEN_OVERRIDES, BLUE_YELLOW_OVERRIDES, ALL_CVD_TOKENS };

const CVD_OVERRIDES: Record<string, Record<string, string>> = {
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
];

// Written only alongside a scheme (see `getColorVisionWrites`), so they are not in
// the static maps' key set and are restored only when there is a scheme to read.
const DESTRUCTIVE_CVD_TOKENS = [
  "--theme-destructive-fill",
  "--theme-destructive-fill-hover",
  "--theme-destructive-fill-active",
  "--theme-destructive-foreground",
] as const;

/**
 * Everything a colour-vision mode writes over `scheme`. A text ink whose status
 * ink the mode replaced is that override lifted to read as text on this theme's
 * surfaces, which the static map can't do on its own; one whose status ink the
 * mode leaves alone keeps the theme's. Without a scheme the map's raw stand-ins
 * are all there is.
 */
function getColorVisionWrites(
  mode: ColorVisionMode,
  scheme?: AppColorScheme
): Record<string, string> {
  const overrides = CVD_OVERRIDES[mode];
  if (!overrides) return {};
  const writes = { ...overrides };
  if (!scheme) return writes;
  const effective: Partial<Record<AppThemeTokenKey, string>> = { ...scheme.tokens };
  for (const [name, value] of Object.entries(overrides)) {
    effective[name.slice("--theme-".length) as AppThemeTokenKey] = value;
  }
  const inks: Partial<Record<AppThemeTokenKey, string>> = {
    ...deriveDiffTextInks(effective, scheme.type),
    ...deriveStatusTextInks(effective, scheme.type),
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

export function applyAppThemeToRoot(root: HTMLElement, scheme: AppColorScheme): void {
  const variables = getAppThemeCssVariables(scheme);
  const previousVariableKeys = root.dataset.themeVariableKeys
    ? root.dataset.themeVariableKeys.split("|").filter(Boolean)
    : [];

  for (const name of previousVariableKeys) {
    if (!(name in variables)) {
      root.style.removeProperty(name);
    }
  }

  for (const [name, value] of Object.entries(variables)) {
    root.style.setProperty(name, value);
  }

  root.dataset.themeVariableKeys = Object.keys(variables).join("|");
  root.dataset.theme = scheme.id;
  root.dataset.colorMode = scheme.type;
  root.style.colorScheme = scheme.type;
  root.classList.toggle("dark", scheme.type === "dark");
  root.classList.toggle("light", scheme.type === "light");
}

export function applyColorVisionMode(
  root: HTMLElement,
  mode: ColorVisionMode,
  scheme?: AppColorScheme
): void {
  // Undo any previous CVD override. The --theme-* tokens have no stylesheet
  // fallback — they exist only as the inline styles written by
  // applyAppThemeToRoot — so removing the inline property leaves them undefined
  // rather than revealing a base value. When the active scheme is known, restore
  // each token to its base value; this matters for tokens a mode doesn't itself
  // override (e.g. blue-yellow leaves status-success/-danger and the light-mode
  // diff fills derived from them, which a bare removeProperty would erase). Fall
  // back to removeProperty when no scheme is supplied.
  const baseVariables = scheme ? getAppThemeCssVariables(scheme) : null;
  for (const token of DESTRUCTIVE_CVD_TOKENS) {
    const baseValue = baseVariables?.[token];
    if (baseValue != null) root.style.setProperty(token, baseValue);
  }
  for (const token of ALL_CVD_TOKENS) {
    const baseValue = baseVariables?.[token];
    if (baseValue != null) {
      root.style.setProperty(token, baseValue);
    } else {
      root.style.removeProperty(token);
    }
  }

  if (mode === "default") {
    delete root.dataset.colorblind;
    return;
  }

  root.dataset.colorblind = mode;

  // Layer the CVD overrides on top as inline styles (same specificity as the
  // base theme).
  for (const [name, value] of Object.entries(getColorVisionWrites(mode, scheme))) {
    root.style.setProperty(name, value);
  }
}

/** The OS appearance, read defensively: test environments have no `matchMedia`. */
export function systemPrefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
}

export function applyDefaultAppTheme(root: HTMLElement): AppColorScheme {
  // Prefer the persisted scheme seeded by the main process (via preload) so the
  // first paint matches the saved theme instead of flashing a
  // prefers-color-scheme default before the async theme config resolves (#9169).
  // Only built-in ids resolve synchronously here — custom schemes load during
  // the async useAppThemeConfig phase, so an unknown id falls through to the
  // prefers-color-scheme default rather than painting the wrong built-in theme.
  const seededId = window.__DAINTREE_INITIAL_THEME__?.colorSchemeId;
  const seededScheme = seededId ? getAppThemeById(seededId) : undefined;
  if (seededScheme) {
    applyAppThemeToRoot(root, seededScheme);
    return seededScheme;
  }

  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const schemeId = prefersDark ? "daintree" : "bondi";
  const scheme = resolveAppTheme(schemeId);
  applyAppThemeToRoot(root, scheme);
  return scheme;
}
