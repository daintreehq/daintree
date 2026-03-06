import { getAppThemeCssVariables, resolveAppTheme, type AppColorScheme } from "@shared/theme";

export function applyAppThemeToRoot(root: HTMLElement, scheme: AppColorScheme): void {
  const variables = getAppThemeCssVariables(scheme);

  for (const [name, value] of Object.entries(variables)) {
    root.style.setProperty(name, value);
  }

  root.dataset.theme = scheme.id;
  root.dataset.colorMode = scheme.type;
  root.classList.toggle("dark", scheme.type === "dark");
  root.classList.toggle("light", scheme.type === "light");
}

export function applyDefaultAppTheme(root: HTMLElement): AppColorScheme {
  const scheme = resolveAppTheme("canopy");
  applyAppThemeToRoot(root, scheme);
  return scheme;
}
