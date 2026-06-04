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
    // Sandstone composition (#9715, Bondi-derived): ONE golden-sandstone family
    // for the whole field (H~73-85) with white content on top. The fynbos
    // colours appear only as detail — protea-pink accent, fynbos-green
    // secondary, slate-Atlantic search/info, and the mountain-shadow terminal —
    // never as a field surface. Everything that carries content lifts TOWARD
    // white — never a darker fill on a light container.
    // Ramp L 0.882/0.937/0.958/0.978/1.0: steps 0.0203-0.0553 (gate ≥ 0.02,
    // runaway 2.72 < 3), span 0.118, panel→elevated not the smallest step. The
    // grid is WET SANDSTONE — a full register deeper and richer than the
    // dry-stone sidebar, so chrome/field/well read as three planes and white
    // panels get real figure-ground pop.
    surfaces: {
      grid: "#E3D6C5",
      sidebar: "#F1E9DE",
      canvas: "#F6F0E8",
      panel: "#FCF7F1",
      elevated: "#FFFFFF",
    },
    text: {
      primary: "#231F1A",
      // Near-neutral warm ink (C ≤ 0.014), floored: muted holds 5.0:1 on the
      // grid and 6.3:1 on canvas; secondary ≥ 6:1 everywhere it sits.
      secondary: "#514B44",
      muted: "#5C5750",
      inverse: "#FDFCF9",
    },
    border: "#D5CBBD",
    accent: "#B0466F",
    accentSecondary: "#3C7A4C",
    // success/danger/warning render as TEXT (diff numerals, status labels) on
    // the near-white chips — all hold ≥ 4.5:1 on every surface up to #FFFFFF.
    status: {
      success: "#2E7B45",
      warning: "#9C6210",
      danger: "#AE3D33",
      info: "#2D6E94",
    },
    activity: {
      active: "#1E8A42",
      // The old #857B6F idle dot sat under 3:1 on white; floored to a warm
      // stone-gray that clears the graphical minimum on every chrome surface.
      idle: "#696259",
      working: "#1E8A42",
      waiting: "#9C6E0C",
    },
    // Warm stone ink: the overlay/wash ladder composites onto the sandstone
    // field; a cool tint there reads as grime, not depth.
    overlayTint: "#342C23",
    terminal: {
      // The mountain face in shadow — warm near-black, its own environment
      // below the sunlit field.
      background: "#261F1B",
      foreground: "#E0D8D0",
      // 3.27:1 on the terminal background.
      muted: "#796E64",
      cursor: "#CFA848",
      // Opaque warm lift, not an accent wash — selection must read as the same
      // dark material.
      selection: "#3A3129",
      // Re-inked from the old washed-out pastels: every base colour clears
      // 4.5:1 on the terminal background (red was the floor case at 4.8:1).
      red: "#E4635B",
      green: "#41B06E",
      yellow: "#DFA63B",
      blue: "#58A8DC",
      // Protea pink carried into the terminal at 5.3:1.
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
      keyword: "#853AA2",
      function: "#2C5DAD",
      link: "#1C6D78",
      quote: "#5A6854",
      // Was a light teal (#7ecfca) that vanished on the light field; chips
      // carry the fynbos-green secondary instead.
      chip: "#3C7A4C",
    },
    strategy: {
      shadowStyle: "light",
      materialBlur: 12,
      materialSaturation: 120,
    },
  },
  tokens: {
    "accent-muted": "rgba(176,70,111,0.30)",
    "accent-soft": "rgba(176,70,111,0.18)",
    "focus-ring": "rgba(176,70,111,0.30)",
    "overlay-hover": "rgba(52,44,35,0.08)",
    // Derived 3% is sub-threshold over near-white surfaces.
    "overlay-soft": "rgba(52,44,35,0.055)",
    // Opaque elevate-to-select for menu/palette rows on white popovers; warm
    // so a selected row reads as the same material, not a cool slab.
    "overlay-raised": "#EFE9E1",
    // GitHub-brand defaults fail AA on the near-white panel.
    "pr-merged": "#7644CC",
    "pr-draft": "#6A655C",
    "scrollbar-thumb": "#767169",
    "scrollbar-thumb-hover": "color-mix(in oklab, #767169 85%, #231F1A)",
    // Engine light scrims (0.22/0.36/0.55) read as a storm front here.
    "scrim-soft": "rgba(52,44,35,0.16)",
    "scrim-medium": "rgba(52,44,35,0.28)",
    "scrim-strong": "rgba(52,44,35,0.46)",
    // Search keeps the cold-Atlantic slate as a small-detail temperature note.
    "search-highlight-background": "rgba(40,97,138,0.14)",
    "search-highlight-text": "#28618A",
    "search-match-badge-background": "rgba(40,97,138,0.14)",
    "search-match-badge-text": "#28618A",
    "search-selected-result-border": "rgba(40,97,138,0.34)",
    "search-selected-result-icon": "#28618A",
    // Two-layer contact+spread; the engine "light" single penumbra has no
    // contact edge on a near-white field. Warm shadow ink, not cool.
    "shadow-ambient": "0 1px 2px rgba(40,34,26,0.10), 0 6px 16px rgba(40,34,26,0.10)",
    // Dialogs sit a full z-tier above menus/popovers (the floating fallback
    // would give a centered modal the same shadow as a context menu).
    "shadow-dialog": "0 2px 6px rgba(40,34,26,0.10), 0 24px 60px rgba(40,34,26,0.18)",
    "shadow-floating": "0 1px 3px rgba(40,34,26,0.12), 0 12px 32px rgba(40,34,26,0.14)",
    // In-card chips: a warm stone inset one quiet step below the white card,
    // not a recessed slab.
    "surface-inset": "#F4EEE6",
    // Inputs are raised on light, never recessed (overrides the engine's
    // recessed derivation, matching Bondi).
    "surface-input": "#FFFCF8",
    // Stone chrome: the frame (toolbar/dock/panel caps/dialog headers) carries
    // the sandstone note at whisper chroma, one register apart from the field
    // surfaces rather than a different temperature.
    "surface-toolbar": "#F2EDE6",
    "terminal-bright-black": "#5D534B",
    "terminal-white": "#E0D8D0",
    "text-link": "#94335B",
    // 4.3:1 on the raised input.
    "text-placeholder": "rgba(35,31,26,0.60)",
  },
  extensions: {
    "dock-bg": "#F2EDE6",
    "dock-input-bg": "#FFFCF8",
    // Registry format guard: shadow-color channels, alpha ≥ 0.25.
    "dock-shadow": "0 -2px 8px rgb(from var(--theme-shadow-color) r g b / 0.25)",
    // Panel title bars join the stone chrome; the focused pane's cap brightens.
    "panel-header-bg": "#F3EFE9",
    "panel-header-focus-bg": "#F9F5F0",
    // Emoji tiles get a white-gloss lift instead of the dark-theme black wash
    // (which rendered murky gray chips on the light field).
    "project-tile-wash":
      "linear-gradient(to bottom, rgba(255,255,255,0.40), rgba(255,255,255,0.10))",
    "project-tile-shadow": "inset 0 1px 1px rgba(40,34,26,0.10), 0 0 0 1px rgba(40,34,26,0.10)",
    "pulse-before-bg": "#E3D6C5",
    "pulse-card-bg": "#FFFFFF",
    "pulse-card-header-bg": "#FBF7F2",
    "pulse-card-shadow": "0 1px 2px rgba(40,34,26,0.10), 0 4px 10px rgba(40,34,26,0.08)",
    "pulse-control-hover-bg": "rgba(52,44,35,0.05)",
    "pulse-empty-bg": "#F6F0E8",
    "pulse-heat-high-opacity": "0.85",
    "pulse-heat-low-opacity": "0.38",
    "pulse-heat-medium-opacity": "0.62",
    "pulse-heat-color": "#3C7A4C",
    // Opaque so the streak-break signal clears the 3:1 graphical floor.
    "pulse-missed-bg": "#AE3D33",
    "pulse-range-bg": "#F6F0E8",
    "pulse-ring-offset": "#FFFFFF",
    "pulse-skeleton-gradient": "linear-gradient(90deg, #E0D7C9 25%, #F5F0E9 50%, #E0D7C9 75%)",
    "dialog-header-bg": "#FCF9F4",
    "review-commit-input-bg": "#FFFCF8",
    "settings-kbd-bg": "#F4EEE6",
    "settings-kbd-border": "#D5CBBD",
    // Nav selection elevates to white + the 2px accent marker; the inherited
    // overlay-raised darker-lift is for menu rows on white popovers only.
    "settings-nav-active-bg": "#FFFFFF",
    // Flat like the dark themes: the white fill + 2px accent marker carry
    // selection, no ring or shadow.
    "settings-nav-active-shadow": "none",
    "settings-nav-hover-bg": "rgba(52,44,35,0.05)",
    // Scope pill elevates to white on the tinted settings sidebar.
    "settings-scope-bg": "#FFFFFF",
    "settings-sidebar-bg": "rgba(241,233,222,0.60)",
    "sidebar-action-hover-bg": "rgba(52,44,35,0.05)",
    // Worktree cards are paper highlights on the sandstone field; hover
    // brightens toward white; selected is pure white + the accent rail.
    // idle < hover < selected is audit-enforced, each step ~1.5 OKLab points.
    // Soft contact shadow only — no ring: the card must not read as bordered
    // (selection = bg + right accent border, per the Bondi owner decision).
    "sidebar-card-bg": "#FBF5EE",
    "sidebar-card-shadow": "0 1px 2px rgba(40,34,26,0.05)",
    "sidebar-active-bg": "#FFFFFF",
    "sidebar-hover-bg": "#FEFBF7",
    "toolbar-agent-hover-bg": "rgba(35,31,26,0.06)",
    "toolbar-control-hover-bg": "rgba(35,31,26,0.06)",
    // Accent restraint: hover affordance is the bg, not a protea foreground.
    "toolbar-control-hover-fg": "#231F1A",
    "toolbar-control-hover-shadow": "none",
    "toolbar-divider": "rgba(213,203,189,0.7)",
    "toolbar-pill-radius": "0.5rem",
    // One protea whisper on the project pill; everything else quiet ink.
    // Pills sit LIGHTER than the chrome strip (raised, like all content).
    "toolbar-project-bg":
      "linear-gradient(180deg, rgba(176,70,111,0.085), rgba(35,31,26,0.02)), #FBF7F2",
    "toolbar-project-border": "rgba(213,203,189,0.75)",
    "toolbar-project-chip-bg": "rgba(35,31,26,0.04)",
    "toolbar-project-chip-border": "rgba(213,203,189,0.75)",
    "toolbar-project-shadow": "inset 0 1px 0 rgba(255,255,255,0.5)",
    "toolbar-shadow": "0 1px 2px rgba(40,34,26,0.06)",
    "toolbar-stats-bg": "#FBF7F2",
    "toolbar-stats-border": "rgba(213,203,189,0.7)",
    "toolbar-stats-divider": "rgba(213,203,189,0.7)",
    "toolbar-stats-hover-bg": "#FEFBF7",
    // Filter rail sits flush on the field; the raised search input carries it.
    "worktree-filter-bar-bg": "#F1E9DE",
    // Active quick-state tab lifts to white under its inset underline.
    "worktree-quick-state-active-bg": "#FFFFFF",
    "worktree-search-input-bg": "#FFFCF8",
    "worktree-section-hover-bg": "rgba(52,44,35,0.05)",
  },
};
