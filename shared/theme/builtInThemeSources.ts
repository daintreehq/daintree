import type { ThemePalette } from "./palette.js";
import type { AppColorSchemeTokens } from "./types.js";

export interface BuiltInThemeSource {
  id: string;
  name: string;
  type: "dark" | "light";
  builtin: true;
  palette: ThemePalette;
  tokens?: Partial<AppColorSchemeTokens>;
  extensions?: Record<string, string>;
  location?: string;
  heroImage?: string;
  heroVideo?: string;
}

export { BUILT_IN_THEME_SOURCES } from "./builtInThemes/index.js";
