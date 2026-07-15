import type { BuiltInThemeSource } from "../builtInThemeSources.js";

export const theme: BuiltInThemeSource = {
  id: "serengeti",
  name: "Serengeti",
  type: "light",
  builtin: true,
  location: "Serengeti National Park, Tanzania",
  heroImage: "/themes/serengeti.webp",
  palette: {
    type: "light",
    // One golden-grass family; content lifts toward white — never a darker
    // fill on a light container. Acacia green is detail only (accentSecondary,
    // search, success, welcome mark), never a field surface.
    surfaces: {
      grid: "#E2D7A0",
      sidebar: "#F0E9C9",
      canvas: "#F5F0D8",
      panel: "#FAF7ED",
      elevated: "#FFFFFF",
    },
    text: {
      // Near-neutral warm ink (C ≤ 0.022); muted ≥ 5.3:1 on the grid.
      primary: "#26211A",
      secondary: "#4D473C",
      muted: "#585245",
      inverse: "#FFFEF8",
    },
    // Calmer chroma than the field: full-strength straw hairlines read as
    // ledger ruling inside white popovers.
    border: "#D2CDB4",
    accent: "#8B6D08",
    accentSecondary: "#467030",
    // Status colors render as text — keep ≥ 4.5:1 on canvas/panel/elevated.
    status: {
      success: "#3A7A22",
      warning: "#96610A",
      danger: "#B13A28",
      info: "#22699C",
    },
    activity: {
      active: "#3A7A22",
      idle: "#6B6350",
      working: "#3A7A22",
      waiting: "#96610A",
    },
    // Warm ink: a cool overlay tint reads as grime on the grass field.
    overlayTint: "#322618",
    terminal: {
      background: "#2C2115",
      foreground: "#E8DDC5",
      // 3.76:1 on the terminal background.
      muted: "#857B66",
      cursor: "#E8A81C",
      selection: "#4A3520",
      // Every chromatic ANSI color holds ≥ 4.5:1 on the terminal background;
      // black/bright-black are the deliberate dim ladder below that bar.
      red: "#E0654E",
      green: "#7CBE5A",
      yellow: "#E8B83A",
      blue: "#5FA3D0",
      magenta: "#C588B8",
      cyan: "#4FB8A8",
      brightRed: "#F08A75",
      brightGreen: "#9CD67E",
      brightYellow: "#F5CF65",
      brightBlue: "#8CC4E8",
      brightMagenta: "#DCAACE",
      brightCyan: "#7AD4C4",
      brightWhite: "#FAF4E0",
    },
    syntax: {
      comment: "#6B6050",
      punctuation: "#6E614A",
      number: "#8C5E0E",
      string: "#33701F",
      operator: "#1C7264",
      keyword: "#90486A",
      function: "#2A6796",
      link: "#6E5400",
      quote: "#6F6452",
      chip: "#467030",
    },
    strategy: {
      shadowStyle: "light",
      materialBlur: 8,
      materialSaturation: 108,
      // Dust grain is the whole atmosphere layer; strength on grain-opacity.
      grainCharacter: "coarse",
    },
  },
  tokens: {
    "accent-muted": "rgba(139,109,8,0.30)",
    "accent-soft": "rgba(139,109,8,0.18)",
    "focus-ring": "rgba(139,109,8,0.35)",
    // No chrome sheen or field gradient — screen-scale gradients band.
    "grain-opacity": "0.035",
    "scrim-blur": "6px",
    "scrim-blur-palette": "2px",
    "overlay-hover": "rgba(50,38,24,0.08)",
    // Derived 3% is sub-threshold over near-white surfaces.
    "overlay-soft": "rgba(50,38,24,0.055)",
    // Opaque elevate-to-select for menu/palette rows on white popovers.
    "overlay-raised": "#EDEADF",
    // GitHub-brand defaults fail AA on the near-white panel.
    "pr-merged": "#7644CC",
    "pr-draft": "#646B73",
    "scrollbar-thumb": "#7E744F",
    "scrollbar-thumb-hover": "color-mix(in oklab, #7E744F 85%, #26211A)",
    "scrim-soft": "rgba(50,38,24,0.16)",
    "scrim-medium": "rgba(50,38,24,0.28)",
    "scrim-strong": "rgba(50,38,24,0.46)",
    // Acacia green is the opposing detail color, kept off the gold accent.
    "search-highlight-background": "rgba(70,112,48,0.14)",
    "search-highlight-text": "#3E6A2A",
    "search-match-badge-background": "rgba(70,112,48,0.14)",
    "search-match-badge-text": "#3E6A2A",
    "search-selected-result-border": "rgba(70,112,48,0.34)",
    "search-selected-result-icon": "#3E6A2A",
    // Strong contact edge, short spread.
    "shadow-ambient": "0 1px 2px rgba(56,44,24,0.16), 0 3px 8px rgba(56,44,24,0.07)",
    // Dialogs sit a full z-tier above menus/popovers.
    "shadow-dialog": "0 2px 5px rgba(56,44,24,0.14), 0 20px 48px rgba(56,44,24,0.20)",
    "shadow-floating": "0 1px 3px rgba(56,44,24,0.18), 0 10px 24px rgba(56,44,24,0.12)",
    // Low chroma so kbd chips don't read as aged paper.
    "surface-inset": "#F2F0E5",
    // Inputs are raised on light, never recessed (overrides the engine's
    // recessed derivation).
    "surface-input": "#FDFBF4",
    "surface-toolbar": "#F1EDDE",
    // 3.18:1 — the dim tier stays dimmest but must not fall away.
    "terminal-bright-black": "#7A6F5B",
    "terminal-white": "#E8DDC5",
    "text-link": "#6E5400",
    // 4.5:1 on the raised input.
    "text-placeholder": "rgba(38,33,26,0.62)",
  },
  extensions: {
    "dock-bg": "#F1EDDE",
    "dock-input-bg": "#FDFBF4",
    // Registry format guard: shadow-color channels, alpha ≥ 0.25.
    "dock-shadow": "0 -2px 8px rgb(from var(--theme-shadow-color) r g b / 0.25)",
    // Lifts to white under a straw hairline; the engine accent fill would
    // spend accent on membership state and break the two-quote gold budget.
    "dock-item-bg-active": "#FFFFFF",
    "dock-item-border-active": "#D2CDB4",
    // Panel title bars join the straw chrome; the focused pane's cap brightens.
    "panel-header-bg": "#E9E0B4",
    "panel-header-focus-bg": "#F7F5E9",
    // Dense umber focus edge + short contact pool; no inset ring (reads as a
    // defect on light panes). panel-selected-bg stays on the neutral fallback
    // by design — the shade lives at the pane's edge, never as a fill.
    "panel-focus-border": "rgba(56,44,24,0.60)",
    "panel-focus-shadow": "0 0 0 1px rgba(56,44,24,0.28), 0 1px 2px rgba(56,44,24,0.18)",
    // White-gloss lift for emoji tiles (the dark wash renders murky on light).
    "project-tile-wash":
      "linear-gradient(to bottom, rgba(255,255,255,0.40), rgba(255,255,255,0.10))",
    "project-tile-shadow": "inset 0 1px 1px rgba(56,44,24,0.10), 0 0 0 1px rgba(56,44,24,0.10)",
    "pulse-before-bg": "#E2D7A0",
    "pulse-card-bg": "#FFFFFF",
    "pulse-card-header-bg": "#FAF8ED",
    "pulse-card-shadow": "0 1px 2px rgba(56,44,24,0.10), 0 4px 10px rgba(56,44,24,0.08)",
    "pulse-control-hover-bg": "rgba(50,38,24,0.05)",
    "pulse-empty-bg": "#F5F0D8",
    // Burn heat ramp: opaque stops, straw → ochre → amber → ember (green here
    // would alias accentSecondary); adjacent steps stay ≥ JND apart.
    "pulse-heat-1": "#E7D89F",
    "pulse-heat-2": "#D5AA55",
    "pulse-heat-3": "#BF7B1F",
    "pulse-heat-4": "#9E5A03",
    "pulse-range-bg": "#F5F0D8",
    "pulse-ring-offset": "#FFFFFF",
    "pulse-skeleton-gradient": "linear-gradient(90deg, #E2D7A0 25%, #F5F0D8 50%, #E2D7A0 75%)",
    "dialog-header-bg": "#FBFAF1",
    "review-commit-input-bg": "#FDFBF4",
    "settings-kbd-bg": "#F2F0E5",
    "settings-kbd-border": "#D2CDB4",
    // Nav selection elevates to white + the 2px accent marker.
    "settings-nav-active-bg": "#FFFFFF",
    "settings-nav-active-shadow": "none",
    "settings-nav-hover-bg": "rgba(50,38,24,0.05)",
    // Scope pill elevates to white on the tinted settings sidebar.
    "settings-scope-bg": "#FFFFFF",
    "settings-sidebar-bg": "rgba(240,233,201,0.60)",
    // Composited settings-sidebar-bg over the shell.
    "settings-sidebar-scroll-fade": "#F4EFD7",
    "sidebar-action-hover-bg": "rgba(50,38,24,0.05)",
    // idle < hover < selected (audit-enforced); contact shadow only, no ring —
    // selection = bg + right accent rail.
    "sidebar-card-bg": "#FAF6E6",
    "sidebar-card-shadow": "0 1px 2px rgba(56,44,24,0.05)",
    "sidebar-active-bg": "#FFFFFF",
    "sidebar-hover-bg": "#FCFBF2",
    "toolbar-agent-hover-bg": "rgba(38,33,26,0.06)",
    "toolbar-control-hover-bg": "rgba(38,33,26,0.06)",
    // Accent restraint: hover affordance is the bg, not an accent foreground.
    "toolbar-control-hover-fg": "#26211A",
    "toolbar-control-hover-shadow": "none",
    "toolbar-divider": "rgba(210,205,180,0.7)",
    "toolbar-pill-radius": "0.5rem",
    // Pills sit lighter than the chrome strip (raised, like all content).
    "toolbar-project-bg":
      "linear-gradient(180deg, rgba(232,168,28,0.08), rgba(38,33,26,0.02)), #FBF9F0",
    "toolbar-project-border": "rgba(210,205,180,0.75)",
    "toolbar-project-chip-bg": "rgba(38,33,26,0.04)",
    "toolbar-project-chip-border": "rgba(210,205,180,0.75)",
    "toolbar-project-shadow": "inset 0 1px 0 rgba(255,255,255,0.5)",
    "toolbar-shadow": "0 1px 2px rgba(56,44,24,0.06)",
    "toolbar-stats-bg": "#FBF9F0",
    "toolbar-stats-border": "rgba(210,205,180,0.7)",
    "toolbar-stats-divider": "rgba(210,205,180,0.7)",
    "toolbar-stats-hover-bg": "#FCFBF2",
    // The field stays flat (welcome-field-wash unauthored — a screen-spanning
    // wash would band).
    "welcome-mark-color": "#467030",
    // Filter rail sits flush on the field; the raised search input carries it.
    "worktree-filter-bar-bg": "#F0E9C9",
    // Active quick-state tab lifts to white under its inset underline.
    "worktree-quick-state-active-bg": "#FFFFFF",
    "worktree-search-input-bg": "#FDFBF4",
    "worktree-section-hover-bg": "rgba(50,38,24,0.05)",
  },
};
