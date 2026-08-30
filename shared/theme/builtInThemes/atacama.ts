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
    // One warm desert-crust family; content lifts toward white — never a
    // darker fill on a light container. Turquoise and terracotta are detail
    // colors only, never field surfaces.
    surfaces: {
      grid: "#E8D5B9",
      sidebar: "#F1E9D9",
      canvas: "#F6F0E5",
      panel: "#FCF7F0",
      elevated: "#FFFFFF",
    },
    text: {
      // Near-neutral warm ink (C ≤ 0.02); muted ≥ 5.4:1 on the grid.
      primary: "#272119",
      secondary: "#4B4439",
      muted: "#59513F",
      inverse: "#FDFCF9",
    },
    border: "#D4CBBD",
    accent: "#B25024",
    // Lagoon turquoise — deliberately shared with status.info and the
    // search/heat/chip detail lane; ≥ 4.0:1 outline on every surface.
    accentSecondary: "#16707F",
    // Status colors render as text — keep ≥ 4.5:1 on every surface up to #FFFFFF.
    status: {
      success: "#1E775B",
      warning: "#8A5F0D",
      danger: "#A33530",
      info: "#16707F",
    },
    activity: {
      active: "#1E775B",
      idle: "#6A6052",
      working: "#1E775B",
      waiting: "#8A5F0D",
    },
    // Warm ink: a cool overlay tint reads as grime on the warm field.
    overlayTint: "#332B23",
    terminal: {
      // ANSI slots are audited against this bg, not the canvas (dL floor 0.18).
      background: "#16151E",
      foreground: "#D6D3DC",
      // 4.4:1 on the terminal background.
      muted: "#807B8C",
      cursor: "#E2A33D",
      selection: "#2D2B3C",
      red: "#E06A55",
      green: "#43B26B",
      yellow: "#E2A33D",
      blue: "#4FA3DC",
      magenta: "#C97FD6",
      cyan: "#2FAEC2",
      brightRed: "#F4937F",
      brightGreen: "#5ECF8B",
      brightYellow: "#F2C160",
      brightBlue: "#86C3F0",
      brightMagenta: "#EFA7C0",
      brightCyan: "#5FD3E4",
      brightWhite: "#F2F0F6",
    },
    // Every glyph role must clear 4.5:1 on its file-viewer canvas AND the
    // 0.18 dL floor on the dark terminal.
    syntax: {
      comment: "#6B6152",
      punctuation: "#5E564A",
      number: "#8A5C10",
      string: "#2E7046",
      operator: "#196E7C",
      keyword: "#7C46A8",
      function: "#2E6890",
      link: "#9B3F18",
      quote: "#6B6355",
      chip: "#16707F",
    },
    strategy: {
      // Base profile only; the authored shadow tokens below win.
      shadowStyle: "light",
      // 2 is the floor the materialBlur > 0 gate allows.
      materialBlur: 2,
      materialSaturation: 100,
      grainCharacter: "coarse",
      radiusScale: 0.9,
      // Warm border ink; border-interactive@0.2 must composite ≥ 1.18:1 on white.
      borderInkOverride: "#272119",
    },
  },
  tokens: {
    "accent-muted": "rgba(178,80,36,0.30)",
    "accent-soft": "rgba(178,80,36,0.18)",
    "focus-ring": "rgba(178,80,36,0.35)",
    "grain-opacity": "0.03",
    "overlay-hover": "rgba(51,43,35,0.08)",
    // Derived 3% is sub-threshold over near-white surfaces.
    "overlay-soft": "rgba(51,43,35,0.055)",
    // Opaque elevate-to-select for menu/palette rows on white popovers.
    "overlay-raised": "#F1ECE4",
    // Engine light default is cool slate; re-inked warm to match the field.
    "pr-draft": "#6B6253",
    "scrollbar-thumb": "#7A7163",
    "scrollbar-thumb-hover": "color-mix(in oklab, #7A7163 85%, #272119)",
    "scrim-soft": "rgba(46,38,54,0.16)",
    "scrim-medium": "rgba(46,38,54,0.28)",
    "scrim-strong": "rgba(46,38,54,0.46)",
    "scrim-blur": "3px",
    "scrim-blur-palette": "2px",
    "search-highlight-background": "rgba(22,112,127,0.14)",
    "search-highlight-text": "#16707F",
    "search-match-badge-background": "rgba(22,112,127,0.14)",
    "search-match-badge-text": "#16707F",
    "search-selected-result-border": "rgba(22,112,127,0.34)",
    "search-selected-result-icon": "#16707F",
    // Knife-edge shadows: strong contact, short spread.
    "shadow-ambient": "0 1px 1px rgba(46,40,46,0.15), 0 4px 10px rgba(46,40,46,0.07)",
    "shadow-color": "rgba(46,40,46,0.12)",
    // Dialogs sit a full z-tier above menus/popovers.
    "shadow-dialog": "0 2px 4px rgba(46,40,46,0.16), 0 18px 44px rgba(46,40,46,0.16)",
    "shadow-floating": "0 1px 2px rgba(46,40,46,0.18), 0 8px 22px rgba(46,40,46,0.10)",
    "surface-inset": "#F4F0E7",
    // Inputs are raised on light, never recessed (overrides the engine's
    // recessed derivation).
    "surface-input": "#FDFBF7",
    "surface-toolbar": "#F0EDE6",
    // Dim-tier CLI text must stay ≥ 0.18 dL on the terminal bg.
    "terminal-bright-black": "#6E6878",
    "terminal-white": "#DCD9E2",
    "text-link": "#9B3F18",
    // 4.2:1 on the raised input.
    "text-placeholder": "rgba(39,33,25,0.60)",
  },
  extensions: {
    "dock-bg": "#F0EDE6",
    "dock-input-bg": "#FDFBF7",
    // Lifts to white like every carrying surface; the engine's accent fill
    // would spend accent on membership state.
    "dock-item-bg-active": "#FFFFFF",
    "dock-item-border-active": "rgba(39,33,25,0.28)",
    // Registry format guard: shadow-color channels, alpha ≥ 0.25.
    "dock-shadow": "0 -2px 8px rgb(from var(--theme-shadow-color) r g b / 0.25)",
    // Panel title bars join the crust chrome; the focused pane's cap brightens.
    "panel-header-bg": "#ECDFC9",
    "panel-header-focus-bg": "#F7F5F0",
    // Copper focus edge — the one accent signal in the panel region.
    "panel-focus-border": "rgba(178,80,36,0.65)",
    // Outer-only (inset rings read as a defect on panes).
    "panel-focus-shadow": "0 1px 2px rgba(46,40,46,0.26)",
    // White-gloss lift for emoji tiles (the dark wash renders murky on light).
    "project-tile-wash":
      "linear-gradient(to bottom, rgba(255,255,255,0.40), rgba(255,255,255,0.10))",
    "project-tile-shadow": "inset 0 1px 1px rgba(46,40,46,0.10), 0 0 0 1px rgba(46,40,46,0.10)",
    "pulse-before-bg": "#E8D5B9",
    "pulse-card-bg": "#FFFFFF",
    "pulse-card-header-bg": "#FCF7F0",
    "pulse-card-shadow": "0 1px 1px rgba(46,40,46,0.12), 0 3px 8px rgba(46,40,46,0.06)",
    "pulse-control-hover-bg": "rgba(51,43,35,0.05)",
    "pulse-empty-bg": "#F6F0E5",
    // Lagoon heat ramp: opaque stops; heat-1 must stay ≥ JND above the empty cell.
    "pulse-heat-1": "#CFE7E1",
    "pulse-heat-2": "#8FCBC7",
    "pulse-heat-3": "#3FA4AC",
    "pulse-heat-4": "#0E6675",
    "pulse-heat-color": "#0E6675",
    "pulse-range-bg": "#F6F0E5",
    "pulse-ring-offset": "#FFFFFF",
    "pulse-skeleton-gradient": "linear-gradient(90deg, #E8D5B9 25%, #F6F0E5 50%, #E8D5B9 75%)",
    "dialog-header-bg": "#FBF9F4",
    "review-commit-input-bg": "#FDFBF7",
    "settings-kbd-bg": "#F4F0E7",
    "settings-kbd-border": "#D4CBBD",
    // Nav selection elevates to white + the 2px accent marker.
    "settings-nav-active-bg": "#FFFFFF",
    "settings-nav-active-shadow": "none",
    "settings-nav-hover-bg": "rgba(60,48,30,0.05)",
    // Scope pill elevates to white on the tinted settings sidebar.
    "settings-scope-bg": "#FFFFFF",
    "settings-sidebar-bg": "rgba(241,233,217,0.60)",
    // Composited settings-sidebar-bg over the shell.
    "settings-sidebar-scroll-fade": "#F5EFE2",
    "sidebar-action-hover-bg": "rgba(60,48,30,0.05)",
    // idle < hover < selected (audit-enforced); contact shadow only, no ring —
    // selection = bg + right accent rail.
    "sidebar-card-bg": "#F8F4EB",
    "sidebar-card-shadow": "0 1px 1px rgba(46,40,46,0.07)",
    "sidebar-active-bg": "#FFFFFF",
    "sidebar-hover-bg": "#FCF9F5",
    "toolbar-agent-hover-bg": "rgba(39,33,25,0.06)",
    "toolbar-control-hover-bg": "rgba(39,33,25,0.06)",
    // Accent restraint: hover affordance is the bg, not an accent foreground.
    "toolbar-control-hover-fg": "#272119",
    "toolbar-control-hover-shadow": "none",
    "toolbar-divider": "rgba(212,203,189,0.7)",
    // Pills sit lighter than the chrome strip (raised, like all content).
    "toolbar-project-bg":
      "linear-gradient(180deg, rgba(178,80,36,0.06), rgba(39,33,25,0.02)), #FBF7F0",
    "toolbar-project-border": "rgba(212,203,189,0.75)",
    "toolbar-project-chip-bg": "rgba(39,33,25,0.04)",
    "toolbar-project-chip-border": "rgba(212,203,189,0.75)",
    "toolbar-project-shadow": "inset 0 1px 0 rgba(255,255,255,0.5)",
    "toolbar-shadow": "0 1px 1px rgba(46,40,46,0.08)",
    "toolbar-stats-bg": "#FBF7F2",
    "toolbar-stats-border": "rgba(212,203,189,0.7)",
    "toolbar-stats-divider": "rgba(212,203,189,0.7)",
    "toolbar-stats-hover-bg": "#FCF9F5",
    "welcome-mark-color": "rgba(22,112,127,0.50)",
    // Filter rail sits flush on the field; the raised search input carries it.
    "worktree-filter-bar-bg": "#F1E9D9",
    // Active quick-state tab lifts to white under its inset underline.
    "worktree-quick-state-active-bg": "#FFFFFF",
    "worktree-search-input-bg": "#FDFBF7",
    "worktree-section-hover-bg": "rgba(60,48,30,0.05)",
  },
};
