export const APP_THEME_TOKEN_KEYS = [
  // Surface hierarchy
  "surface-canvas",
  "surface-sidebar",
  "surface-panel",
  "surface-panel-elevated",
  "surface-grid",
  "surface-input",
  "surface-inset",
  "surface-hover",
  "surface-active",

  // Text hierarchy
  "text-primary",
  "text-secondary",
  "text-muted",
  "text-inverse",
  "text-link",

  // Borders
  "border-default",
  "border-subtle",
  "border-strong",
  "border-divider",
  "border-interactive",

  // Accent
  "accent-primary",
  "accent-hover",
  "accent-foreground",
  "accent-soft",
  "accent-muted",
  "accent-rgb",

  // Focus
  "focus-ring",

  // Status
  "status-success",
  "status-warning",
  "status-danger",
  "status-info",

  // Activity (real-time agent states)
  "activity-active",
  "activity-idle",
  "activity-working",
  "activity-waiting",
  "activity-approval",
  "activity-completed",
  "activity-failed",

  // Overlay ladder
  "overlay-subtle",
  "overlay-soft",
  "overlay-medium",
  "overlay-strong",
  "overlay-emphasis",

  // Scrim
  "scrim-soft",
  "scrim-medium",
  "scrim-strong",

  // Shadow
  "shadow-color",

  // Tint (white for dark themes, black for light themes)
  "tint",

  // GitHub PR/issue states
  "github-open",
  "github-merged",
  "github-closed",
  "github-draft",

  // Search highlighting (independent of accent)
  "search-highlight-background",
  "search-highlight-text",
  "search-selected-result-border",
  "search-selected-result-icon",
  "search-match-badge-background",
  "search-match-badge-text",

  // Terminal (first-class layer, independent of workbench)
  "terminal-background",
  "terminal-foreground",
  "terminal-muted",
  "terminal-cursor",
  "terminal-cursor-accent",
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

  // Syntax highlighting
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

  // Category hues (12 perceptually uniform colors)
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

  // Recipes — per-theme parametric values
  "recipe-state-chip-bg-opacity",
  "recipe-state-chip-border-opacity",
  "recipe-label-pill-bg-opacity",
  "recipe-label-pill-border-opacity",
  "recipe-button-inset-shadow",
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
