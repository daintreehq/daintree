import type { BuiltInThemeSource } from "../builtInThemeSources.js";

export const theme: BuiltInThemeSource = {
  id: "bondi",
  name: "Bondi Beach",
  type: "light",
  builtin: true,
  location: "Bondi Beach, Sydney, Australia",
  heroImage: "/themes/bondi.webp",
  palette: {
    type: "light",
    // Shoreline composition (#9711): SAND sidebar (H~93) against WATER
    // grid/canvas/panel (H~248), white foam on top — beach on the left,
    // ocean on the right. Everything that carries content lifts TOWARD
    // white — never a darker fill on a light container.
    // Ramp L 0.916/0.937/0.957/0.979/1.0: steps 0.0205-0.0219 (gate ≥ 0.02),
    // span 0.084, panel→elevated not the smallest step (the audit gates check
    // L only, so the sidebar's sand hue rides the same ramp).
    surfaces: {
      grid: "#D9E5F0",
      sidebar: "#EDEAE0",
      canvas: "#EAF2FA",
      panel: "#F3F9FF",
      elevated: "#FFFFFF",
    },
    text: {
      primary: "#1C2028",
      secondary: "#48535F",
      muted: "#5F6A76",
      inverse: "#FDFDFE",
    },
    border: "#CBD4DD",
    accent: "#178463",
    accentSecondary: "#0A7E8C",
    // success/danger/warning render as TEXT (diff numerals, status labels) on
    // the near-white chips — all hold ≥ 4.5:1 on every surface up to #FFFFFF.
    status: {
      success: "#1C7B54",
      warning: "#9D6309",
      danger: "#A83C34",
      info: "#1E6FA0",
    },
    activity: {
      active: "#1C7B54",
      idle: "#5F6A76",
      working: "#1C7B54",
      waiting: "#97680D",
    },
    overlayTint: "#163447",
    terminal: {
      background: "#1E252E",
      foreground: "#C8D0D9",
      // 3.38:1 on the terminal background (the old #5C6670 sat at 2.64:1).
      muted: "#6B7783",
      cursor: "#F5B814",
      selection: "#2A3A4A",
      red: "#E05C5C",
      green: "#2EBD88",
      yellow: "#F5B814",
      blue: "#37A6D9",
      magenta: "#9D45F0",
      cyan: "#0FA8C0",
      brightRed: "#F87171",
      brightGreen: "#34D399",
      brightYellow: "#FCD34D",
      brightBlue: "#7DD3FC",
      brightMagenta: "#C084FC",
      brightCyan: "#67E8F9",
      brightWhite: "#E8F4FD",
    },
    syntax: {
      comment: "#59697E",
      punctuation: "#5C6875",
      number: "#895E00",
      string: "#1C7350",
      operator: "#0B7184",
      keyword: "#6A3FB0",
      function: "#1C68A8",
      link: "#10704F",
      quote: "#5A6878",
      chip: "#0A7E8C",
    },
    strategy: {
      shadowStyle: "light",
      materialBlur: 12,
      materialSaturation: 115,
    },
  },
  tokens: {
    "accent-muted": "rgba(23,132,99,0.30)",
    "accent-soft": "rgba(23,132,99,0.18)",
    "focus-ring": "rgba(23,132,99,0.35)",
    "overlay-hover": "rgba(22,52,71,0.08)",
    // Derived 3% is sub-threshold over near-white surfaces.
    "overlay-soft": "rgba(22,52,71,0.055)",
    // Hue-true elevate-to-select; the derived mix toward text-primary
    // composites to a dead neutral gray on the chroma-held surfaces.
    "overlay-raised": "#E6EEF6",
    // GitHub-brand defaults fail AA on the near-white panel.
    "pr-merged": "#7644CC",
    "pr-draft": "#646B73",
    "scrollbar-thumb": "#6A7787",
    "scrollbar-thumb-hover": "color-mix(in oklab, #6A7787 85%, #1C2028)",
    // Engine light scrims (0.22/0.36/0.55) read as a storm front here.
    "scrim-soft": "rgba(22,52,71,0.16)",
    "scrim-medium": "rgba(22,52,71,0.28)",
    "scrim-strong": "rgba(22,52,71,0.46)",
    "search-highlight-background": "rgba(35,94,150,0.14)",
    "search-highlight-text": "#235E96",
    "search-match-badge-background": "rgba(35,94,150,0.14)",
    "search-match-badge-text": "#235E96",
    "search-selected-result-border": "rgba(35,94,150,0.34)",
    "search-selected-result-icon": "#235E96",
    // Two-layer contact+spread; the engine "light" single penumbra has no
    // contact edge on a near-white field.
    "shadow-ambient": "0 1px 2px rgba(23,33,48,0.10), 0 6px 16px rgba(23,33,48,0.10)",
    // Dialogs sit a full z-tier above menus/popovers (the floating fallback
    // would give a centered modal the same shadow as a context menu).
    "shadow-dialog": "0 2px 6px rgba(23,33,48,0.10), 0 24px 60px rgba(23,33,48,0.18)",
    "shadow-floating": "0 1px 3px rgba(23,33,48,0.12), 0 12px 32px rgba(23,33,48,0.14)",
    // In-card chips: a lifted sky inset one quiet step below the white card,
    // not a recessed slab.
    "surface-inset": "#EFF5FB",
    // Inputs are raised on light, never recessed (overrides the engine's
    // recessed derivation; promote to the engine once the light family is
    // rebuilt from Bondi).
    "surface-input": "#F9FCFF",
    // Sand chrome: the frame (toolbar/dock/panel caps/dialog headers) carries
    // Bondi's warm note at whisper chroma (H~95); sky stays in the field and
    // content. Same L as the prior neutral, so contrast is unchanged.
    "surface-toolbar": "#EFEEE9",
    "terminal-bright-black": "#525D69",
    "terminal-white": "#C8D0D9",
    "text-link": "#0F5B41",
    // 3.1:1 on the raised input.
    "text-placeholder": "rgba(28,32,40,0.52)",
  },
  extensions: {
    "dock-bg": "#EFEEE9",
    "dock-input-bg": "#FCFBF7",
    // Registry format guard: shadow-color channels, alpha ≥ 0.25.
    "dock-shadow": "0 -2px 8px rgb(from var(--theme-shadow-color) r g b / 0.25)",
    // Panel title bars join the sand chrome; the focused pane's cap brightens.
    "panel-header-bg": "#F1F0EC",
    "panel-header-focus-bg": "#F7F6F2",
    "panel-grid-bg": "#D9E5F0",
    // Emoji tiles get a white-gloss lift instead of the dark-theme black wash
    // (which rendered murky gray chips on the light field).
    "project-tile-wash":
      "linear-gradient(to bottom, rgba(255,255,255,0.40), rgba(255,255,255,0.10))",
    "project-tile-shadow": "inset 0 1px 1px rgba(23,33,48,0.10), 0 0 0 1px rgba(28,38,50,0.10)",
    "pulse-before-bg": "#D9E5F0",
    "pulse-card-bg": "#FFFFFF",
    "pulse-card-header-bg": "#F7FBFF",
    "pulse-card-shadow": "0 1px 2px rgba(23,33,48,0.10), 0 4px 10px rgba(23,33,48,0.08)",
    "pulse-control-hover-bg": "rgba(22,52,71,0.05)",
    "pulse-empty-bg": "#EAF2FA",
    "pulse-heat-high-opacity": "0.85",
    "pulse-heat-low-opacity": "0.38",
    "pulse-heat-medium-opacity": "0.62",
    "pulse-heat-color": "#0A7E8C",
    // Opaque so the streak-break signal clears the 3:1 graphical floor.
    "pulse-missed-bg": "#A83C34",
    "pulse-range-bg": "#EAF2FA",
    "pulse-ring-offset": "#FFFFFF",
    "pulse-skeleton-gradient": "linear-gradient(90deg, #D9E5F0 25%, #EAF2FA 50%, #D9E5F0 75%)",
    "dialog-header-bg": "#FAF9F5",
    "review-commit-input-bg": "#F9FCFF",
    "settings-kbd-bg": "#EAF2FA",
    "settings-kbd-border": "#CBD4DD",
    // Nav selection elevates to white + the 2px accent marker; the inherited
    // overlay-raised darker-lift is for menu rows on white popovers only.
    "settings-nav-active-bg": "#FFFFFF",
    // Flat like the dark themes: the white fill + 2px accent marker carry
    // selection, no ring or shadow.
    "settings-nav-active-shadow": "none",
    "settings-nav-hover-bg": "rgba(22,52,71,0.05)",
    // Scope pill elevates to white on the tinted settings sidebar.
    "settings-scope-bg": "#FFFFFF",
    "settings-sidebar-bg": "rgba(243,249,255,0.60)",
    "sidebar-action-hover-bg": "rgba(58,48,30,0.05)",
    // Worktree cards are paper highlights on the sand field; hover brightens
    // toward white; selected is pure white + the accent rail.
    // idle < hover < selected is audit-enforced.
    "sidebar-card-bg": "#FCFBF7",
    "sidebar-card-shadow": "0 0 0 1px rgba(54,46,32,0.08), 0 1px 2px rgba(48,40,28,0.05)",
    "sidebar-active-bg": "#FFFFFF",
    "sidebar-hover-bg": "#FEFDFB",
    "toolbar-agent-hover-bg": "rgba(28,32,40,0.06)",
    "toolbar-control-hover-bg": "rgba(28,32,40,0.06)",
    // Accent restraint: hover affordance is the bg, not a green foreground.
    "toolbar-control-hover-fg": "#1C2028",
    "toolbar-control-hover-shadow": "none",
    "toolbar-divider": "rgba(211,208,199,0.7)",
    "toolbar-pill-radius": "0.5rem",
    // One lifeguard-gold whisper on the project pill; everything else quiet ink.
    // Pills sit LIGHTER than the chrome strip (raised, like all content).
    "toolbar-project-bg":
      "linear-gradient(180deg, rgba(245,184,20,0.07), rgba(28,32,40,0.02)), #F9F8F4",
    "toolbar-project-border": "rgba(211,208,199,0.75)",
    "toolbar-project-chip-bg": "rgba(28,32,40,0.04)",
    "toolbar-project-chip-border": "rgba(211,208,199,0.75)",
    "toolbar-project-shadow": "inset 0 1px 0 rgba(255,255,255,0.5)",
    "toolbar-shadow": "0 1px 2px rgba(23,33,48,0.06)",
    "toolbar-stats-bg": "#F9F8F4",
    "toolbar-stats-border": "rgba(211,208,199,0.7)",
    "toolbar-stats-divider": "rgba(211,208,199,0.7)",
    "toolbar-stats-hover-bg": "#FCFBF7",
    // Filter rail sits flush on the field; the raised search input carries it.
    "worktree-filter-bar-bg": "#EDEAE0",
    // Active quick-state tab lifts to white under its inset underline.
    "worktree-quick-state-active-bg": "#FFFFFF",
    "worktree-search-input-bg": "#FCFBF7",
    "worktree-section-hover-bg": "rgba(58,48,30,0.05)",
  },
};
