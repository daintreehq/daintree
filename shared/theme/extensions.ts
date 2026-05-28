/**
 * Canonical registry for the theme extensions tier.
 *
 * Extension keys are component-scoped CSS hooks (applied as bare `--{key}` custom
 * properties, never the `--theme-{key}` semantic namespace) that a theme may set to
 * override a value the component stylesheet would otherwise fall back to. Unlike the
 * semantic tier (`APP_THEME_TOKEN_KEYS`), which every theme must define in full, most
 * extension keys are optional cosmetic overrides — but a few have a fallback that is
 * invisible or wrong, so every applicable built-in theme must define them.
 *
 * `required: true` marks the keys whose CSS fallback is not safe to inherit:
 *   - sidebar-hover-bg / sidebar-active-bg — white-tinted fallback is invisible on light themes
 *   - pulse-missed-bg — must be a red-tinted wash to read as "missed"
 *   - pulse-ring-offset — must match the card background or the focus ring tears
 *   - toolbar-control-armed-shadow — black-tinted fallback is invisible on dark surfaces
 *     (darkOnly: required on dark themes, must be ABSENT on light themes or it inverts the ring)
 */
interface ThemeExtensionMeta {
  /** Fallback is invisible/wrong, so every applicable built-in theme must define it. */
  required: boolean;
  /** Required on dark themes only; light themes must NOT define it (inverts the contrast). */
  darkOnly?: boolean;
}

export const THEME_EXTENSION_REGISTRY = {
  // Sidebar
  "sidebar-hover-bg": { required: true },
  "sidebar-active-bg": { required: true },
  "sidebar-action-hover-bg": { required: false },
  "worktree-section-hover-bg": { required: false },

  // Toolbar
  "toolbar-agent-hover-bg": { required: false },
  "toolbar-control-armed-shadow": { required: true, darkOnly: true },
  "toolbar-control-hover-bg": { required: false },
  "toolbar-control-hover-fg": { required: false },
  "toolbar-control-hover-shadow": { required: false },
  "toolbar-divider": { required: false },
  "toolbar-pill-radius": { required: false },
  "toolbar-project-bg": { required: false },
  "toolbar-project-border": { required: false },
  "toolbar-project-chip-bg": { required: false },
  "toolbar-project-chip-border": { required: false },
  "toolbar-project-meta-fg": { required: false },
  "toolbar-project-shadow": { required: false },
  "toolbar-shadow": { required: false },
  "toolbar-stats-bg": { required: false },
  "toolbar-stats-border": { required: false },
  "toolbar-stats-divider": { required: false },
  "toolbar-stats-hover-bg": { required: false },
  "toolbar-stats-shadow": { required: false },

  // Settings
  "settings-card-bg": { required: false },
  "settings-dialog-bg": { required: false },
  "settings-kbd-bg": { required: false },
  "settings-kbd-border": { required: false },
  "settings-list-item-bg": { required: false },
  "settings-nav-active-bg": { required: false },
  "settings-nav-active-shadow": { required: false },
  "settings-nav-hover-bg": { required: false },
  "settings-search-bg": { required: false },
  "settings-search-muted": { required: false },
  "settings-sidebar-bg": { required: false },
  "dialog-header-bg": { required: false },

  // Pulse
  "pulse-before-bg": { required: false },
  "pulse-card-bg": { required: false },
  "pulse-card-header-bg": { required: false },
  "pulse-card-shadow": { required: false },
  "pulse-control-hover-bg": { required: false },
  "pulse-empty-bg": { required: false },
  "pulse-heat-color": { required: false },
  "pulse-heat-high-opacity": { required: false },
  "pulse-heat-low-opacity": { required: false },
  "pulse-heat-medium-opacity": { required: false },
  "pulse-missed-bg": { required: true },
  "pulse-range-bg": { required: false },
  "pulse-ring-offset": { required: true },
  "pulse-skeleton-gradient": { required: false },

  // Dock / panel
  "dock-bg": { required: false },
  "dock-border": { required: false },
  "dock-shadow": { required: false },
  "panel-grid-bg": { required: false },
} as const satisfies Record<string, ThemeExtensionMeta>;

export type ThemeExtensionKey = keyof typeof THEME_EXTENSION_REGISTRY;

/** Keys whose CSS fallback is unsafe to inherit (see `required` above). */
export type RequiredThemeExtensionKey = {
  [K in ThemeExtensionKey]: (typeof THEME_EXTENSION_REGISTRY)[K]["required"] extends true
    ? K
    : never;
}[ThemeExtensionKey];

export const THEME_EXTENSION_KEYS = Object.keys(THEME_EXTENSION_REGISTRY) as ThemeExtensionKey[];
