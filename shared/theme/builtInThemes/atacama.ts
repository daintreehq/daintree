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
    // Salt-flat composition (#9709, Bondi-derived): ONE warm desert-crust
    // family for the whole field (H~77-85) with white content floating on
    // top. The lagoon's turquoise appears only as detail — info status,
    // search highlights, pulse-heat, syntax water roles — never as a field
    // surface. The terracotta accent is the canyon note and stays scarce.
    // Everything that carries content lifts TOWARD white — never a darker
    // fill on a light container.
    // Ramp L 0.886/0.936/0.957/0.978/1.0: steps 0.0208-0.0505 (gate ≥ 0.02,
    // runaway 2.43 < 3), span 0.115, panel→elevated not the smallest step.
    // The grid is DAMP CRUST — a full register deeper and richer (C 0.034 vs
    // 0.023) than the dry-crust sidebar, so chrome/field/well read as three
    // planes and white panels get real figure-ground pop. The old ramp
    // compressed the top tiers (canvas L 0.928, elevated 0.983) into one
    // beige sheet; this one reaches true white.
    surfaces: {
      grid: "#E6D7C1",
      sidebar: "#F1E9D9",
      canvas: "#F6F0E5",
      panel: "#FCF7F0",
      elevated: "#FFFFFF",
    },
    text: {
      primary: "#272119",
      // Near-neutral warm ink (C ≤ 0.02): the old #574C43/#6E6155 carried
      // enough chroma to read dirty on the hued field. Muted holds 5.6:1 on
      // the grid and 6.9:1 on canvas; secondary 6.8:1 on the grid.
      secondary: "#4B4439",
      muted: "#59513F",
      inverse: "#FDFCF9",
    },
    border: "#D4CBBD",
    accent: "#B25024",
    accentSecondary: "#3E7A50",
    // success/danger/warning/info render as TEXT (diff numerals, status
    // labels) — all hold ≥ 4.5:1 on every surface from the sidebar up to
    // #FFFFFF. Danger sits at H 32 (crimson side of rust) so it separates
    // from the H 42 terracotta accent; info is the lagoon turquoise. Success
    // runs cool (H 167, not the field-adjacent H~152) so diff-addition
    // washes read as clear green, not olive, on the warm crust.
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
    // Desert ink, not slate: the overlay/wash ladder composites onto the
    // crust field, and a cool tint there reads as grime, not shadow.
    overlayTint: "#332B23",
    terminal: {
      // Adobe night — the terminal is its own environment, the dark under
      // the clearest sky on Earth, kept warm so it joins the field's
      // temperature rather than opening a cool hole in the workbench.
      background: "#24201D",
      foreground: "#DCD4C8",
      // 3.88:1 on the terminal background (the old #918980 ANSI ramp ran
      // muted throughout and several slots fell under the 0.18 dL floor).
      muted: "#837A6E",
      cursor: "#E2A33D",
      selection: "#3C342A",
      red: "#E06A55",
      green: "#43B26B",
      yellow: "#E2A33D",
      blue: "#4FA3DC",
      magenta: "#BC85E8",
      cyan: "#2FAEC2",
      brightRed: "#F4937F",
      brightGreen: "#5ECF8B",
      brightYellow: "#F2C160",
      brightBlue: "#86C3F0",
      brightMagenta: "#D4A8F4",
      brightCyan: "#5FD3E4",
      brightWhite: "#F4EEE3",
    },
    // Every glyph role clears 4.5:1 on the canvas it renders on in the file
    // viewer AND the 0.18 dL floor on the dark terminal.
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
      shadowStyle: "light",
      materialBlur: 12,
      materialSaturation: 118,
    },
  },
  tokens: {
    "accent-muted": "rgba(178,80,36,0.30)",
    "accent-soft": "rgba(178,80,36,0.18)",
    "focus-ring": "rgba(178,80,36,0.35)",
    "overlay-hover": "rgba(51,43,35,0.08)",
    // Derived 3% is sub-threshold over near-white surfaces.
    "overlay-soft": "rgba(51,43,35,0.055)",
    // Opaque elevate-to-select for menu/palette rows on white popovers; warm
    // so a selected row reads as the same material, not a cool slab. Sits a
    // touch lighter than Bondi's depth — crust at full register reads
    // recessed, not selected, on the white popover.
    "overlay-raised": "#F1ECE4",
    // Engine light default (#5C6571) is cool slate; re-inked warm to match
    // the field. pr-open/merged/closed defaults already clear AA here.
    "pr-draft": "#6B6253",
    "scrollbar-thumb": "#7A7163",
    "scrollbar-thumb-hover": "color-mix(in oklab, #7A7163 85%, #272119)",
    // Engine light scrims (0.22/0.36/0.55) read as a storm front here.
    "scrim-soft": "rgba(51,43,35,0.16)",
    "scrim-medium": "rgba(51,43,35,0.28)",
    "scrim-strong": "rgba(51,43,35,0.46)",
    // Lagoon turquoise: the opposing temperature lives only in details.
    "search-highlight-background": "rgba(22,112,127,0.14)",
    "search-highlight-text": "#16707F",
    "search-match-badge-background": "rgba(22,112,127,0.14)",
    "search-match-badge-text": "#16707F",
    "search-selected-result-border": "rgba(22,112,127,0.34)",
    "search-selected-result-icon": "#16707F",
    // Two-layer contact+spread; the engine "light" single penumbra has no
    // contact edge on a near-white field. Shadow ink derives from the crust.
    "shadow-ambient": "0 1px 2px rgba(45,37,26,0.10), 0 6px 16px rgba(45,37,26,0.10)",
    // Dialogs sit a full z-tier above menus/popovers (the floating fallback
    // would give a centered modal the same shadow as a context menu).
    "shadow-dialog": "0 2px 6px rgba(45,37,26,0.10), 0 24px 60px rgba(45,37,26,0.18)",
    "shadow-floating": "0 1px 3px rgba(45,37,26,0.12), 0 12px 32px rgba(45,37,26,0.14)",
    // In-card chips: a warm crust inset one quiet step below the white card,
    // not a recessed slab.
    "surface-inset": "#F4F0E7",
    // Inputs are raised on light, never recessed (overrides the engine's
    // recessed derivation; promote to the engine once the light family is
    // rebuilt from Bondi).
    "surface-input": "#FDFBF7",
    // Crust chrome: the frame (toolbar/dock/panel caps/dialog headers)
    // carries the desert note at whisper chroma (C ~0.010), one register
    // apart from the field surfaces rather than a different temperature.
    "surface-toolbar": "#F0EDE6",
    // 3.18:1 — dim-tier CLI text still reads on the adobe night.
    "terminal-bright-black": "#766D61",
    "terminal-white": "#DCD4C8",
    "text-link": "#9B3F18",
    // 4.2:1 on the raised input.
    "text-placeholder": "rgba(39,33,25,0.60)",
  },
  extensions: {
    "dock-bg": "#F0EDE6",
    "dock-input-bg": "#FDFBF7",
    // Registry format guard: shadow-color channels, alpha ≥ 0.25.
    "dock-shadow": "0 -2px 8px rgb(from var(--theme-shadow-color) r g b / 0.25)",
    // Panel title bars join the crust chrome; the focused pane's cap brightens.
    "panel-header-bg": "#F2EFE8",
    "panel-header-focus-bg": "#F7F5F0",
    // Emoji tiles get a white-gloss lift instead of the dark-theme black wash
    // (which rendered murky gray chips on the light field).
    "project-tile-wash":
      "linear-gradient(to bottom, rgba(255,255,255,0.40), rgba(255,255,255,0.10))",
    "project-tile-shadow": "inset 0 1px 1px rgba(45,37,26,0.10), 0 0 0 1px rgba(45,37,26,0.10)",
    "pulse-before-bg": "#E6D7C1",
    "pulse-card-bg": "#FFFFFF",
    "pulse-card-header-bg": "#FCF7F0",
    "pulse-card-shadow": "0 1px 2px rgba(45,37,26,0.10), 0 4px 10px rgba(45,37,26,0.08)",
    "pulse-control-hover-bg": "rgba(51,43,35,0.05)",
    "pulse-empty-bg": "#F6F0E5",
    "pulse-heat-high-opacity": "0.85",
    "pulse-heat-low-opacity": "0.38",
    "pulse-heat-medium-opacity": "0.62",
    "pulse-heat-color": "#16707F",
    // Opaque so the streak-break signal clears the 3:1 graphical floor.
    "pulse-missed-bg": "#A33530",
    "pulse-range-bg": "#F6F0E5",
    "pulse-ring-offset": "#FFFFFF",
    "pulse-skeleton-gradient": "linear-gradient(90deg, #E6D7C1 25%, #F6F0E5 50%, #E6D7C1 75%)",
    "dialog-header-bg": "#FBF9F4",
    "review-commit-input-bg": "#FDFBF7",
    "settings-kbd-bg": "#F4F0E7",
    "settings-kbd-border": "#D4CBBD",
    // Nav selection elevates to white + the 2px accent marker; the inherited
    // overlay-raised darker-lift is for menu rows on white popovers only.
    "settings-nav-active-bg": "#FFFFFF",
    // Flat like the dark themes: the white fill + 2px accent marker carry
    // selection, no ring or shadow.
    "settings-nav-active-shadow": "none",
    "settings-nav-hover-bg": "rgba(60,48,30,0.05)",
    // Scope pill elevates to white on the tinted settings sidebar.
    "settings-scope-bg": "#FFFFFF",
    "settings-sidebar-bg": "rgba(241,233,217,0.60)",
    "sidebar-action-hover-bg": "rgba(60,48,30,0.05)",
    // Worktree cards are paper highlights on the crust field; hover brightens
    // toward white; selected is pure white + the accent rail.
    // idle < hover < selected is audit-enforced, ~1.5 OKLab points per step
    // (the old ladder darkened to select — figure-ground inversion).
    // Soft contact shadow only — no ring: the card must not read as bordered
    // (selection = bg + right accent border).
    "sidebar-card-bg": "#F8F4EB",
    "sidebar-card-shadow": "0 1px 2px rgba(48,40,26,0.05)",
    "sidebar-active-bg": "#FFFFFF",
    "sidebar-hover-bg": "#FCF9F5",
    "toolbar-agent-hover-bg": "rgba(39,33,25,0.06)",
    "toolbar-control-hover-bg": "rgba(39,33,25,0.06)",
    // Accent restraint: hover affordance is the bg, not a terracotta foreground.
    "toolbar-control-hover-fg": "#272119",
    "toolbar-control-hover-shadow": "none",
    "toolbar-divider": "rgba(212,203,189,0.7)",
    "toolbar-pill-radius": "0.5rem",
    // One copper whisper on the project pill; everything else quiet ink.
    // Pills sit LIGHTER than the chrome strip (raised, like all content).
    "toolbar-project-bg":
      "linear-gradient(180deg, rgba(178,80,36,0.06), rgba(39,33,25,0.02)), #FBF7F0",
    "toolbar-project-border": "rgba(212,203,189,0.75)",
    "toolbar-project-chip-bg": "rgba(39,33,25,0.04)",
    "toolbar-project-chip-border": "rgba(212,203,189,0.75)",
    "toolbar-project-shadow": "inset 0 1px 0 rgba(255,255,255,0.5)",
    "toolbar-shadow": "0 1px 2px rgba(45,37,26,0.06)",
    "toolbar-stats-bg": "#FBF7F2",
    "toolbar-stats-border": "rgba(212,203,189,0.7)",
    "toolbar-stats-divider": "rgba(212,203,189,0.7)",
    "toolbar-stats-hover-bg": "#FCF9F5",
    // Filter rail sits flush on the field; the raised search input carries it.
    "worktree-filter-bar-bg": "#F1E9D9",
    // Active quick-state tab lifts to white under its inset underline.
    "worktree-quick-state-active-bg": "#FFFFFF",
    "worktree-search-input-bg": "#FDFBF7",
    "worktree-section-hover-bg": "rgba(60,48,30,0.05)",
  },
};
