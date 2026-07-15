import type { BuiltInThemeSource } from "../builtInThemeSources.js";

export const theme: BuiltInThemeSource = {
  id: "table-mountain",
  name: "Table Mountain",
  type: "light",
  builtin: true,
  location: "Table Mountain, Cape Town, South Africa",
  heroImage: "/themes/table-mountain.webp",
  palette: {
    type: "light",
    // One golden-sandstone family; content lifts toward white — never a
    // darker fill on a light container. Fynbos colors are detail only (accent,
    // secondary, search/info lane, terminal), never field surfaces.
    surfaces: {
      grid: "#E2D3BD",
      sidebar: "#F0E7D9",
      canvas: "#F5EFE5",
      panel: "#FAF7F2",
      elevated: "#FFFFFF",
    },
    text: {
      // Near-neutral warm ink (C ≤ 0.014); muted ≥ 4.9:1 on the grid.
      primary: "#231F1A",
      secondary: "#514B44",
      muted: "#5C5750",
      inverse: "#FDFCF9",
    },
    border: "#D5CBBD",
    accent: "#B0466F",
    accentSecondary: "#3C7A4C",
    // Status colors render as text — keep ≥ 4.5:1 on every surface up to #FFFFFF.
    status: {
      success: "#2E7B45",
      warning: "#9C6210",
      danger: "#AE3D33",
      info: "#2D6E94",
    },
    activity: {
      active: "#1E8A42",
      // Floored to clear the 3:1 graphical minimum on every chrome surface.
      idle: "#696259",
      working: "#1E8A42",
      waiting: "#9C6E0C",
    },
    // Warm ink: a cool overlay tint reads as grime on the sandstone field.
    overlayTint: "#342C23",
    terminal: {
      background: "#261F1B",
      foreground: "#E0D8D0",
      // 3.27:1 on the terminal background.
      muted: "#796E64",
      cursor: "#CFA848",
      // Opaque warm lift — selection must read as the same dark material.
      selection: "#3A3129",
      // Every base color clears 4.5:1 on the terminal background.
      red: "#E4635B",
      green: "#41B06E",
      yellow: "#DFA63B",
      blue: "#58A8DC",
      magenta: "#D873A3",
      cyan: "#2FAE9F",
      brightRed: "#F28B7D",
      brightGreen: "#6FCE91",
      brightYellow: "#F0C75E",
      brightBlue: "#8CC7EE",
      brightMagenta: "#EC9EC0",
      brightCyan: "#5BD6C6",
      brightWhite: "#FBF7F1",
    },
    syntax: {
      comment: "#5D6B5D",
      punctuation: "#5C564C",
      number: "#855615",
      string: "#2C7234",
      operator: "#1C6D78",
      // Keep ΔH well clear of the accent so keywords never alias the focus signal.
      keyword: "#84357F",
      function: "#2D618F",
      link: "#1C6D78",
      quote: "#5A6854",
      chip: "#3C7A4C",
    },
    strategy: {
      shadowStyle: "light",
      materialBlur: 8,
      materialSaturation: 118,
      radiusScale: 0.9,
      // No noiseOpacity: the engine's radial chrome sheen bands on large
      // surfaces; the mineral texture rides the coarse grain instead.
      grainCharacter: "coarse",
    },
  },
  tokens: {
    "accent-muted": "rgba(176,70,111,0.30)",
    "accent-soft": "rgba(176,70,111,0.18)",
    "focus-ring": "rgba(176,70,111,0.30)",
    // ~3%: the universal 2% reads as nothing on pale ochre (ceiling 0.05).
    "grain-opacity": "0.03",
    "overlay-hover": "rgba(52,44,35,0.08)",
    // Derived 3% is sub-threshold over near-white surfaces.
    "overlay-soft": "rgba(52,44,35,0.06)",
    // Opaque elevate-to-select for menu/palette rows on white popovers.
    "overlay-raised": "#EFE9E1",
    // GitHub-brand defaults fail AA on the near-white panel.
    "pr-merged": "#7644CC",
    "pr-draft": "#6A655C",
    "scrollbar-thumb": "#767169",
    "scrollbar-thumb-hover": "color-mix(in oklab, #767169 85%, #231F1A)",
    "scrim-blur": "16px",
    "scrim-soft": "rgba(52,44,35,0.14)",
    "scrim-medium": "rgba(52,44,35,0.25)",
    "scrim-strong": "rgba(52,44,35,0.42)",
    // Search keeps the cold-Atlantic slate as a small-detail temperature note.
    "search-highlight-background": "rgba(40,97,138,0.14)",
    "search-highlight-text": "#28618A",
    "search-match-badge-background": "rgba(40,97,138,0.14)",
    "search-match-badge-text": "#28618A",
    "search-selected-result-border": "rgba(40,97,138,0.34)",
    "search-selected-result-icon": "#28618A",
    // Two-layer contact+spread: the engine "light" single penumbra has no
    // contact edge on a near-white field. Warm umber ink, never black.
    "shadow-ambient": "0 1px 2px rgba(40,34,26,0.12), 0 4px 10px rgba(40,34,26,0.08)",
    // Dialogs sit a full z-tier above menus/popovers.
    "shadow-dialog": "0 2px 5px rgba(40,34,26,0.12), 0 22px 56px rgba(40,34,26,0.17)",
    "shadow-floating": "0 1px 2px rgba(40,34,26,0.14), 0 10px 24px rgba(40,34,26,0.13)",
    "surface-inset": "#F3ECE1",
    // Inputs are raised on light, never recessed (overrides the engine's
    // recessed derivation).
    "surface-input": "#FFFCF8",
    // = sidebar register: toolbar, dock, and panel caps are one continuous frame.
    "surface-toolbar": "#F1E8DB",
    "terminal-bright-black": "#5D534B",
    "terminal-white": "#E0D8D0",
    "text-link": "#94335B",
    // 4.3:1 on the raised input.
    "text-placeholder": "rgba(35,31,26,0.60)",
  },
  extensions: {
    "dock-bg": "#F1E8DB",
    "dock-input-bg": "#FFFCF8",
    // Registry format guard: shadow-color channels, alpha ≥ 0.25.
    "dock-shadow": "0 -2px 8px rgb(from var(--theme-shadow-color) r g b / 0.25)",
    // Flat grid by design — large-surface gradients band.
    "panel-grid-bg": "#E2D3BD",
    "terminal-grid-bg": "#E2D3BD",
    // Panel title bars join the stone frame (= surface-toolbar); the focused
    // pane's cap brightens.
    // Focused-pane emphasis at parity with the dark set: warm stone ink line
    // + contact shadow (no accent spend).
    "panel-focus-border": "rgba(52,44,35,0.50)",
    "panel-focus-shadow": "0 1px 2px rgba(40,34,26,0.18)",
    "panel-header-bg": "#E9DDCB",
    "panel-header-focus-bg": "#F7F1E8",
    // White-gloss lift for emoji tiles (the dark wash renders murky on light).
    "project-tile-wash":
      "linear-gradient(to bottom, rgba(255,255,255,0.40), rgba(255,255,255,0.10))",
    "project-tile-shadow": "inset 0 1px 1px rgba(40,34,26,0.10), 0 0 0 1px rgba(40,34,26,0.10)",
    "pulse-before-bg": "#E2D3BD",
    "pulse-card-bg": "#FFFFFF",
    "pulse-card-header-bg": "#FBF7F2",
    // Content cards rest, they don't cast — quieter than the chrome shadows.
    "pulse-card-shadow": "0 1px 2px rgba(40,34,26,0.06), 0 6px 16px rgba(40,34,26,0.06)",
    "pulse-control-hover-bg": "rgba(52,44,35,0.05)",
    "pulse-empty-bg": "#F5EFE5",
    // Fynbos heat ramp: opaque stops stepping L and C; level 1 must stay ≥ JND
    // above the empty cell. heat-color stays the deep end for single-color
    // consumers.
    "pulse-heat-1": "#95B49B",
    "pulse-heat-2": "#689A72",
    "pulse-heat-3": "#407F4E",
    "pulse-heat-4": "#286830",
    "pulse-heat-color": "#286830",
    "pulse-range-bg": "#F5EFE5",
    "pulse-ring-offset": "#FFFFFF",
    "pulse-skeleton-gradient": "linear-gradient(90deg, #DFCFB8 25%, #F4EEE3 50%, #DFCFB8 75%)",
    "dialog-header-bg": "#FCF9F4",
    "review-commit-input-bg": "#FFFCF8",
    "settings-kbd-bg": "#F3ECE1",
    "settings-kbd-border": "#D5CBBD",
    // Nav selection elevates to white + the 2px accent marker.
    "settings-nav-active-bg": "#FFFFFF",
    "settings-nav-active-shadow": "none",
    "settings-nav-hover-bg": "rgba(52,44,35,0.05)",
    // Scope pill elevates to white on the tinted settings sidebar.
    "settings-scope-bg": "#FFFFFF",
    "settings-sidebar-bg": "rgba(240,231,217,0.60)",
    // Composited settings-sidebar-bg over the shell.
    "settings-sidebar-scroll-fade": "#F4EDE3",
    "sidebar-action-hover-bg": "rgba(52,44,35,0.05)",
    // idle < hover < selected (audit-enforced); contact shadow only, no ring —
    // selection = bg + right accent rail.
    "sidebar-card-bg": "#FBF5EE",
    "sidebar-card-shadow": "0 1px 3px rgba(40,34,26,0.04)",
    "sidebar-active-bg": "#FFFFFF",
    "sidebar-hover-bg": "#FEFBF7",
    "toolbar-agent-hover-bg": "rgba(35,31,26,0.06)",
    "toolbar-control-hover-bg": "rgba(35,31,26,0.06)",
    // Accent restraint: hover affordance is the bg, not an accent foreground.
    "toolbar-control-hover-fg": "#231F1A",
    "toolbar-control-hover-shadow": "none",
    "toolbar-divider": "rgba(213,203,189,0.7)",
    "toolbar-pill-radius": "0.5rem",
    // Lichen-gold whisper, deliberately not the protea accent — the accent
    // stays scarce (rail/marker/CTA/ring only). Pills sit lighter than the
    // chrome strip.
    "toolbar-project-bg":
      "linear-gradient(180deg, rgba(207,168,72,0.07), rgba(35,31,26,0.02)), #FBF7F2",
    "toolbar-project-border": "rgba(213,203,189,0.75)",
    "toolbar-project-chip-bg": "rgba(35,31,26,0.04)",
    "toolbar-project-chip-border": "rgba(213,203,189,0.75)",
    "toolbar-project-shadow": "inset 0 1px 0 rgba(255,255,255,0.5)",
    "toolbar-shadow": "0 1px 2px rgba(40,34,26,0.06)",
    "toolbar-stats-bg": "#FBF7F2",
    "toolbar-stats-border": "rgba(213,203,189,0.7)",
    "toolbar-stats-divider": "rgba(213,203,189,0.7)",
    "toolbar-stats-hover-bg": "#FEFBF7",
    // No welcome-field-wash: a full-field gradient would band; the welcome
    // field stays flat and the mark keeps the engine default.
    // Filter rail sits flush on the field; the raised search input carries it.
    "worktree-filter-bar-bg": "#F0E7D9",
    // Active quick-state tab lifts to white under its inset underline.
    "worktree-quick-state-active-bg": "#FFFFFF",
    "worktree-search-input-bg": "#FFFCF8",
    "worktree-section-hover-bg": "rgba(52,44,35,0.05)",
  },
};
