export const APP_THEME_TOKEN_KEYS = [
  "surface-canvas",
  "surface-sidebar",
  "surface-panel",
  "surface-panel-elevated",
  "surface-grid",
  "text-primary",
  "text-secondary",
  "text-muted",
  "text-inverse",
  "border-default",
  "border-subtle",
  "border-strong",
  "border-divider",
  "accent-primary",
  "accent-foreground",
  "accent-soft",
  "accent-muted",
  "focus-ring",
  "status-success",
  "status-warning",
  "status-danger",
  "status-info",
  "activity-active",
  "activity-idle",
  "activity-working",
  "activity-waiting",
  "overlay-subtle",
  "overlay-soft",
  "overlay-medium",
  "overlay-strong",
  "overlay-emphasis",
  "scrim-soft",
  "scrim-medium",
  "scrim-strong",
  "github-open",
  "github-merged",
  "github-closed",
  "github-draft",
  "terminal-selection",
  "terminal-black",
  "terminal-red",
  "terminal-green",
  "terminal-yellow",
  "terminal-blue",
  "terminal-magenta",
  "terminal-cyan",
  "terminal-white",
  "terminal-bright-black",
  "terminal-bright-red",
  "terminal-bright-green",
  "terminal-bright-yellow",
  "terminal-bright-blue",
  "terminal-bright-magenta",
  "terminal-bright-cyan",
  "terminal-bright-white",
  "syntax-comment",
  "syntax-punctuation",
  "syntax-number",
  "syntax-string",
  "syntax-operator",
  "syntax-keyword",
  "syntax-function",
  "syntax-link",
  "syntax-quote",
  "syntax-chip",
  "category-blue",
  "category-purple",
  "category-cyan",
  "category-green",
  "category-amber",
  "category-orange",
  "category-teal",
  "category-indigo",
  "category-rose",
  "category-pink",
  "category-violet",
  "category-slate",
] as const;

export type AppThemeTokenKey = (typeof APP_THEME_TOKEN_KEYS)[number];

export type AppColorSchemeTokens = Record<AppThemeTokenKey, string>;

export interface AppColorScheme {
  id: string;
  name: string;
  type: "dark" | "light";
  builtin: boolean;
  tokens: AppColorSchemeTokens;
}

export type ColorVisionMode = "default" | "red-green" | "blue-yellow";

export interface AppThemeConfig {
  colorSchemeId: string;
  customSchemes?: string;
  colorVisionMode?: ColorVisionMode;
}

export interface AppThemeValidationWarning {
  message: string;
}

export type AppThemeImportResult =
  | {
      ok: true;
      scheme: AppColorScheme;
      warnings: AppThemeValidationWarning[];
    }
  | { ok: false; errors: string[] };
