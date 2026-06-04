import type { BuiltInThemeSource } from "../builtInThemeSources.js";

export const theme: BuiltInThemeSource = {
  id: "bali",
  name: "Bali",
  type: "light",
  builtin: true,
  location: "Bali, Indonesia",
  heroImage: "/themes/bali.webp",
  palette: {
    type: "light",
    // Rice-terrace composition (#9710, Bondi-standard rebuild): ONE sunlit
    // paddy-green family for the whole field (H~116-122) with white frangipani
    // content on top. Gold appears only as detail — canang-sari search
    // highlights, the cursor, warning/waiting status, one whisper on the
    // project pill — never as a field surface. Everything that carries content
    // lifts TOWARD white — never a darker fill on a light container.
    // Ramp L 0.883/0.936/0.958/0.978/1.0: steps 0.0206-0.0526 (gate ≥ 0.02,
    // runaway ratio 2.55 < 3), span 0.117, panel→elevated not the smallest
    // step. The grid is the FLOODED PADDY — a full register deeper and richer
    // than the dry-terrace sidebar, so chrome/field/well read as three planes
    // and white panels get real figure-ground pop.
    surfaces: {
      grid: "#D3DEBC",
      sidebar: "#E7EDD8",
      canvas: "#F0F3E4",
      panel: "#F7F9F1",
      elevated: "#FFFFFF",
    },
    text: {
      primary: "#20241E",
      // Near-neutral ink with a whisper of leaf — heavily-hued green text on
      // the green field read dirty: secondary 6.0:1 on the grid, muted 4.8:1
      // on the grid and 6.0:1 on canvas.
      secondary: "#4B4E47",
      muted: "#575D54",
      inverse: "#FDFEFB",
    },
    border: "#CBD0C1",
    accent: "#218546",
    accentSecondary: "#3A7A4E",
    // success/danger/warning render as TEXT (diff numerals, status labels) on
    // the near-white chips — all hold ≥ 4.5:1 on every surface up to #FFFFFF.
    status: {
      success: "#208042",
      warning: "#946400",
      danger: "#C0453A",
      info: "#2C7884",
    },
    activity: {
      active: "#208042",
      idle: "#62786A",
      working: "#208042",
      waiting: "#8A6A0C",
    },
    // Field ink, not jungle-black: the overlay/wash ladder composites onto the
    // paddy field, and an off-temperature tint there reads as grime even when
    // every surface hex is right.
    overlayTint: "#31342B",
    terminal: {
      background: "#1A2620",
      foreground: "#CDD6CD",
      // 3.82:1 on the terminal background (the old #5C8A65 leaned chroma over
      // luminance and fell away in muted output).
      muted: "#6F8276",
      cursor: "#E0B341",
      selection: "#2C4136",
      red: "#E06A5E",
      green: "#43BD7F",
      yellow: "#D9A832",
      blue: "#46A8D9",
      magenta: "#B47FE8",
      cyan: "#2EB5A0",
      brightRed: "#F0907F",
      brightGreen: "#63D89C",
      brightYellow: "#F2C45C",
      brightBlue: "#7CC8EC",
      brightMagenta: "#CDA3F2",
      brightCyan: "#5FD9C2",
      brightWhite: "#EDF5EC",
    },
    syntax: {
      comment: "#586D5C",
      punctuation: "#54675A",
      number: "#7E5D08",
      string: "#1E7048",
      operator: "#0F7263",
      keyword: "#7A3FA8",
      function: "#1D67A8",
      link: "#106B3C",
      quote: "#56695C",
      chip: "#3A7A4E",
    },
    strategy: {
      shadowStyle: "light",
      materialBlur: 10,
      materialSaturation: 118,
    },
  },
  tokens: {
    "accent-muted": "rgba(33,133,70,0.30)",
    "accent-soft": "rgba(33,133,70,0.18)",
    "focus-ring": "rgba(33,133,70,0.35)",
    "overlay-hover": "rgba(49,52,43,0.08)",
    // Derived 3% is sub-threshold over near-white surfaces.
    "overlay-soft": "rgba(49,52,43,0.055)",
    // Opaque elevate-to-select for menu/palette rows on white popovers; field
    // green so a selected row reads as the same material, not a gray slab.
    // One register lighter than Bondi's depth: a hued fill at L 0.934 reads
    // recessed on a pure-white popover where Bondi's neutral sand doesn't.
    "overlay-raised": "#EBEEE3",
    // Engine pr-* defaults clear AA here; pr-draft alone is re-inked to the
    // field temperature (the engine slate reads cool against the green field).
    "pr-draft": "#62695F",
    "scrollbar-thumb": "#727D6E",
    "scrollbar-thumb-hover": "color-mix(in oklab, #727D6E 85%, #20241E)",
    // Engine light scrims (0.22/0.36/0.55) read as a storm front here.
    "scrim-soft": "rgba(49,52,43,0.16)",
    "scrim-medium": "rgba(49,52,43,0.28)",
    "scrim-strong": "rgba(49,52,43,0.46)",
    // Search is canang-sari gold — the detail temperature, kept off the green
    // accent so a match never reads as selection.
    "search-highlight-background": "rgba(176,128,16,0.16)",
    "search-highlight-text": "#7A5800",
    "search-match-badge-background": "rgba(176,128,16,0.16)",
    "search-match-badge-text": "#7A5800",
    "search-selected-result-border": "rgba(122,88,0,0.34)",
    "search-selected-result-icon": "#7A5800",
    // Two-layer contact+spread; the engine "light" single penumbra has no
    // contact edge on a near-white field.
    "shadow-ambient": "0 1px 2px rgba(44,47,38,0.10), 0 6px 16px rgba(44,47,38,0.10)",
    // Dialogs sit a full z-tier above menus/popovers (the floating fallback
    // would give a centered modal the same shadow as a context menu).
    "shadow-dialog": "0 2px 6px rgba(44,47,38,0.10), 0 24px 60px rgba(44,47,38,0.18)",
    "shadow-floating": "0 1px 3px rgba(44,47,38,0.12), 0 12px 32px rgba(44,47,38,0.14)",
    // In-card chips: a pale terrace inset one quiet step below the white card,
    // not a recessed slab.
    "surface-inset": "#EEF2E6",
    // Inputs are raised on light, never recessed (overrides the engine's
    // recessed derivation; promote to the engine once the light family is
    // rebuilt from Bondi).
    "surface-input": "#FAFCF6",
    // Stone chrome: the frame (toolbar/dock/panel caps/dialog headers) carries
    // Bali's volcanic-stone note at whisper chroma (H~122), one register apart
    // from the field surfaces rather than a different temperature.
    "surface-toolbar": "#ECEFE6",
    "terminal-bright-black": "#5A6B5E",
    "terminal-white": "#CDD6CD",
    "text-link": "#0E6434",
    // 4.5:1 on the raised input (the derived 0.58 sat at ~4.1 and fell away).
    "text-placeholder": "rgba(32,36,30,0.62)",
  },
  extensions: {
    "dock-bg": "#ECEFE6",
    "dock-input-bg": "#FAFCF6",
    // Registry format guard: shadow-color channels, alpha ≥ 0.25.
    "dock-shadow": "0 -2px 8px rgb(from var(--theme-shadow-color) r g b / 0.25)",
    // Panel title bars join the stone chrome; the focused pane's cap brightens.
    "panel-header-bg": "#EEF1E8",
    "panel-header-focus-bg": "#F4F7EE",
    // Emoji tiles get a white-gloss lift instead of the dark-theme black wash
    // (which rendered murky gray chips on the light field).
    "project-tile-wash":
      "linear-gradient(to bottom, rgba(255,255,255,0.40), rgba(255,255,255,0.10))",
    "project-tile-shadow": "inset 0 1px 1px rgba(44,47,38,0.10), 0 0 0 1px rgba(45,48,38,0.10)",
    "pulse-before-bg": "#D3DEBC",
    "pulse-card-bg": "#FFFFFF",
    "pulse-card-header-bg": "#F7FAF0",
    "pulse-card-shadow": "0 1px 2px rgba(44,47,38,0.10), 0 4px 10px rgba(44,47,38,0.08)",
    "pulse-control-hover-bg": "rgba(49,52,43,0.05)",
    "pulse-empty-bg": "#F0F3E4",
    "pulse-heat-high-opacity": "0.85",
    "pulse-heat-low-opacity": "0.38",
    "pulse-heat-medium-opacity": "0.62",
    "pulse-heat-color": "#3A7A4E",
    // Opaque so the streak-break signal clears the 3:1 graphical floor.
    "pulse-missed-bg": "#C0453A",
    "pulse-range-bg": "#F0F3E4",
    "pulse-ring-offset": "#FFFFFF",
    "pulse-skeleton-gradient": "linear-gradient(90deg, #D3DEBC 25%, #F0F3E4 50%, #D3DEBC 75%)",
    "dialog-header-bg": "#F8FAF2",
    "review-commit-input-bg": "#FAFCF6",
    "settings-kbd-bg": "#EEF2E6",
    "settings-kbd-border": "#CBD0C1",
    // Nav selection elevates to white + the 2px accent marker; the inherited
    // overlay-raised darker-lift is for menu rows on white popovers only.
    "settings-nav-active-bg": "#FFFFFF",
    // Flat like the dark themes: the white fill + 2px accent marker carry
    // selection, no ring or shadow.
    "settings-nav-active-shadow": "none",
    "settings-nav-hover-bg": "rgba(46,58,36,0.05)",
    // Scope pill elevates to white on the tinted settings sidebar.
    "settings-scope-bg": "#FFFFFF",
    "settings-sidebar-bg": "rgba(231,237,216,0.60)",
    "sidebar-action-hover-bg": "rgba(46,58,36,0.05)",
    // Worktree cards are paper highlights on the terrace field; hover brightens
    // toward white; selected is pure white + the accent rail.
    // idle < hover < selected is audit-enforced; the old ladder darkened to
    // select, which reads as grime on a near-white field — these sit ~1.5
    // OKLab points apart.
    // Soft contact shadow only — no ring: the card must not read as bordered
    // (#9711 round-3 owner decision; selection = bg + right accent border).
    "sidebar-card-bg": "#F2F6EA",
    "sidebar-card-shadow": "0 1px 2px rgba(40,48,30,0.05)",
    "sidebar-active-bg": "#FFFFFF",
    "sidebar-hover-bg": "#F8FAF4",
    "toolbar-agent-hover-bg": "rgba(32,36,30,0.06)",
    "toolbar-control-hover-bg": "rgba(32,36,30,0.06)",
    // Accent restraint: hover affordance is the bg, not a green foreground.
    "toolbar-control-hover-fg": "#20241E",
    "toolbar-control-hover-shadow": "none",
    "toolbar-divider": "rgba(203,208,193,0.7)",
    "toolbar-pill-radius": "0.5rem",
    // One canang-gold whisper on the project pill; everything else quiet ink.
    // Pills sit LIGHTER than the chrome strip (raised, like all content).
    "toolbar-project-bg":
      "linear-gradient(180deg, rgba(224,179,65,0.08), rgba(32,36,30,0.02)), #F6F9F0",
    "toolbar-project-border": "rgba(203,208,193,0.75)",
    "toolbar-project-chip-bg": "rgba(32,36,30,0.04)",
    "toolbar-project-chip-border": "rgba(203,208,193,0.75)",
    "toolbar-project-shadow": "inset 0 1px 0 rgba(255,255,255,0.5)",
    "toolbar-shadow": "0 1px 2px rgba(44,47,38,0.06)",
    "toolbar-stats-bg": "#F6F9F0",
    "toolbar-stats-border": "rgba(203,208,193,0.7)",
    "toolbar-stats-divider": "rgba(203,208,193,0.7)",
    "toolbar-stats-hover-bg": "#F8FAF4",
    // Filter rail sits flush on the field; the raised search input carries it.
    "worktree-filter-bar-bg": "#E7EDD8",
    // Active quick-state tab lifts to white under its inset underline.
    "worktree-quick-state-active-bg": "#FFFFFF",
    "worktree-search-input-bg": "#FAFCF6",
    "worktree-section-hover-bg": "rgba(46,58,36,0.05)",
  },
};
