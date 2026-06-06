import {
  getAppThemeById,
  getAppThemeCssVariables,
  resolveAppTheme,
  type AppColorScheme,
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
