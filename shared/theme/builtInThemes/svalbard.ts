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
    // Arctic shoreline composition (#9714, on the Bondi template from #9711):
    // ONE cool glacial stone family for the whole field (H~237-248) with
    // snow-white content on top. The tundra's warmth appears only as detail —
    // amber search highlights, the warning status, the terminal cursor, the
    // project-pill whisper — never as a field surface. Everything that
    // carries content lifts TOWARD white — never a darker fill on a light
    // container (the old ramp topped out at L 0.979 and read as one dim
    // blue-gray sheet).
    // Ramp L 0.882/0.936/0.958/0.979/1.0: steps 0.0207-0.0548 (gate ≥ 0.02,
    // runaway ratio 2.65 < 3), span 0.119, panel→elevated not the smallest
    // step. The grid is WET STONE — a full register deeper and richer than
    // the dry-stone sidebar, so chrome/field/well read as three planes and
    // white panels get real figure-ground pop.
    surfaces: {
      grid: "#CDDAE4",
      sidebar: "#E3EBF3",
      canvas: "#ECF2F7",
      panel: "#F3F9FD",
      elevated: "#FFFFFF",
    },
    text: {
      // Near-neutral cool ink — the old text carried C≈0.035 of blue, which
      // read dirty on the hued field. Floored like Bondi: muted 4.8:1 on the
      // grid, 6.1:1 on canvas; secondary 6.0:1 on the grid.
      primary: "#192128",
      secondary: "#444D57",
      muted: "#555B63",
      inverse: "#FDFDFE",
    },
    border: "#C5CFD6",
    accent: "#1577A8",
    accentSecondary: "#1F7E62",
    // success/danger/warning render as TEXT (diff numerals, status labels) on
    // the near-white chips — all hold ≥ 4.5:1 on every surface up to #FFFFFF.
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
    // Glacial ink, desaturated: the overlay/wash ladder composites onto the
    // stone field, and the old navy tint (#142332, C 0.035) read as a storm
    // front in dialog scrims. Same hue family as the field, chroma whispered.
    overlayTint: "#273037",
    terminal: {
      // Deep arctic water below the ice shelf — its own dark environment.
      background: "#1B2531",
      foreground: "#C9D3DE",
      // 3.59:1 on the terminal background (the old #8C9E94 was a stray
      // green-gray on the blue-night water).
      muted: "#6E7B8A",
      // Tundra amber — the one warm signal in the dark water (the old
      // #8F7335 cursor sat at 3.4:1 and disappeared).
      cursor: "#E8A03C",
      selection: "#2A3A4A",
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
      keyword: "#7A4FA8",
      function: "#3A5FB0",
      // The old chip #68B0B8 sat at 2.1:1 on the panel; the aurora-green
      // accentSecondary holds 4.7:1.
      link: "#1E6A88",
      quote: "#566472",
      chip: "#1F7E62",
    },
    strategy: {
      shadowStyle: "light",
      materialBlur: 14,
      materialSaturation: 118,
    },
  },
  tokens: {
    "accent-muted": "rgba(21,119,168,0.30)",
    "accent-soft": "rgba(21,119,168,0.18)",
    "focus-ring": "rgba(21,119,168,0.35)",
    "overlay-hover": "rgba(39,48,55,0.08)",
    // Derived 3% is sub-threshold over near-white surfaces.
    "overlay-soft": "rgba(39,48,55,0.055)",
    // Opaque elevate-to-select for menu/palette rows on white popovers; cool
    // so a selected row reads as the same material, not a warm slab. A half
    // register lighter than Bondi's equivalent (dL 0.052 vs 0.064 below
    // white): at equal depth a cool fill reads heavier than a warm one, and
    // the Bondi-matched value read as a blue-grey slab in design review.
    "overlay-raised": "#E8EFF4",
    // GitHub-brand defaults fail AA on the near-white panel.
    "pr-merged": "#6C5CA8",
    "pr-draft": "#586470",
    "scrollbar-thumb": "#6E7981",
    "scrollbar-thumb-hover": "color-mix(in oklab, #6E7981 85%, #192128)",
    // Engine light scrims (0.22/0.36/0.55) read as a storm front here.
    "scrim-soft": "rgba(39,48,55,0.16)",
    "scrim-medium": "rgba(39,48,55,0.28)",
    "scrim-strong": "rgba(39,48,55,0.46)",
    // Search is the tundra's warmth — the opposing temperature exists only
    // as small details on the cool field (mirror of Bondi's sea-blue
    // highlights on warm sand).
    "search-highlight-background": "rgba(194,126,26,0.14)",
    "search-highlight-text": "#875807",
    "search-match-badge-background": "rgba(194,126,26,0.14)",
    "search-match-badge-text": "#875807",
    "search-selected-result-border": "rgba(194,126,26,0.34)",
    "search-selected-result-icon": "#875807",
    // Two-layer contact+spread; the engine "light" single penumbra has no
    // contact edge on a near-white field.
    "shadow-ambient": "0 1px 2px rgba(34,42,48,0.10), 0 6px 16px rgba(34,42,48,0.10)",
    // Dialogs sit a full z-tier above menus/popovers (the floating fallback
    // would give a centered modal the same shadow as a context menu).
    "shadow-dialog": "0 2px 6px rgba(34,42,48,0.10), 0 24px 60px rgba(34,42,48,0.18)",
    "shadow-floating": "0 1px 3px rgba(34,42,48,0.12), 0 12px 32px rgba(34,42,48,0.14)",
    // In-card chips: a cool stone inset one quiet step below the white card,
    // not a recessed slab.
    "surface-inset": "#EAF0F5",
    // Inputs are raised on light, never recessed (the old #D6E1EA input sat
    // BELOW its container and read as a well).
    "surface-input": "#FAFCFE",
    // Fog chrome: the frame (toolbar/dock/panel caps/dialog headers) carries
    // Svalbard's glacial note at whisper chroma, one register apart from the
    // field surfaces rather than a different temperature.
    "surface-toolbar": "#EAEFF3",
    "terminal-bright-black": "#525E6C",
    "terminal-white": "#C9D3DE",
    "text-link": "#11618C",
    // 4.3:1 on the raised input.
    "text-placeholder": "rgba(25,33,40,0.60)",
  },
  extensions: {
    "dock-bg": "#EAEFF3",
    "dock-input-bg": "#FAFCFE",
    // Registry format guard: shadow-color channels, alpha ≥ 0.25.
    "dock-shadow": "0 -2px 8px rgb(from var(--theme-shadow-color) r g b / 0.25)",
    // Panel title bars join the fog chrome; the focused pane's cap brightens.
    "panel-header-bg": "#ECF1F4",
    "panel-header-focus-bg": "#F2F7FA",
    // Emoji tiles get a white-gloss lift instead of the dark-theme black wash
    // (which rendered murky gray chips on the light field).
    "project-tile-wash":
      "linear-gradient(to bottom, rgba(255,255,255,0.40), rgba(255,255,255,0.10))",
    "project-tile-shadow": "inset 0 1px 1px rgba(34,42,48,0.10), 0 0 0 1px rgba(35,43,51,0.10)",
    "pulse-before-bg": "#CDDAE4",
    "pulse-card-bg": "#FFFFFF",
    "pulse-card-header-bg": "#F5F8FB",
    "pulse-card-shadow": "0 1px 2px rgba(34,42,48,0.10), 0 4px 10px rgba(34,42,48,0.08)",
    "pulse-control-hover-bg": "rgba(39,48,55,0.05)",
    "pulse-empty-bg": "#ECF2F7",
    "pulse-heat-high-opacity": "0.85",
    "pulse-heat-low-opacity": "0.38",
    "pulse-heat-medium-opacity": "0.62",
    // Aurora green — activity reads as the sky lighting up.
    "pulse-heat-color": "#1F7E62",
    // Opaque so the streak-break signal clears the 3:1 graphical floor.
    "pulse-missed-bg": "#C0413E",
    "pulse-range-bg": "#ECF2F7",
    "pulse-ring-offset": "#FFFFFF",
    "pulse-skeleton-gradient": "linear-gradient(90deg, #CDDAE4 25%, #ECF2F7 50%, #CDDAE4 75%)",
    "dialog-header-bg": "#F5FAFD",
    "review-commit-input-bg": "#FAFCFE",
    "settings-kbd-bg": "#EAF0F5",
    "settings-kbd-border": "#C5CFD6",
    // Nav selection elevates to white + the 2px accent marker; the inherited
    // overlay-raised darker-lift is for menu rows on white popovers only.
    "settings-nav-active-bg": "#FFFFFF",
    // Flat like the dark themes: the white fill + 2px accent marker carry
    // selection, no ring or shadow.
    "settings-nav-active-shadow": "none",
    "settings-nav-hover-bg": "rgba(30,42,58,0.05)",
    // Scope pill elevates to white on the tinted settings sidebar.
    "settings-scope-bg": "#FFFFFF",
    "settings-sidebar-bg": "rgba(227,235,243,0.60)",
    "sidebar-action-hover-bg": "rgba(30,42,58,0.05)",
    // Worktree cards are snow highlights on the stone field; hover brightens
    // toward white; selected is pure white + the accent rail.
    // idle < hover < selected is audit-enforced — the old ladder darkened on
    // selection (active sat BELOW the cards around it); these sit ~1.4 OKLab
    // points apart.
    // Soft contact shadow only — no ring: the card must not read as bordered
    // (#9711 round-3 owner decision; selection = bg + right accent border).
    "sidebar-card-bg": "#F1F7FC",
    "sidebar-card-shadow": "0 1px 2px rgba(28,40,52,0.05)",
    "sidebar-active-bg": "#FFFFFF",
    "sidebar-hover-bg": "#F9FBFD",
    "toolbar-agent-hover-bg": "rgba(25,33,40,0.06)",
    "toolbar-control-hover-bg": "rgba(25,33,40,0.06)",
    // Accent restraint: hover affordance is the bg, not a blue foreground.
    "toolbar-control-hover-fg": "#192128",
    "toolbar-control-hover-shadow": "none",
    "toolbar-divider": "rgba(197,207,214,0.7)",
    "toolbar-pill-radius": "0.5rem",
    // One tundra-amber whisper on the project pill; everything else quiet ink.
    // Pills sit LIGHTER than the chrome strip (raised, like all content).
    "toolbar-project-bg":
      "linear-gradient(180deg, rgba(232,160,60,0.07), rgba(25,33,40,0.02)), #F6F8FA",
    "toolbar-project-border": "rgba(197,207,214,0.75)",
    "toolbar-project-chip-bg": "rgba(25,33,40,0.04)",
    "toolbar-project-chip-border": "rgba(197,207,214,0.75)",
    "toolbar-project-shadow": "inset 0 1px 0 rgba(255,255,255,0.5)",
    "toolbar-shadow": "0 1px 2px rgba(34,42,48,0.06)",
    "toolbar-stats-bg": "#F6F8FA",
    "toolbar-stats-border": "rgba(197,207,214,0.7)",
    "toolbar-stats-divider": "rgba(197,207,214,0.7)",
    "toolbar-stats-hover-bg": "#F9FBFD",
    // Filter rail sits flush on the field; the raised search input carries it.
    "worktree-filter-bar-bg": "#E3EBF3",
    // Active quick-state tab lifts to white under its inset underline.
    "worktree-quick-state-active-bg": "#FFFFFF",
    "worktree-search-input-bg": "#FAFCFE",
    "worktree-section-hover-bg": "rgba(30,42,58,0.05)",
  },
};
