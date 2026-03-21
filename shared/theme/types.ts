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

  // Activity (real-time agent states)
  "activity-active",
  "activity-idle",
  "activity-working",
  "activity-waiting",
  "activity-approval",
  "activity-completed",
  "activity-failed",

  // Overlay ladder
  // overlay-base is the tint color for the ladder (default: white dark / black light).
  // Set to a hued color (e.g. icy blue, warm cream) to tint all hover/fill states.
  "overlay-base",
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

  // Scrollbar recipe
  "recipe-scrollbar-width",
  "recipe-scrollbar-thumb",
  "recipe-scrollbar-thumb-hover",
  "recipe-scrollbar-track",

  // Panel state edge recipe (left rail on panel headers; disabled via width:0 for themes without it)
  "recipe-panel-state-edge-width",
  "recipe-panel-state-edge-inset-block",
  "recipe-panel-state-edge-radius",

  // Control chrome recipe (panel/palette shadows and raised-surface highlights)
  "recipe-control-chrome-raised-shadow",
  "recipe-control-chrome-pressed-shadow",

  // Surface elevation sheen — inset top-edge highlight on elevated surfaces
  // (dialogs, palettes, tooltips, active sidebar cards). Set to "none" to disable.
  "recipe-surface-elevated-inset-shadow",

  // Shadow profiles — complete box-shadow values including geometry + blur
  // Themes set these to express their shadow personality (crisp, fog-diffused, soft, etc.)
  "recipe-shadow-ambient",
  "recipe-shadow-floating",

  // Focus ring offset in px (default 2px; some themes prefer 3px for breathing room)
  "recipe-focus-ring-offset",

  // Sidebar active card — the selected worktree card bg and shadow.
  // Dark themes: overlay-base tint (lightens) + inset sheen; Light themes: surface-panel-elevated + drop shadow.
  // Themes can override for accent-tinted selections (e.g. Galápagos, Redwoods).
  "recipe-sidebar-active-bg",
  "recipe-sidebar-active-shadow",

  // Chrome noise texture — CSS background-image layer for grain on sidebar/toolbar/dock.
  // Set to a data-URI SVG noise filter or "none" (default). Requires component support.
  "recipe-chrome-noise-texture",

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
  location?: string;
  heroImage?: string;
  heroVideo?: string;
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
