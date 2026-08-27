import type { BuiltInThemeSource } from "../builtInThemeSources.js";

export const theme: BuiltInThemeSource = {
  id: "bali",
  name: "Bali",
  type: "light",
  builtin: true,
  location: "Bali, Indonesia",
  heroImage: "/themes/bali.webp",
  palette: {
    type: "light",
    // One paddy-green family; content lifts toward white — never a darker
    // fill on a light container. Gold is detail only (search, cursor, heat,
    // welcome mark), never a field surface or interaction state.
    surfaces: {
      grid: "#D2DEB4",
      sidebar: "#E7EDD8",
      canvas: "#F0F3E4",
      panel: "#F7F9F1",
      elevated: "#FFFFFF",
    },
    text: {
      // Near-neutral ink; muted ≥ 4.7:1 on the grid, 6.0:1 on canvas.
      primary: "#20241E",
      secondary: "#4B4E47",
      muted: "#575D54",
      inverse: "#FDFEFB",
    },
    border: "#CBD0C1",
    accent: "#218546",
    accentSecondary: "#3A7A4E",
    // Status colors render as text — keep ≥ 4.5:1 on every surface up to #FFFFFF.
    status: {
      success: "#208042",
      warning: "#946400",
      danger: "#C0453A",
      info: "#2C7884",
    },
    activity: {
      active: "#208042",
      idle: "#62786A",
      working: "#208042",
      waiting: "#8A6A0C",
    },
    // Field ink: an off-temperature overlay tint reads as grime on the hued field.
    overlayTint: "#31342B",
    terminal: {
      background: "#1A2620",
      foreground: "#CDD6CD",
      // 3.82:1 on the terminal background.
      muted: "#6F8276",
      cursor: "#E0B341",
      selection: "#2C4136",
      red: "#E06A5E",
      green: "#43BD7F",
      yellow: "#D9A832",
      blue: "#46A8D9",
      magenta: "#B47FE8",
      cyan: "#2EB5A0",
      // Brights: ≥ 7:1 on the background and ≥ 0.06 OKLab from their base pairs.
      brightRed: "#F0907F",
      brightGreen: "#5FD193",
      brightYellow: "#EFC75E",
      brightBlue: "#79C6E8",
      brightMagenta: "#D49AE3",
      brightCyan: "#5FD9C2",
      brightWhite: "#EDF5EC",
    },
    syntax: {
      comment: "#586D5C",
      punctuation: "#54675A",
      number: "#7E5D08",
      string: "#1E7048",
      operator: "#0F7263",
      // Keyword/function must clear 4.5:1 AA on every surface syntax renders on.
      keyword: "#963B92",
      function: "#1B6B9E",
      link: "#106B3C",
      quote: "#56695C",
      chip: "#3A7A4E",
    },
    strategy: {
      shadowStyle: "light",
      materialBlur: 14,
      materialSaturation: 124,
      // Standing-water grid: grain disabled outright, the flatness is the material.
      grainCharacter: "none",
    },
  },
  tokens: {
    "accent-muted": "rgba(33,133,70,0.30)",
    "accent-soft": "rgba(33,133,70,0.18)",
    // Flat chrome: the engine sheen is a screen-scale gradient (banding risk).
    "chrome-noise-texture": "none",
    "focus-ring": "rgba(33,133,70,0.35)",
    "overlay-hover": "rgba(49,52,43,0.08)",
    // Derived 3% is sub-threshold over near-white surfaces.
    "overlay-soft": "rgba(49,52,43,0.055)",
    // Opaque elevate-to-select for menu/palette rows on white popovers.
    "overlay-raised": "#EBEEE3",
    // Re-inked to the field temperature (engine slate reads cool here).
    "pr-draft": "#62695F",
    "scrollbar-thumb": "#727D6E",
    "scrollbar-thumb-hover": "color-mix(in oklab, #727D6E 85%, #20241E)",
    "scrim-blur": "16px",
    "scrim-soft": "rgba(49,52,43,0.16)",
    "scrim-medium": "rgba(49,52,43,0.28)",
    "scrim-strong": "rgba(49,52,43,0.46)",
    // Search is gold, kept off the green accent so a match never reads as selection.
    "search-highlight-background": "rgba(176,128,16,0.16)",
    "search-highlight-text": "#7A5800",
    "search-match-badge-background": "rgba(176,128,16,0.16)",
    "search-match-badge-text": "#7A5800",
    "search-selected-result-border": "rgba(122,88,0,0.34)",
    "search-selected-result-icon": "#7A5800",
    // Two-layer contact+spread: the engine "light" single penumbra has no
    // contact edge on a near-white field.
    "shadow-ambient": "0 1px 2px rgba(36,44,30,0.07), 0 8px 22px rgba(36,44,30,0.10)",
    // Dialogs sit a full z-tier above menus/popovers.
    "shadow-dialog": "0 2px 6px rgba(36,44,30,0.08), 0 28px 68px rgba(36,44,30,0.16)",
    "shadow-floating": "0 1px 3px rgba(36,44,30,0.09), 0 14px 36px rgba(36,44,30,0.12)",
    "surface-inset": "#EEF2E6",
    // Inputs are raised on light, never recessed (overrides the engine's
    // recessed derivation).
    "surface-input": "#FAFCF6",
    // Chrome is a chroma drop from the field, never a temperature swing.
    "surface-toolbar": "#ECEEE7",
    "terminal-bright-black": "#5A6B5E",
    "terminal-white": "#CDD6CD",
    "text-link": "#0E6434",
    // 4.5:1 on the raised input.
    "text-placeholder": "rgba(32,36,30,0.62)",
  },
  extensions: {
    "dock-bg": "#ECEEE7",
    "dock-input-bg": "#FAFCF6",
    // Lifts to white + stone hairline; the engine accent fill/border would
    // spend accent on membership state.
    "dock-item-bg-active": "#FFFFFF",
    "dock-item-border-active": "rgba(108,118,96,0.55)",
    // Registry format guard: shadow-color channels, alpha ≥ 0.25.
    "dock-shadow": "0 -2px 8px rgb(from var(--theme-shadow-color) r g b / 0.25)",
    // Panel title bars join the stone chrome; the focused pane's cap brightens.
    "panel-header-bg": "#DDE5C6",
    "panel-header-focus-bg": "#F5F6F1",
    // Outer glow only (inset rings read as a defect on panes); focus chrome is
    // this region's one accent signal — keep other accent fills out of it.
    "panel-focus-border": "rgba(33,133,70,0.70)",
    "panel-focus-shadow": "0 0 0 1px rgba(33,133,70,0.22), 0 1px 2px rgba(36,44,30,0.10)",
    "panel-selected-bg": "#FBFCF6",
    // White-gloss lift for emoji tiles (the dark wash renders murky on light).
    "project-tile-wash":
      "linear-gradient(to bottom, rgba(255,255,255,0.40), rgba(255,255,255,0.10))",
    "project-tile-shadow": "inset 0 1px 1px rgba(44,47,38,0.10), 0 0 0 1px rgba(45,48,38,0.10)",
    "pulse-before-bg": "#D2DEB4",
    "pulse-card-bg": "#FFFFFF",
    "pulse-card-header-bg": "#F7FAF0",
    "pulse-card-shadow": "0 1px 2px rgba(44,47,38,0.10), 0 4px 10px rgba(44,47,38,0.08)",
    "pulse-control-hover-bg": "rgba(49,52,43,0.05)",
    "pulse-empty-bg": "#F0F3E4",
    // Marigold heat (a green ramp aliases the field); level-1 must stay ≥ JND
    // above the empty cell.
    "pulse-heat-high-opacity": "0.90",
    "pulse-heat-low-opacity": "0.40",
    "pulse-heat-medium-opacity": "0.66",
    "pulse-heat-color": "#C8920F",
    "pulse-range-bg": "#F0F3E4",
    "pulse-ring-offset": "#FFFFFF",
    "pulse-skeleton-gradient": "linear-gradient(90deg, #D2DEB4 25%, #F0F3E4 50%, #D2DEB4 75%)",
    "dialog-header-bg": "#F8F9F5",
    "review-commit-input-bg": "#FAFCF6",
    "settings-kbd-bg": "#EEF2E6",
    "settings-kbd-border": "#CBD0C1",
    // Nav selection elevates to white + the 2px accent marker.
    "settings-nav-active-bg": "#FFFFFF",
    "settings-nav-active-shadow": "none",
    "settings-nav-hover-bg": "rgba(46,58,36,0.05)",
    // Scope pill elevates to white on the tinted settings sidebar.
    "settings-scope-bg": "#FFFFFF",
    "settings-sidebar-bg": "rgba(231,237,216,0.60)",
    // Composited settings-sidebar-bg over the shell.
    "settings-sidebar-scroll-fade": "#EDF2E2",
    "sidebar-action-hover-bg": "rgba(46,58,36,0.05)",
    // idle < hover < selected (audit-enforced); contact shadow only, no ring —
    // selection = bg + right accent rail.
    "sidebar-card-bg": "#F2F6EA",
    "sidebar-card-shadow": "0 1px 2px rgba(40,48,30,0.05)",
    "sidebar-active-bg": "#FFFFFF",
    "sidebar-hover-bg": "#F8FAF4",
    "toolbar-agent-hover-bg": "rgba(32,36,30,0.06)",
    "toolbar-control-hover-bg": "rgba(32,36,30,0.06)",
    // Accent restraint: hover affordance is the bg, not an accent foreground.
    "toolbar-control-hover-fg": "#20241E",
    "toolbar-control-hover-shadow": "none",
    "toolbar-divider": "rgba(203,208,193,0.7)",
    // Pills sit lighter than the chrome strip (raised, like all content).
    "toolbar-project-bg":
      "linear-gradient(180deg, rgba(224,179,65,0.08), rgba(32,36,30,0.02)), #F6F7F2",
    "toolbar-project-border": "rgba(203,208,193,0.75)",
    "toolbar-project-chip-bg": "rgba(32,36,30,0.04)",
    "toolbar-project-chip-border": "rgba(203,208,193,0.75)",
    "toolbar-project-shadow": "inset 0 1px 0 rgba(255,255,255,0.5)",
    "toolbar-shadow": "0 1px 2px rgba(44,47,38,0.06)",
    "toolbar-stats-bg": "#F6F7F2",
    "toolbar-stats-border": "rgba(203,208,193,0.7)",
    "toolbar-stats-divider": "rgba(203,208,193,0.7)",
    "toolbar-stats-hover-bg": "#F9FAF6",
    // Gold as ritual detail, never interaction state; the field stays flat
    // (no welcome-field-wash — large-surface gradients band).
    "welcome-mark-color": "rgba(200,146,15,0.88)",
    // Filter rail sits flush on the field; the raised search input carries it.
    "worktree-filter-bar-bg": "#E7EDD8",
    // Active quick-state tab lifts to white under its inset underline.
    "worktree-quick-state-active-bg": "#FFFFFF",
    "worktree-search-input-bg": "#FAFCF6",
    "worktree-section-hover-bg": "rgba(46,58,36,0.05)",
  },
};
