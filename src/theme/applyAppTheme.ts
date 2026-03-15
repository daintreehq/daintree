import { getAppThemeCssVariables, resolveAppTheme, type AppColorScheme } from "@shared/theme";
import type { ColorVisionMode } from "@shared/types";

const RED_GREEN_OVERRIDES: Record<string, string> = {
  "--theme-status-success": "#009e73",
  "--theme-status-danger": "#fe6100",
  "--theme-activity-active": "#648fff",
  "--theme-activity-working": "#648fff",
  "--theme-github-open": "#648fff",
  "--theme-github-closed": "#fe6100",
  "--theme-terminal-selection": "#1a1f2e",
  "--theme-terminal-red": "#d55e00",
  "--theme-terminal-green": "#009e73",
  "--theme-terminal-bright-red": "#fe6100",
  "--theme-terminal-bright-green": "#48c9a0",
  "--theme-terminal-magenta": "#cc79a7",
  "--theme-terminal-bright-magenta": "#d98fc4",
};

const BLUE_YELLOW_OVERRIDES: Record<string, string> = {
  "--theme-status-warning": "#94a3b8",
  "--theme-activity-waiting": "#94a3b8",
  "--theme-github-merged": "#f97316",
  "--theme-terminal-yellow": "#cc79a7",
  "--theme-terminal-blue": "#0072b2",
  "--theme-terminal-bright-yellow": "#d98fc4",
  "--theme-terminal-bright-blue": "#56b4e9",
};

const ALL_CVD_TOKENS = new Set([
  ...Object.keys(RED_GREEN_OVERRIDES),
  ...Object.keys(BLUE_YELLOW_OVERRIDES),
]);

const CVD_OVERRIDES: Record<string, Record<string, string>> = {
  "red-green": RED_GREEN_OVERRIDES,
  "blue-yellow": BLUE_YELLOW_OVERRIDES,
};

export function applyAppThemeToRoot(root: HTMLElement, scheme: AppColorScheme): void {
  const variables = getAppThemeCssVariables(scheme);

  for (const [name, value] of Object.entries(variables)) {
    root.style.setProperty(name, value);
  }

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
  const scheme = resolveAppTheme("daintree");
  applyAppThemeToRoot(root, scheme);
  return scheme;
}
