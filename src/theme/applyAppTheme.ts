import {
  getAppThemeById,
  getAppThemeCssVariables,
  resolveAppTheme,
  RED_GREEN_OVERRIDES,
  BLUE_YELLOW_OVERRIDES,
  ALL_CVD_TOKENS,
  type AppColorScheme,
} from "@shared/theme";
import type { ColorVisionMode } from "@shared/types";

// Re-export for consumers that haven't migrated to @shared/theme
export { RED_GREEN_OVERRIDES, BLUE_YELLOW_OVERRIDES, ALL_CVD_TOKENS };

const CVD_OVERRIDES: Record<string, Record<string, string>> = {
  "red-green": RED_GREEN_OVERRIDES,
  "blue-yellow": BLUE_YELLOW_OVERRIDES,
};

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

export function applyColorVisionMode(root: HTMLElement, mode: ColorVisionMode): void {
  // Remove all previous CVD inline overrides so base theme values show through
  for (const token of ALL_CVD_TOKENS) {
    root.style.removeProperty(token);
  }

  if (mode === "default") {
    delete root.dataset.colorblind;
    return;
  }

  root.dataset.colorblind = mode;

  // Re-apply base theme values for tokens we're about to override,
  // then set CVD overrides as inline styles (same specificity as base theme)
  const overrides = CVD_OVERRIDES[mode];
  if (overrides) {
    for (const [name, value] of Object.entries(overrides)) {
      root.style.setProperty(name, value);
    }
  }
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
