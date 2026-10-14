import {
  BUILT_IN_APP_SCHEMES,
  DEFAULT_APP_SCHEME_ID,
  getAppThemeCssVariables,
} from "../../../../../shared/theme/themes.js";

/** One of Daintree's built-in themes, as the preview offers it. */
export interface PreviewTheme {
  readonly id: string;
  readonly name: string;
  readonly type: "dark" | "light";
}

/** Every built-in theme, in the app's own order. */
export const PREVIEW_THEMES: readonly PreviewTheme[] = BUILT_IN_APP_SCHEMES.map(
  ({ id, name, type }) => ({ id, name, type })
);

export const DEFAULT_PREVIEW_THEME_ID = DEFAULT_APP_SCHEME_ID;

const VARIABLE_KEYS_ATTRIBUTE = "themeVariableKeys";

/**
 * Apply a built-in theme to `root` the way the app applies it to its document
 * root: the same `--theme-*` variables and extension variables, the same
 * `data-theme` / `data-color-mode` attributes, `color-scheme`, and the
 * `dark`/`light` class. Switching is in place — variables the previous theme
 * set and this one does not are removed — so no reload is needed.
 *
 * Throws on an id that is not a built-in theme, rather than quietly falling
 * back and capturing the wrong theme.
 */
export function applyPreviewTheme(root: HTMLElement, themeId: string): PreviewTheme {
  const scheme = BUILT_IN_APP_SCHEMES.find((candidate) => candidate.id === themeId);
  if (!scheme) {
    const known = PREVIEW_THEMES.map((theme) => theme.id).join(", ");
    throw new Error(`Unknown preview theme "${themeId}". Built-in themes: ${known}`);
  }
  const variables = getAppThemeCssVariables(scheme);
  const previous = root.dataset[VARIABLE_KEYS_ATTRIBUTE]?.split("|").filter(Boolean) ?? [];
  for (const name of previous) {
    if (!(name in variables)) root.style.removeProperty(name);
  }
  for (const [name, value] of Object.entries(variables)) root.style.setProperty(name, value);
  root.dataset[VARIABLE_KEYS_ATTRIBUTE] = Object.keys(variables).join("|");
  root.dataset.theme = scheme.id;
  root.dataset.colorMode = scheme.type;
  root.style.colorScheme = scheme.type;
  root.classList.toggle("dark", scheme.type === "dark");
  root.classList.toggle("light", scheme.type === "light");
  return { id: scheme.id, name: scheme.name, type: scheme.type };
}
