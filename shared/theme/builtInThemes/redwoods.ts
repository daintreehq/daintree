import type { BuiltInThemeSource } from "../builtInThemeSources.js";

export const theme: BuiltInThemeSource = {
  id: "redwoods",
  name: "Redwoods",
  type: "dark",
  builtin: true,
  location: "Redwood National Park, California, USA",
  heroImage: "/themes/redwoods.webp",
  palette: {
    type: "dark",
    surfaces: {
      grid: "#090705",
      sidebar: "#110B08",
      canvas: "#16110D",
      panel: "#1E1612",
      elevated: "#291E18",
    },
    text: {
      primary: "#E8DCC8",
      secondary: "#9E8B78",
      muted: "#6B5B4F",
      inverse: "#16110D",
    },
    border: "#36241A",
    // Keep L ≤ ~0.66: the cross-theme dE gate vs daintree's mint collapses
    // near L 0.71 in this hue family.
    accent: "#50A24D",
    // ONE signal amber by design: cursor, waiting, yellow, secondary, pill
    // shaft, and the focus bloom all share #CFA043. The pulse heat ramp stays
    // graded data, not a fifth signal.
    accentSecondary: "#CFA043",
    status: {
      success: "#5A7E52",
      warning: "#BA8A42",
      danger: "#B85C52",
      info: "#6B8287",
    },
    activity: {
      active: "#4B9358",
      idle: "#5A4E42",
      working: "#4B9358",
      waiting: "#CFA043",
    },
    overlayTint: "#B48C78",
    // Terminal background intentionally unset — inherits the canvas.
    terminal: {
      cursor: "#CFA043",
      selection: "rgba(80,162,77,0.20)",
      red: "#D4746C",
      green: "#5EAE6C",
      yellow: "#CFA043",
      blue: "#6BA8C4",
      magenta: "#B07AAE",
      cyan: "#5ABCB0",
      brightRed: "#E8988E",
      brightGreen: "#7DC88A",
      brightYellow: "#DDB866",
      brightBlue: "#8DC4DC",
      brightMagenta: "#C89AC4",
      brightCyan: "#7ACEC8",
      brightWhite: "#E8DCC8",
    },
    syntax: {
      comment: "#7a6e5e",
      punctuation: "#B8A898",
      number: "#d4956a",
      string: "#8abf6e",
      operator: "#7ec0b8",
      keyword: "#BD809D",
      // Keep dE ≥ 0.03 vs keyword.
      function: "#8FACC2",
      link: "#6aadcc",
      quote: "#9e8b78",
      chip: "#72c0a8",
    },
    strategy: {
      shadowStyle: "atmospheric",
      materialBlur: 16,
      materialSaturation: 105,
      grainCharacter: "coarse",
    },
  },
  tokens: {
    "border-strong": "rgba(180,140,120,0.14)",
    "border-subtle": "rgba(180,140,120,0.08)",
    // Bark striation; total perceived alpha must stay ≤ ~2% (above reads as dirt).
    "chrome-noise-texture":
      "repeating-linear-gradient(90deg, rgba(232,220,200,0.02) 0 1px, rgba(9,5,3,0.012) 1px 2px, transparent 2px 7px)",
    // Keep ≥ 0.55: lower dissolves against the near-black warm field.
    "focus-ring": "rgba(80,162,77,0.55)",
    "grain-opacity": "0.03",
    "scrim-blur": "18px",
    "scrim-blur-palette": "8px",
    "scrim-medium": "rgba(9,5,3,0.65)",
    "scrim-soft": "rgba(9,5,3,0.35)",
    "scrim-strong": "rgba(9,5,3,0.78)",
    "scrollbar-thumb": "#5A4E42",
    "scrollbar-thumb-hover": "color-mix(in oklab, #5A4E42 85%, #E8DCC8)",
    // Highlight text must hold ≥ 3.0 over the wash composited on every surface.
    "search-highlight-background": "rgba(80,162,77,0.18)",
    "search-highlight-text": "#5CAF62",
    "search-match-badge-background": "rgba(80,162,77,0.20)",
    "search-selected-result-border": "rgba(80,162,77,0.45)",
    "shadow-ambient": "0 4px 14px rgba(9,5,3,0.45), 0 1px 3px rgba(9,5,3,0.30)",
    "shadow-color": "rgba(9,5,3,0.55)",
    "shadow-dialog": "0 20px 56px rgba(6,3,2,0.50)",
    "shadow-floating": "0 14px 42px rgba(9,5,3,0.55), 0 4px 12px rgba(9,5,3,0.35)",
    "surface-inset": "#0E0A08",
    // = surface-sidebar: toolbar, sidebar, and dock are one continuous shell.
    "surface-toolbar": "#110B08",
    // Parchment tint replaces the pure-white dark default (re-temperature only;
    // sub-JND at the low alphas other tint consumers use). The registry-mandated
    // rgba(255,255,255,*) sidebar/toolbar overlays intentionally stay white.
    tint: "#E8DCC8",
  },
  extensions: {
    "dock-bg": "#110B08",
    // Bark light, not the accent fill — the dock's active item is not the
    // load-bearing focus signal.
    "dock-item-bg": "rgba(180,140,120,0.05)",
    "dock-item-bg-active": "rgba(180,140,120,0.15)",
    "dock-item-border-active": "rgba(180,140,120,0.34)",
    // Lit-bark focus border, never an amber RING — saturated rings are the
    // agent-state vocabulary and would false-positive the "which agent needs
    // me" scan; the amber lives only in the top-edge bloom. No inset layers
    // (inner shadows on panes read as a defect). panel-selected-bg stays on
    // the neutral fallback by design.
    "panel-focus-border": "rgba(232,220,200,0.32)",
    "panel-focus-shadow": "0 0 0 1px rgba(232,220,200,0.10), 0 0 10px rgba(207,160,67,0.07)",
    "pulse-before-bg": "#0D0907",
    "pulse-card-bg": "#1E1612",
    "pulse-card-shadow": "0 4px 14px rgba(9,5,3,0.45), 0 1px 3px rgba(9,5,3,0.30)",
    "pulse-control-hover-bg": "rgba(180,140,120,0.05)",
    "pulse-empty-bg": "#241C17",
    // God-ray heat ramp: opaque stops, umber → copper → amber → full sun.
    "pulse-heat-1": "#4B361C",
    "pulse-heat-2": "#815B1F",
    "pulse-heat-3": "#B28324",
    "pulse-heat-4": "#E0AF3B",
    "pulse-heat-color": "#E0AF3B",
    "pulse-range-bg": "#16110D",
    "pulse-ring-offset": "#1E1612",
    "pulse-skeleton-gradient": "linear-gradient(90deg, #2A1E18 25%, #342820 50%, #2A1E18 75%)",
    // The single accent membership fill in the settings region; hover stays
    // on neutral bark light (accent-restraint contract).
    // Rows above the panel shell, below elevated: secondary labels ~5.2:1.
    "settings-card-bg": "#231A14",
    "settings-list-item-bg": "#231A14",
    "settings-nav-active-bg": "rgba(80,162,77,0.13)",
    "settings-nav-hover-bg": "rgba(180,140,120,0.05)",
    "settings-search-bg": "#0E0A08",
    "sidebar-action-hover-bg": "rgba(180,140,120,0.06)",
    "sidebar-active-bg": "rgba(255,255,255,0.065)",
    "sidebar-hover-bg": "rgba(255,255,255,0.048)",
    "toolbar-agent-hover-bg": "rgba(180,140,120,0.08)",
    "toolbar-control-active-bg": "rgba(180,140,120,0.14)",
    "toolbar-control-armed-bg": "rgba(180,140,120,0.14)",
    "toolbar-control-armed-shadow": "inset 0 0 0 1px rgba(255,255,255,0.12)",
    "toolbar-control-hover-bg": "rgba(180,140,120,0.10)",
    "toolbar-divider": "rgba(54,36,26,0.5)",
    // Small-area gradient (pill chrome), alpha ≤ 7%; same god-ray hex as the cursor.
    "toolbar-project-bg":
      "linear-gradient(180deg, rgba(207,160,67,0.07), rgba(207,160,67,0) 70%), rgba(180,140,120,0.06)",
    "toolbar-project-border": "rgba(54,36,26,0.5)",
    "toolbar-project-chip-bg": "rgba(180,140,120,0.06)",
    "toolbar-project-chip-border": "rgba(54,36,26,0.5)",
    "toolbar-project-shadow": "inset 0 1px 0 rgba(232,220,200,0.05)",
    "toolbar-stats-bg": "rgba(180,140,120,0.06)",
    "toolbar-stats-border": "rgba(54,36,26,0.5)",
    "toolbar-stats-divider": "rgba(54,36,26,0.5)",
    "toolbar-stats-hover-bg": "rgba(180,140,120,0.10)",
    "welcome-mark-color": "rgba(207,160,67,0.50)",
    "worktree-section-hover-bg": "rgba(180,140,120,0.04)",
  },
};
