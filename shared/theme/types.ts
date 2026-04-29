import type { ThemePalette } from "./palette.js";

export const APP_THEME_TOKEN_KEYS = [
  // Surface hierarchy
  "surface-canvas",
  "surface-sidebar",
  "surface-toolbar",
  "surface-panel",
  "surface-panel-elevated",
  "surface-grid",
  "surface-input",
  "surface-inset",
  "surface-hover",
  "surface-active",
  "surface-disabled",

  // Text hierarchy
  "text-primary",
  "text-secondary",
  "text-muted",
  "text-placeholder",
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

  // Secondary accent (optional second color lane — e.g. sage in Bali/Table Mountain, gold in Serengeti)
  "accent-secondary",
  "accent-secondary-soft",
  "accent-secondary-muted",

  // Focus
  "focus-ring",

  // Status
  "status-success",
  "status-warning",
  "status-danger",
  "status-info",
  "status-danger-surface",

  // Activity (real-time agent states)
  "activity-active",
  "activity-idle",
  "activity-working",
  "activity-waiting",
  "activity-completed",

  // Overlay ladder
  // overlay-base is the tint color for the ladder (default: white dark / black light).
  // Set to a hued color (e.g. icy blue, warm cream) to tint all hover/fill states.
  "overlay-base",
  "overlay-subtle",
  "overlay-soft",
  "overlay-medium",
  "overlay-strong",
  "overlay-emphasis",
  "overlay-hover",
  "overlay-active",
  "overlay-selected",
  "overlay-elevated",

  // Atmospheric wash
  "wash-subtle",
  "wash-medium",
  "wash-strong",

  // Scrim
  "scrim-soft",
  "scrim-medium",
  "scrim-strong",

  // Shadow
  "shadow-color",
  "shadow-ambient",
  "shadow-floating",
  "shadow-dialog",

  // Tint (white for dark themes, black for light themes)
  "tint",

  // Material/radius strategy outputs
  "material-blur",
  "material-saturation",
  "material-opacity",
  "radius-scale",

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

  // Global UI utility tokens
  "state-chip-bg-opacity",
  "state-chip-border-opacity",
  "label-pill-bg-opacity",
  "label-pill-border-opacity",
  "scrollbar-width",
  "scrollbar-thumb",
  "scrollbar-thumb-hover",
  "scrollbar-track",
  "panel-state-edge-width",
  "panel-state-edge-inset-block",
  "panel-state-edge-radius",
  "knob-base",
  "state-modified",
  "focus-ring-offset",
  "chrome-noise-texture",

  // Diff viewer (theme-controlled)
  "diff-insert-background",
  "diff-insert-edit-background",
  "diff-delete-background",
  "diff-delete-edit-background",
  "diff-gutter-insert",
  "diff-gutter-delete",
  "diff-selected-background",
  "diff-omit-gutter-line",
] as const;

export type AppThemeTokenKey = (typeof APP_THEME_TOKEN_KEYS)[number];

export type AppColorSchemeTokens = Record<AppThemeTokenKey, string>;

export interface AppColorScheme {
  id: string;
  name: string;
  type: "dark" | "light";
  builtin: boolean;
  tokens: AppColorSchemeTokens;
  palette?: ThemePalette;
  extensions?: Record<string, string>;
  location?: string;
  heroImage?: string;
  heroVideo?: string;
}

export type ColorVisionMode = "default" | "red-green" | "blue-yellow";

export interface AppThemeConfig {
  colorSchemeId: string;
  customSchemes?: AppColorScheme[];
  colorVisionMode?: ColorVisionMode;
  followSystem?: boolean;
  preferredDarkSchemeId?: string;
  preferredLightSchemeId?: string;
  /** IDs of the most recently selected themes (LRU, newest first, capped at 5) */
  recentSchemeIds?: string[];
  /**
   * User-chosen accent color (canonical #rrggbb) that overrides the active
   * theme's accent token family. Cleared when set to null/undefined.
   */
  accentColorOverride?: string | null;
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
