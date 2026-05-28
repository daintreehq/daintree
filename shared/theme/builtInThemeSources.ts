import type { ThemePalette } from "./palette.js";
import type { AppColorSchemeTokens, ExtensionKey } from "./types.js";

export interface BuiltInThemeSource {
  id: string;
  name: string;
  type: "dark" | "light";
  builtin: true;
  palette: ThemePalette;
  tokens?: Partial<AppColorSchemeTokens>;
  extensions?: Partial<Record<ExtensionKey, string>>;
  location?: string;
  heroImage?: string;
}

export { BUILT_IN_THEME_SOURCES } from "./builtInThemes/index.js";
