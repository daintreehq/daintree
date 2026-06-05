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
    // Golden-hour savanna, rebuilt to the Bondi standard (#9713): ONE golden
    // grass family for the whole field (H~95-100) with white content lifting
    // on top. Acacia green appears only as detail — accentSecondary, search
    // highlights, success status, pulse heat — never as a field surface, and
    // the night-earth terminal is its own environment below the grass.
    // Everything that carries content lifts TOWARD white — never a darker
    // fill on a light container.
    // Ramp L 0.882/0.937/0.958/0.979/1.0: steps 0.0205-0.0553 (gate ≥ 0.02,
    // runaway ratio 2.7 < 3), span 0.118, panel→elevated not the smallest
    // step. The grid is SUNLIT GRASS — a full register deeper and richer
    // (C 0.063 vs 0.040) than the pale-straw sidebar, so chrome/field/well
    // read as three planes and white panels get real figure-ground pop.
    surfaces: {
      grid: "#E3D9AA",
      sidebar: "#F1EBCD",
      canvas: "#F6F2DB",
      panel: "#FBF8EE",
      elevated: "#FFFFFF",
    },
    text: {
      // Near-neutral warm ink (C ≤ 0.022), not the heavy brown of the old
      // palette — hued grey on a hued field reads dirty. Muted holds 5.5:1
      // on the grid and 6.9:1 on canvas; secondary ≥ 6.5:1 everywhere.
      primary: "#26211A",
      secondary: "#4D473C",
      muted: "#585245",
      inverse: "#FFFEF8",
    },
    // Calmer chroma than the field (C 0.034 vs 0.063): full-strength straw
    // hairlines read as ledger ruling inside white popovers.
    border: "#D2CDB4",
    accent: "#8B6D08",
    accentSecondary: "#467030",
    // success/danger/warning render as TEXT (diff numerals, status labels) on
    // the near-white chips — all hold ≥ 4.5:1 on canvas/panel/elevated.
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
    // Warm earth ink: the overlay/wash ladder composites onto the grass
    // field, and a cool tint there reads as grime (the Bondi r6 "stitched"
    // temperature split lived in these washes as much as in the surfaces).
    overlayTint: "#342D1F",
    terminal: {
      // Night over the savanna — deep umber, its own environment.
      background: "#2C2115",
      foreground: "#E8DDC5",
      // 3.76:1 on the terminal background (the old olive #6B7B3A read as a
      // syntax color, not a de-emphasis tier).
      muted: "#857B66",
      cursor: "#E8A81C",
      selection: "#4A3A20",
      // Every chromatic ANSI color holds ≥ 4.5:1 on the terminal background
      // (the old muted set bottomed out near 3.2:1 and fell away at dusk);
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
      materialBlur: 12,
      materialSaturation: 115,
    },
  },
  tokens: {
    "accent-muted": "rgba(139,109,8,0.30)",
    "accent-soft": "rgba(139,109,8,0.18)",
    "focus-ring": "rgba(139,109,8,0.35)",
    "overlay-hover": "rgba(52,45,31,0.08)",
    // Derived 3% is sub-threshold over near-white surfaces.
    "overlay-soft": "rgba(52,45,31,0.055)",
    // Opaque elevate-to-select for menu/palette rows on white popovers; warm
    // so a selected row reads as the same material, not a cool slab. Quieter
    // chroma than the field — straw at full chroma reads as dust on white.
    "overlay-raised": "#EDEADF",
    // GitHub-brand defaults fail AA on the near-white panel.
    "pr-merged": "#7644CC",
    "pr-draft": "#646B73",
    "scrollbar-thumb": "#7E744F",
    "scrollbar-thumb-hover": "color-mix(in oklab, #7E744F 85%, #26211A)",
    // Engine light scrims (0.22/0.36/0.55) read as a storm front here.
    "scrim-soft": "rgba(52,45,31,0.16)",
    "scrim-medium": "rgba(52,45,31,0.28)",
    "scrim-strong": "rgba(52,45,31,0.46)",
    // Acacia-leaf green is the opposing detail color (Bondi uses water blue).
    "search-highlight-background": "rgba(70,112,48,0.14)",
    "search-highlight-text": "#3E6A2A",
    "search-match-badge-background": "rgba(70,112,48,0.14)",
    "search-match-badge-text": "#3E6A2A",
    "search-selected-result-border": "rgba(70,112,48,0.34)",
    "search-selected-result-icon": "#3E6A2A",
    // Two-layer contact+spread; the engine "light" single penumbra has no
    // contact edge on a near-white field.
    "shadow-ambient": "0 1px 2px rgba(46,40,28,0.10), 0 6px 16px rgba(46,40,28,0.10)",
    // Dialogs sit a full z-tier above menus/popovers (the floating fallback
    // would give a centered modal the same shadow as a context menu).
    "shadow-dialog": "0 2px 6px rgba(46,40,28,0.10), 0 24px 60px rgba(46,40,28,0.18)",
    "shadow-floating": "0 1px 3px rgba(46,40,28,0.12), 0 12px 32px rgba(46,40,28,0.14)",
    // In-card chips: a warm straw inset one quiet step below the white card,
    // not a recessed slab — low chroma so kbd chips don't read as aged paper.
    "surface-inset": "#F2F0E5",
    // Inputs are raised on light, never recessed (overrides the engine's
    // recessed derivation; promote to the engine once the light family is
    // rebuilt from Bondi).
    "surface-input": "#FDFBF4",
    // Straw chrome: the frame (toolbar/dock/panel caps/dialog headers) carries
    // the savanna note at whisper chroma (C 0.02), one register apart from the
    // field surfaces rather than a different temperature.
    "surface-toolbar": "#F1EDDE",
    // 3.18:1 — the dim tier stays dimmest but no longer falls away (Bondi's
    // own bright-black sits at 2.3:1; this is a deliberate step past parity).
    "terminal-bright-black": "#7A6F5B",
    "terminal-white": "#E8DDC5",
    "text-link": "#6E5400",
    // 4.5:1 on the raised input (the engine 0.58 sat below 4.2 and fell away).
    "text-placeholder": "rgba(38,33,26,0.62)",
  },
  extensions: {
    "dock-bg": "#F1EDDE",
    "dock-input-bg": "#FDFBF4",
    // Registry format guard: shadow-color channels, alpha ≥ 0.25.
    "dock-shadow": "0 -2px 8px rgb(from var(--theme-shadow-color) r g b / 0.25)",
    // Panel title bars join the straw chrome; the focused pane's cap brightens.
    "panel-header-bg": "#F2EFE1",
    "panel-header-focus-bg": "#F7F5E9",
    // Emoji tiles get a white-gloss lift instead of the dark-theme black wash
    // (which rendered murky gray chips on the light field).
    "project-tile-wash":
      "linear-gradient(to bottom, rgba(255,255,255,0.40), rgba(255,255,255,0.10))",
    "project-tile-shadow": "inset 0 1px 1px rgba(46,40,28,0.10), 0 0 0 1px rgba(46,40,28,0.10)",
    "pulse-before-bg": "#E3D9AA",
    "pulse-card-bg": "#FFFFFF",
    "pulse-card-header-bg": "#FAF8ED",
    "pulse-card-shadow": "0 1px 2px rgba(46,40,28,0.10), 0 4px 10px rgba(46,40,28,0.08)",
    "pulse-control-hover-bg": "rgba(52,45,31,0.05)",
    "pulse-empty-bg": "#F6F2DB",
    "pulse-heat-high-opacity": "0.85",
    "pulse-heat-low-opacity": "0.38",
    "pulse-heat-medium-opacity": "0.62",
    "pulse-heat-color": "#467030",
    // Opaque so the streak-break signal clears the 3:1 graphical floor.
    "pulse-missed-bg": "#B13A28",
    "pulse-range-bg": "#F6F2DB",
    "pulse-ring-offset": "#FFFFFF",
    "pulse-skeleton-gradient": "linear-gradient(90deg, #E3D9AA 25%, #F6F2DB 50%, #E3D9AA 75%)",
    "dialog-header-bg": "#FBFAF1",
    "review-commit-input-bg": "#FDFBF4",
    "settings-kbd-bg": "#F2F0E5",
    "settings-kbd-border": "#D2CDB4",
    // Nav selection elevates to white + the 2px accent marker; the inherited
    // overlay-raised darker-lift is for menu rows on white popovers only.
    "settings-nav-active-bg": "#FFFFFF",
    // Flat like the dark themes: the white fill + 2px accent marker carry
    // selection, no ring or shadow.
    "settings-nav-active-shadow": "none",
    "settings-nav-hover-bg": "rgba(52,45,31,0.05)",
    // Scope pill elevates to white on the tinted settings sidebar.
    "settings-scope-bg": "#FFFFFF",
    "settings-sidebar-bg": "rgba(241,235,205,0.60)",
    "sidebar-action-hover-bg": "rgba(52,45,31,0.05)",
    // Worktree cards are paper highlights on the grass field; hover brightens
    // toward white; selected is pure white + the accent rail.
    // idle < hover < selected is audit-enforced; the steps sit ~1.4 OKLab
    // points apart — anything under ~1 point is invisible on a real display.
    // Soft contact shadow only — no ring: the card must not read as bordered
    // (Bondi round-3 owner decision; selection = bg + right accent border).
    "sidebar-card-bg": "#FAF6E6",
    "sidebar-card-shadow": "0 1px 2px rgba(46,40,28,0.05)",
    "sidebar-active-bg": "#FFFFFF",
    "sidebar-hover-bg": "#FCFBF2",
    "toolbar-agent-hover-bg": "rgba(38,33,26,0.06)",
    "toolbar-control-hover-bg": "rgba(38,33,26,0.06)",
    // Accent restraint: hover affordance is the bg, not a gold foreground.
    "toolbar-control-hover-fg": "#26211A",
    "toolbar-control-hover-shadow": "none",
    "toolbar-divider": "rgba(210,205,180,0.7)",
    "toolbar-pill-radius": "0.5rem",
    // One sunset-amber whisper on the project pill; everything else quiet ink.
    // Pills sit LIGHTER than the chrome strip (raised, like all content).
    "toolbar-project-bg":
      "linear-gradient(180deg, rgba(232,168,28,0.08), rgba(38,33,26,0.02)), #FBF9F0",
    "toolbar-project-border": "rgba(210,205,180,0.75)",
    "toolbar-project-chip-bg": "rgba(38,33,26,0.04)",
    "toolbar-project-chip-border": "rgba(210,205,180,0.75)",
    "toolbar-project-shadow": "inset 0 1px 0 rgba(255,255,255,0.5)",
    "toolbar-shadow": "0 1px 2px rgba(46,40,28,0.06)",
    "toolbar-stats-bg": "#FBF9F0",
    "toolbar-stats-border": "rgba(210,205,180,0.7)",
    "toolbar-stats-divider": "rgba(210,205,180,0.7)",
    "toolbar-stats-hover-bg": "#FCFBF2",
    // Filter rail sits flush on the field; the raised search input carries it.
    "worktree-filter-bar-bg": "#F1EBCD",
    // Active quick-state tab lifts to white under its inset underline.
    "worktree-quick-state-active-bg": "#FFFFFF",
    "worktree-search-input-bg": "#FDFBF4",
    "worktree-section-hover-bg": "rgba(52,45,31,0.05)",
  },
};
