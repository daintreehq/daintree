import type { BuiltInThemeSource } from "../builtInThemeSources.js";

export const theme: BuiltInThemeSource = {
  id: "svalbard",
  name: "Svalbard",
  type: "light",
  builtin: true,
  location: "Svalbard Archipelago, Norway",
  heroImage: "/themes/svalbard.webp",
  palette: {
    type: "light",
    // One glacial family; content lifts toward white — never a darker fill on
    // a light container. Chroma decreases monotonically up the ramp (sea ice →
    // snow) — keep that arc when editing. Warmth is detail only (search,
    // warning, cursor, project pill), never a field surface.
    surfaces: {
      grid: "#C2D9E6",
      sidebar: "#DEEAF1",
      canvas: "#E9F0F5",
      panel: "#F3F7FA",
      elevated: "#FFFFFF",
    },
    text: {
      // Near-neutral cool ink; muted ≥ 4.7:1 on the grid, 6.0:1 on canvas.
      primary: "#192128",
      secondary: "#444D57",
      muted: "#555B63",
      inverse: "#FDFDFE",
    },
    border: "#C5CFD6",
    // 5.0:1 on white, 3.5:1 outline on the grid, 5.0:1 under inverse button text.
    accent: "#0077A3",
    accentSecondary: "#1F7E62",
    // Status colors render as text — ≥ 4.5:1 up to #FFFFFF and ≥ 3:1 on the grid.
    status: {
      success: "#1E7A5C",
      warning: "#8A661A",
      danger: "#C0413E",
      info: "#2E6E96",
    },
    activity: {
      active: "#1E7A5C",
      idle: "#586B7E",
      working: "#1E7A5C",
      waiting: "#8A661A",
    },
    // Desaturated glacial ink: a chromatic tint here reads as a storm front
    // in dialog scrims.
    overlayTint: "#273037",
    terminal: {
      background: "#14202D",
      foreground: "#C9D3DE",
      // 3.8:1 on the terminal background.
      muted: "#6E7B8A",
      // The one warm signal in the dark water; 7.5:1 on the background.
      cursor: "#E8A03C",
      selection: "#28394E",
      red: "#E06058",
      green: "#33BE92",
      yellow: "#E8A03C",
      blue: "#4FA8DE",
      magenta: "#AB7DE8",
      cyan: "#2FB4CE",
      brightRed: "#F58C84",
      brightGreen: "#46D9A8",
      brightYellow: "#F2C24E",
      brightBlue: "#86CCF5",
      brightMagenta: "#C49BF5",
      brightCyan: "#6BDCEE",
      brightWhite: "#EAF2FA",
    },
    syntax: {
      comment: "#5A6B7C",
      punctuation: "#516172",
      number: "#7E5C14",
      string: "#177053",
      operator: "#286287",
      // ≥ 4.5:1 on the canvas render surface.
      keyword: "#734F99",
      function: "#006487",
      link: "#1E6A88",
      quote: "#566472",
      chip: "#1F7E62",
    },
    strategy: {
      // Intent marker only: all three shadow stacks are token-authored below
      // (removing those overrides would surface crisp's black hairlines).
      shadowStyle: "crisp",
      materialBlur: 8,
      materialSaturation: 105,
      radiusScale: 0.9,
      // Cold border ink; border-interactive@0.2 must composite ≥ 1.18:1 on white.
      borderInkOverride: "#394A56",
      grainCharacter: "fine",
    },
  },
  tokens: {
    "accent-muted": "rgba(0,119,163,0.30)",
    "accent-soft": "rgba(0,119,163,0.18)",
    "focus-ring": "rgba(0,119,163,0.35)",
    "grain-opacity": "0.016",
    "overlay-hover": "rgba(39,48,55,0.08)",
    // Derived 3% is sub-threshold over near-white surfaces.
    "overlay-soft": "rgba(39,48,55,0.055)",
    // Opaque elevate-to-select for menu/palette rows on white popovers.
    "overlay-raised": "#E8EFF4",
    // GitHub-brand defaults fail AA on the near-white panel.
    "pr-merged": "#6C5CA8",
    "pr-draft": "#586470",
    "scrollbar-thumb": "#6E7981",
    "scrollbar-thumb-hover": "color-mix(in oklab, #6E7981 85%, #192128)",
    "scrim-blur": "2px",
    "scrim-blur-palette": "2px",
    "scrim-soft": "rgba(39,48,55,0.16)",
    "scrim-medium": "rgba(39,48,55,0.28)",
    "scrim-strong": "rgba(39,48,55,0.46)",
    // Search is the warm detail lane on the cool field.
    "search-highlight-background": "rgba(194,126,26,0.14)",
    "search-highlight-text": "#875807",
    "search-match-badge-background": "rgba(194,126,26,0.14)",
    "search-match-badge-text": "#875807",
    "search-selected-result-border": "rgba(194,126,26,0.34)",
    "search-selected-result-icon": "#875807",
    // Blue shadow ink, tight contact edge; two layers because the engine
    // "light" single penumbra has no contact edge on a near-white field.
    "shadow-ambient": "0 1px 1px rgba(51,80,105,0.16), 0 4px 10px rgba(51,80,105,0.10)",
    "shadow-color": "rgba(51,80,105,0.12)",
    // Dialogs sit a full z-tier above menus/popovers.
    "shadow-dialog": "0 2px 4px rgba(51,80,105,0.14), 0 18px 44px rgba(51,80,105,0.20)",
    "shadow-floating": "0 1px 2px rgba(51,80,105,0.18), 0 10px 26px rgba(51,80,105,0.13)",
    "surface-inset": "#EAF0F5",
    // Inputs are raised on light, never recessed.
    "surface-input": "#FAFCFE",
    "surface-toolbar": "#E3EDF3",
    "terminal-bright-black": "#525E6C",
    "terminal-white": "#C9D3DE",
    // 6.5:1 on white, 4.5:1 on the grid.
    "text-link": "#006589",
    // 4.3:1 on the raised input.
    "text-placeholder": "rgba(25,33,40,0.60)",
  },
  extensions: {
    "dock-bg": "#E3EDF3",
    "dock-input-bg": "#FAFCFE",
    // Lifts to white — the engine fallback's 12% accent tint would be a second
    // accent fill in the dock region; the active border stays the one signal.
    "dock-item-bg-active": "#FFFFFF",
    // Registry format guard: shadow-color channels, alpha ≥ 0.25.
    "dock-shadow": "0 -2px 8px rgb(from var(--theme-shadow-color) r g b / 0.25)",
    // Accent-family focus ink — no other accent fill in the panel region;
    // outer ring only, never an inset (reads as a defect on panes). Selected
    // and focused share this border; panel-selected-bg keeps its fallback.
    "panel-focus-border": "rgba(68,144,177,0.85)",
    "panel-focus-shadow": "0 0 0 1px rgba(68,144,177,0.25), 0 1px 2px rgba(51,80,105,0.10)",
    // Unselected caps sit a clear step below the field (sidebar-grid midpoint)
    // so the focused pane's bright cap reads side by side.
    "panel-header-bg": "#D0E1EB",
    "panel-header-focus-bg": "#EFF4F8",
    // White-gloss lift for emoji tiles (the dark wash renders murky on light).
    "project-tile-wash":
      "linear-gradient(to bottom, rgba(255,255,255,0.40), rgba(255,255,255,0.10))",
    "project-tile-shadow": "inset 0 1px 1px rgba(51,80,105,0.12), 0 0 0 1px rgba(51,80,105,0.12)",
    "pulse-before-bg": "#C2D9E6",
    "pulse-card-bg": "#FFFFFF",
    "pulse-card-header-bg": "#F5F8FB",
    "pulse-card-shadow": "0 1px 2px rgba(51,80,105,0.12), 0 4px 10px rgba(51,80,105,0.08)",
    "pulse-control-hover-bg": "rgba(39,48,55,0.05)",
    "pulse-empty-bg": "#E9F0F5",
    // Aurora heat ramp: opaque stops with strictly monotonic lightness so
    // intensity survives grayscale/CVD; level 1 must stay ≥ JND above the
    // empty cell.
    "pulse-heat-1": "#99D3B9",
    "pulse-heat-2": "#37B08A",
    "pulse-heat-3": "#008D94",
    "pulse-heat-4": "#6A499B",
    "pulse-heat-color": "#6A499B",
    "pulse-range-bg": "#E9F0F5",
    "pulse-ring-offset": "#FFFFFF",
    "pulse-skeleton-gradient": "linear-gradient(90deg, #C2D9E6 25%, #E9F0F5 50%, #C2D9E6 75%)",
    "dialog-header-bg": "#F5FAFD",
    "review-commit-input-bg": "#FAFCFE",
    // Small-chrome gradient between two audited near-white stops; label ink
    // holds 7.3:1 on the darker stop.
    "settings-kbd-bg": "linear-gradient(180deg, #FBFDFE, #E6EEF4)",
    "settings-kbd-border": "#C5CFD6",
    // Nav selection elevates to white + the 2px accent marker.
    "settings-nav-active-bg": "#FFFFFF",
    "settings-nav-active-shadow": "none",
    "settings-nav-hover-bg": "rgba(30,42,58,0.05)",
    // Scope pill elevates to white on the tinted settings sidebar.
    "settings-scope-bg": "#FFFFFF",
    "settings-sidebar-bg": "rgba(222,234,241,0.60)",
    // Composited settings-sidebar-bg over the shell.
    "settings-sidebar-scroll-fade": "#E6EFF5",
    "sidebar-action-hover-bg": "rgba(30,42,58,0.05)",
    // idle < hover < selected (audit-enforced); contact shadow only, no ring —
    // selection = bg + right accent rail.
    "sidebar-card-bg": "#F1F7FC",
    "sidebar-card-shadow": "0 1px 2px rgba(51,80,105,0.08)",
    "sidebar-active-bg": "#FFFFFF",
    "sidebar-hover-bg": "#F9FBFD",
    "toolbar-agent-hover-bg": "rgba(25,33,40,0.06)",
    "toolbar-control-hover-bg": "rgba(25,33,40,0.06)",
    // Accent restraint: hover affordance is the bg, not an accent foreground.
    "toolbar-control-hover-fg": "#192128",
    "toolbar-control-hover-shadow": "none",
    "toolbar-divider": "rgba(197,207,214,0.7)",
    // Pills sit lighter than the chrome strip (raised, like all content).
    "toolbar-project-bg": "#F7FAFC",
    "toolbar-project-border": "rgba(197,207,214,0.75)",
    "toolbar-project-chip-bg": "rgba(25,33,40,0.04)",
    "toolbar-project-chip-border": "rgba(197,207,214,0.75)",
    "toolbar-project-shadow": "inset 0 1px 0 rgba(255,255,255,0.5)",
    "toolbar-shadow": "0 1px 2px rgba(51,80,105,0.07)",
    "toolbar-stats-bg": "#F6F8FA",
    "toolbar-stats-border": "rgba(197,207,214,0.7)",
    "toolbar-stats-divider": "rgba(197,207,214,0.7)",
    "toolbar-stats-hover-bg": "#F9FBFD",
    // The welcome field stays flat (a screen-tall wash would band); the mark
    // carries the warm note instead, 3.5:1 on canvas.
    "welcome-mark-color": "#A47634",
    // Filter rail sits flush on the field; the raised search input carries it.
    "worktree-filter-bar-bg": "#DEEAF1",
    // Active quick-state tab lifts to white under its inset underline.
    "worktree-quick-state-active-bg": "#FFFFFF",
    "worktree-search-input-bg": "#FAFCFE",
    "worktree-section-hover-bg": "rgba(30,42,58,0.05)",
  },
};
