import type { BuiltInThemeSource } from "../builtInThemeSources.js";

export const theme: BuiltInThemeSource = {
  id: "atacama",
  name: "Atacama",
  type: "light",
  builtin: true,
  location: "Atacama Desert, Chile",
  heroImage: "/themes/atacama.webp",
  palette: {
    type: "light",
    // Lightness rebalance (bondi precedent): the ramp lifted a few L-points and
    // desaturated (canvas C ~0.024 -> ~0.016 — it was the most saturated canvas
    // of the warm cohort and read as a tan slab). Hue stays in the desert band
    // (h 79-85); depth is carried by the solid border, the recessed sidebar
    // band, and the opaque inset wells instead of surface saturation.
    surfaces: {
      grid: "#E5DBCA",
      sidebar: "#ECE3D5",
      canvas: "#F2ECE1",
      panel: "#F8F3EB",
      elevated: "#FEFCF8",
    },
    text: {
      primary: "#2E2620",
      secondary: "#574C43",
      muted: "#6E6155",
      inverse: "#F9F7F4",
    },
    // Solid warm sand-taupe border (was the lone alpha border among the light
    // themes — rgba(51,43,35,0.16) composited to a washed cool grime ~1.35:1 on
    // the brightest surface). An opaque on-temperature hex keeps its warm hue
    // and reads as a crisp desert line across every surface (clears the 1.18
    // light-border floor: elevated ~1.8, grid ~1.3), matching the polished
    // siblings (table-mountain #C2B9AC, serengeti #D4C499).
    border: "#C9BCA5",
    accent: "#B25024",
    accentSecondary: "#3E7A50",
    status: {
      success: "#3E7A50",
      warning: "#9A6B1E",
      danger: "#B23E32",
      info: "#3C6E8C",
    },
    activity: {
      active: "#2E8550",
      idle: "#6E6155",
      working: "#2E8550",
      waiting: "#977017",
    },
    overlayTint: "#332B23",
    terminal: {
      background: "#24201D",
      foreground: "#DFD7CD",
      muted: "#918980",
      cursor: "#C99F5E",
      selection: "rgba(199,159,94,0.25)",
      red: "#C97B72",
      green: "#68A672",
      yellow: "#B89155",
      blue: "#6A8FAD",
      magenta: "#9B7BAD",
      cyan: "#5A9AA0",
      brightRed: "#D99088",
      brightGreen: "#85BA8F",
      brightYellow: "#CAAA72",
      brightBlue: "#88A8C4",
      brightMagenta: "#B598C2",
      brightCyan: "#7AB5BB",
      brightWhite: "#F2EDE5",
    },
    syntax: {
      comment: "#6E6155",
      punctuation: "#6B5F52",
      number: "#8A5F18",
      string: "#357046",
      operator: "#2C6E76",
      keyword: "#8A4FA8",
      function: "#3A6A88",
      link: "#9B3F18",
      quote: "#6E6155",
      chip: "#356C78",
    },
    strategy: {
      materialBlur: 12,
      materialSaturation: 118,
      // Warm charcoal ink for the derived border ladder (subtle/strong/divider/
      // interactive). The engine default is a cool near-black (#0f141b) that
      // reads grey-blue against warm sand; this is the documented Atacama use
      // case for the knob (see ThemeStrategy.borderInkOverride). Reuses the
      // overlayTint charcoal so all composited lines share one warm ink.
      borderInkOverride: "#332B23",
    },
  },
  tokens: {
    // Opaque recessed wells (bondi's grid-floor pattern). The engine-derived
    // light values are faint alpha washes (surface-inset = 6% warm charcoal)
    // that read as mud inside the near-white worktree cards; pinning them to
    // opaque sand steps makes the detail/terminal sections and inputs read as
    // true recessed planes. inset sits just below the grid floor; input just
    // below canvas (the light input-well idiom); toolbar pinned to sidebar so
    // the top chrome stays one coherent band as the ramp shifts.
    "surface-inset": "#E0D4C0",
    "surface-input": "#EEE7DA",
    "surface-toolbar": "#ECE3D5",
    "text-link": "#9B3F18",
    "text-placeholder": "rgba(46,38,32,0.55)",
    "overlay-hover": "rgba(51,43,35,0.075)",
    "overlay-active": "rgba(51,43,35,0.12)",
    "surface-hover": "rgba(51,43,35,0.075)",
    "surface-active": "rgba(51,43,35,0.12)",
    "category-amber": "oklch(0.62 0.13 65)",
    "category-blue": "oklch(0.60 0.13 242)",
    "category-cyan": "oklch(0.61 0.11 198)",
    "category-green": "oklch(0.60 0.13 155)",
    "category-indigo": "oklch(0.59 0.13 264)",
    "category-orange": "oklch(0.61 0.15 38)",
    "category-pink": "oklch(0.60 0.13 340)",
    "category-purple": "oklch(0.60 0.13 318)",
    "category-rose": "oklch(0.61 0.14 14)",
    "category-teal": "oklch(0.60 0.12 178)",
    "category-violet": "oklch(0.59 0.13 295)",
    "focus-ring": "rgba(178,80,36,0.32)",
    "pr-closed": "#C72B36",
    "pr-draft": "#646B75",
    // AA on atacama's near-white panel (#F8F3EB): the prior #8254DB/#1C823B were
    // 4.26/4.19:1 (just under 4.5); darkened keeping hue (E6/B1).
    "pr-merged": "#7444CC",
    "pr-open": "#166E30",
    "scrollbar-thumb": "#6E6155",
    "scrollbar-thumb-hover": "color-mix(in oklab, #6E6155 85%, #2E2620)",
    "search-highlight-background": "rgba(155,63,24,0.14)",
    "search-highlight-text": "#9B3F18",
    "search-match-badge-background": "rgba(155,63,24,0.22)",
    "search-match-badge-text": "#9B3F18",
    "search-selected-result-border": "#9B3F18",
    "search-selected-result-icon": "#9B3F18",
    "terminal-black": "#24201D",
    "terminal-bright-black": "#6B6560",
    "terminal-white": "#DFD7CD",
  },
  extensions: {
    // G1: the gutter behind panel tiles must sit at/just-below surface-grid
    // (#E5DBCA) so tiles read as raised figures, not wells.
    "panel-grid-bg": "#E3D8C6",
    "pulse-before-bg": "#E5DBCA",
    "pulse-card-bg": "#FEFCF8",
    "pulse-card-header-bg": "#DDE8EE",
    "pulse-card-shadow": "0 1px 3px rgba(51,43,35,0.11)",
    "pulse-control-hover-bg": "rgba(51,43,35,0.05)",
    "pulse-empty-bg": "#ECE3D5",
    "pulse-heat-color": "#2E8550",
    "pulse-heat-high-opacity": "0.88",
    "pulse-heat-low-opacity": "0.38",
    "pulse-heat-medium-opacity": "0.62",
    "pulse-missed-bg": "#B23E32",
    "pulse-range-bg": "#ECE3D5",
    "pulse-ring-offset": "#FEFCF8",
    "pulse-skeleton-gradient": "linear-gradient(90deg, #E0D4C0 25%, #ECE3D5 50%, #E0D4C0 75%)",
    "settings-kbd-border": "#C5BDB2",
    "settings-nav-hover-bg": "rgba(178,80,36,0.08)",
    "sidebar-action-hover-bg": "rgba(178,80,36,0.08)",
    // Issue 1: selection elevates, container recedes. Selected lifts to panel
    // (L 0.966 vs sidebar 0.919), hover to canvas (L 0.945) — idle < hover < selected.
    "sidebar-active-bg": "#F8F3EB",
    "sidebar-hover-bg": "#F2ECE1",
    "toolbar-agent-hover-bg": "rgba(178,80,36,0.08)",
    "toolbar-control-hover-bg": "rgba(178,80,36,0.08)",
    "toolbar-control-hover-fg": "#9B3F18",
    "toolbar-divider": "rgba(197,189,178,0.6)",
    "toolbar-project-bg":
      "linear-gradient(180deg, rgba(178,80,36,0.05), rgba(51,43,35,0.04)), linear-gradient(135deg, #EEE7DA, #E5DBCA)",
    "toolbar-project-border": "rgba(197,189,178,0.6)",
    "toolbar-project-chip-bg": "#F8F3EB",
    "toolbar-project-chip-border": "rgba(197,189,178,0.7)",
    "toolbar-project-shadow": "inset 0 1px 0 rgba(255,252,248,0.45), 0 1px 3px rgba(51,43,35,0.07)",
    "toolbar-stats-bg": "rgba(178,80,36,0.05)",
    "toolbar-stats-border": "rgba(197,189,178,0.6)",
    "toolbar-stats-divider": "rgba(197,189,178,0.6)",
    "toolbar-stats-hover-bg": "rgba(178,80,36,0.08)",
    "worktree-section-hover-bg": "rgba(178,80,36,0.08)",
    // Recessed chrome strip for the worktree search/filter bars (#9712 infra:
    // opt-in, unset themes keep the bars transparent). #DBCFBA sits ~0.07 L
    // below the sidebar — deliberately below even the grid floor, so the
    // chrome recedes and the worktree cards read as content on the brighter
    // sidebar plane ("not everything the same shade of light").
    "worktree-filter-bar-bg": "#DBCFBA",
    "dock-shadow":
      "inset 0 1px 0 rgba(255,252,248,0.5), 0 -2px 10px rgb(from var(--theme-shadow-color) r g b / 0.3)",
  },
};
