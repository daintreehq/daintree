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
  // The hairline that marks "this is the row Enter will act on" in the palettes.
  // Its own key rather than a reuse of `border-strong` because it is the only
  // border in the app that has to satisfy WCAG 1.4.11 on its own: the raised
  // fill it sits on clears barely 1.1-1.2:1 against the palette surface, so the
  // outline is the whole non-text indicator and carries the full 3:1. That puts
  // it 2-3x above the resting border ladder, which is tuned for separation
  // rather than for being the sole signal.
  "selection-outline",

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
  // Status surfaces: low-alpha tinted washes for banner/pill backgrounds.
  // Derived via withAlpha() so hex status colors emit rgba() (not the
  // color-mix(..., transparent) form, which black-shifts on light backgrounds).
  "status-danger-surface",
  "status-success-surface",
  "status-warning-surface",
  "status-info-surface",

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
  // Elevate-to-select primitive (E1). The generic "this item is selected/active/
  // armed" fill. On LIGHT it is a real upward lift (the brightest `elevated`
  // plane nudged a hair toward text — a faint cool-gray highlight, the macOS /
  // VS Code light idiom: the container recedes, the selection elevates). On DARK
  // it aliases the additive-white `overlay-selected` behavior so dark is
  // unchanged. Consumers: menu/select/palette active item, active tab, focused
  // pane, notification row / active-filter chip.
  "overlay-raised",

  // Selected-state pill backgrounds (tint-derived; neutral across hued themes)
  "filter-selected-bg-soft",
  "filter-selected-bg-strong",

  // Atmospheric wash
  "wash-subtle",
  "wash-medium",
  "wash-strong",

  // Scrim
  "scrim-soft",
  "scrim-medium",
  "scrim-strong",
  // Backdrop blur depth behind modal/palette scrims (lengths; 0 is legal)
  "scrim-blur",
  "scrim-blur-palette",

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

  // PR/issue states (provider-agnostic)
  "pr-open",
  "pr-merged",
  "pr-closed",
  "pr-draft",

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
  // Grid grain material (.bg-noise texture strength / compositing)
  "grain-opacity",
  "grain-blend",

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

// Extension tier: optional per-theme overrides for component-scoped CSS custom
// properties that are not part of the semantic-token contract. Each key is
// applied as a bare CSS variable (e.g. "sidebar-hover-bg" -> --sidebar-hover-bg)
// and must have a fallback at the consumer site. Governance is in
// shared/theme/extensionRegistry.ts; the parity + drift tests are in
// shared/theme/__tests__/builtInThemes.test.ts.
export const EXTENSION_KEYS = [
  // Chrome material (translucent inner-panel surface)
  "chrome-bg",
  "chrome-noise",
  "chrome-shadow",

  // Dialog + floating surface
  "dialog-bg",
  "dialog-header-bg",
  "dialog-shadow",
  "floating-surface-bg",
  "floating-surface-shadow",

  // Dock (docked terminal/agent dock pill)
  "dock-bg",
  "dock-border",
  "dock-input-bg",
  "dock-item-bg",
  "dock-item-bg-active",
  "dock-item-border-active",
  "dock-shadow",

  // Grid grain texture (conditionally emitted from strategy.grainCharacter)
  "grain-image",

  // Panel chrome (per-pane title bars)
  "panel-header-bg",
  "panel-header-focus-bg",

  // Panel focus chrome (focused/selected pane border ink, glow, fill)
  "panel-focus-border",
  "panel-focus-shadow",
  "panel-selected-bg",

  // Panel grid background
  "panel-grid-bg",
  "terminal-grid-bg",

  // Project identity tiles (emoji chips in switcher/palette/welcome rows)
  "project-tile-shadow",
  "project-tile-wash",

  // Pulse (work-pulse heatmap)
  "pulse-before-bg",
  "pulse-card-bg",
  "pulse-card-header-bg",
  "pulse-card-shadow",
  "pulse-control-hover-bg",
  "pulse-empty-bg",
  "pulse-heat-color",
  "pulse-heat-1",
  "pulse-heat-2",
  "pulse-heat-3",
  "pulse-heat-4",
  "pulse-heat-high-opacity",
  "pulse-heat-low-opacity",
  "pulse-heat-medium-opacity",
  "pulse-range-bg",
  "pulse-ring-offset",
  "pulse-skeleton-gradient",
  "pulse-streak-1",
  "pulse-streak-2",
  "pulse-streak-3",
  "pulse-streak-4",
  "pulse-streak-5",
  "pulse-streak-6",
  "pulse-streak-7",

  // Settings tab
  "settings-card-bg",
  "settings-dialog-bg",
  "settings-kbd-bg",
  "settings-kbd-border",
  "settings-list-item-bg",
  "settings-meta-fg",
  "settings-meta-size",
  "settings-nav-active-bg",
  "settings-nav-active-shadow",
  "settings-nav-hover-bg",
  "settings-scope-bg",
  "settings-search-bg",
  "settings-search-muted",
  "settings-section-header-bg",
  "settings-section-header-bg-solid",
  "settings-sidebar-bg",
  "settings-sidebar-scroll-fade",

  // Sidebar interaction
  "sidebar-action-hover-bg",
  "sidebar-active-bg",
  "sidebar-card-bg",
  "sidebar-card-shadow",
  "sidebar-hover-bg",

  // Toolbar
  "toolbar-agent-hover-bg",
  "toolbar-bg",
  "toolbar-control-active-bg",
  "toolbar-control-armed-bg",
  "toolbar-control-armed-shadow",
  "toolbar-control-hover-bg",
  "toolbar-control-hover-fg",
  "toolbar-control-hover-shadow",
  "toolbar-divider",
  "toolbar-noise",
  "toolbar-pill-radius",
  "toolbar-shadow",

  // Toolbar project pill
  "toolbar-project-bg",
  "toolbar-project-border",
  "toolbar-project-chip-bg",
  "toolbar-project-chip-border",
  "toolbar-project-chip-size",
  "toolbar-project-meta-fg",
  "toolbar-project-shadow",

  // Toolbar stats pill
  "toolbar-stats-bg",
  "toolbar-stats-border",
  "toolbar-stats-divider",
  "toolbar-stats-hover-bg",
  "toolbar-stats-shadow",

  // Review hub
  "review-commit-input-bg",

  // Welcome screen
  // Ambient restraint on third-party brand marks (agent/product logos). A
  // saturation multiplier consumed by `.brand-mark` in src/index.css; 1 (the
  // fallback) leaves every existing theme byte-for-byte unchanged. Themes that
  // run a contrast budget can damp brand chroma so a row of vendor logos stops
  // out-shouting the theme's own signals.
  "brand-mark-saturation",

  "welcome-field-wash",
  "welcome-mark-color",

  // Worktree section
  "worktree-section-hover-bg",
  "worktree-filter-bar-bg",
  "worktree-quick-state-active-bg",
  "worktree-search-input-bg",
] as const;

export type ExtensionKey = (typeof EXTENSION_KEYS)[number];

export interface AppColorScheme {
  id: string;
  name: string;
  type: "dark" | "light";
  builtin: boolean;
  tokens: AppColorSchemeTokens;
  palette?: ThemePalette;
  extensions?: Partial<Record<ExtensionKey, string>>;
  location?: string;
  heroImage?: string;
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

/**
 * Categorises a theme-import warning so the UI can show one plain-language line
 * per kind instead of the raw engine diagnostic. The raw `message` is retained
 * for theme authors behind a technical-details disclosure.
 */
export type AppThemeWarningKind =
  | "type-inferred"
  | "unknown-tokens"
  | "low-contrast"
  | "terminal-legibility"
  | "unevaluable"
  | "accent-rgb-fallback"
  | "overlay-contrast";

export interface AppThemeValidationWarning {
  kind: AppThemeWarningKind;
  /** Raw engine diagnostic — developer-facing, shown only under a details affordance. */
  message: string;
}

export type AppThemeImportResult =
  | {
      ok: true;
      scheme: AppColorScheme;
      warnings: AppThemeValidationWarning[];
    }
  | { ok: false; errors: string[] };
