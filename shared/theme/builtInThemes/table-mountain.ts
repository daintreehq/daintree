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
    surfaces: {
      grid: "#DBD2C4",
      sidebar: "#E3DBCF",
      canvas: "#EBE4DA",
      panel: "#F2EDE5",
      elevated: "#FCFAF6",
    },
    text: {
      primary: "#2C2622",
      secondary: "#574E47",
      muted: "#6F665C",
      inverse: "#FCFAF6",
    },
    border: "#C2B9AC",
    accent: "#B0466F",
    accentSecondary: "#3C7A4C",
    status: {
      success: "#357E4A",
      warning: "#9C6210",
      danger: "#BC4339",
      info: "#3A6F90",
    },
    activity: {
      active: "#1E8A42",
      idle: "#857B6F",
      working: "#1E8A42",
      waiting: "#9C6E0C",
    },
    overlayTint: "#3C3026",
    terminal: {
      background: "#261F1B",
      foreground: "#E0D8D0",
      cursor: "#CFA848",
      selection: "rgba(176,70,111,0.30)",
      red: "#D87878",
      green: "#7DA88A",
      yellow: "#CFA848",
      blue: "#7ab3c8",
      magenta: "#B888B8",
      cyan: "#5bbdbd",
      brightRed: "#E49898",
      brightGreen: "#9dc9a6",
      brightYellow: "#E0C060",
      brightBlue: "#9dcde0",
      brightMagenta: "#CCA4C4",
      brightCyan: "#7dd4d4",
      brightWhite: "#fdfbf8",
    },
    syntax: {
      comment: "#6B7A6B",
      punctuation: "#525B67",
      number: "#855615",
      string: "#2C7234",
      operator: "#1C6D78",
      keyword: "#853AA2",
      function: "#2C5DAD",
      link: "#1C6D78",
      quote: "#5A6854",
      chip: "#7ecfca",
    },
    strategy: {
      shadowStyle: "light",
      materialBlur: 12,
      materialSaturation: 120,
    },
  },
  tokens: {
    "accent-soft": "rgba(176,70,111,0.18)",
    "accent-muted": "rgba(176,70,111,0.30)",
    "accent-secondary-soft": "rgba(60,122,76,0.18)",
    "accent-secondary-muted": "rgba(60,122,76,0.30)",
    "focus-ring": "rgba(176,70,111,0.45)",
    "text-link": "#A03A64",
    "overlay-hover": "rgba(60,48,38,0.08)",
    // scrollbar-thumb must clear 3:1 vs panel & canvas (E6): #9B8E7E was 2.75/2.54.
    "scrollbar-thumb": "#7E7363",
    "scrollbar-thumb-hover": "color-mix(in oklab, #7E7363 80%, #2C2622)",
    "search-highlight-background": "rgba(58,111,144,0.18)",
    "search-highlight-text": "#2F5A77",
    "search-match-badge-background": "rgba(58,111,144,0.14)",
    "search-match-badge-text": "#2F5A77",
    "search-selected-result-border": "rgba(58,111,144,0.40)",
    "search-selected-result-icon": "#2F5A77",
    // E8: drop the raised surface-input override (was #F6F1EA, brighter than
    // canvas) so it inherits the engine's RECESSED default mix(canvas 96%, text)
    // ≈ #E2DBD2 (L 0.894, just below canvas L 0.922) — the inset-well idiom.
    // filter-selected (membership, never accent): elevate on light, don't darken.
    // soft sits at ~panel level, strong toward elevated; both opaque lifts.
    "filter-selected-bg-soft": "#EDE6DA",
    "filter-selected-bg-strong": "#F7F2EA",
    "surface-inset": "#E2DACE",
    "surface-toolbar": "#E6DED2",
    "terminal-black": "#261F1B",
    "terminal-bright-black": "#968C84",
    "terminal-white": "#E0D8D0",
    "text-placeholder": "#827869",
  },
  extensions: {
    // G1: the gutter must recede BELOW the panel tiles it frames. Pull
    // panel-grid-bg down to surface-grid (L 0.867, well below panel L 0.948) so
    // panels read as raised figures, not wells. Was #ECE6DC (L 0.927, barely below
    // panel — gutter and tiles nearly merged).
    "panel-grid-bg": "#DBD2C4",
    "settings-dialog-bg": "#F2EDE5",
    "settings-card-bg": "#FCFAF6",
    "settings-list-item-bg": "#FCFAF6",
    "pulse-card-bg": "#FCFAF6",
    "pulse-card-shadow": "0 1px 3px rgba(60,48,38,0.12)",
    "pulse-control-hover-bg": "rgba(60,48,38,0.05)",
    "pulse-empty-bg": "#EDE7DD",
    // P-Heat: the legacy single-hue alpha ramp lifts this base color at 4 alphas.
    // The old #C49A6C is so light the top stop only reached ~2.1:1 vs empty.
    // Re-author to the saturated activity-working green (L 0.558, C 0.143) so the
    // high-opacity stops clear contrast. Opaque per-theme pulse-heat-1..4 stops
    // (GitHub light L+C ramp) are blocked on the registry owner registering those
    // EXTENSION_KEYs; flagged for that owner.
    "pulse-heat-color": "#1E8A42",
    "pulse-heat-high-opacity": "0.92",
    "pulse-heat-low-opacity": "0.38",
    "pulse-heat-medium-opacity": "0.62",
    // P-Heat missed-day: opaque brighter danger (4.27:1 vs empty), not a ~10% film
    // (was 1.17:1, invisible). The component pairs it with a light-only inset
    // danger ring as a redundant shape cue. Kept destructive-tier (status-danger).
    "pulse-missed-bg": "#BC4339",
    "pulse-range-bg": "#EAE3D9",
    "pulse-ring-offset": "#FCFAF6",
    "pulse-skeleton-gradient": "linear-gradient(90deg, #DBD2C4 25%, #E6DFD4 50%, #DBD2C4 75%)",
    "dialog-header-bg": "rgba(219,210,196,0.55)",
    "settings-kbd-bg": "#ECE6DC",
    // S1: the single load-bearing accent in the settings region is the 2px nav
    // marker (SettingsDialog.tsx). The nav-active FILL must be NEUTRAL + elevated
    // (a lift, not an accent-tinted darken). Was rgba(accent,0.20). #F0EAE2 is a
    // neutral warm lift above the recessed settings sidebar. The accent inset ring
    // (settings-nav-active-shadow) is retired — its CSS consumer was removed; the
    // EXTENSION_KEY retirement is the registry owner's job (flagged).
    "settings-nav-active-bg": "#F0EAE2",
    "settings-nav-hover-bg": "rgba(60,48,38,0.06)",
    "settings-search-bg": "#ECE6DC",
    "settings-sidebar-bg": "rgba(219,210,196,0.55)",
    "sidebar-action-hover-bg": "rgba(60,48,38,0.08)",
    // Issue 1: selection LIFTS on light — the row elevates toward an opaque
    // brighter surface, it does not darken. Was rgba(0,0,0,0.06) (a -0.04 dL sink
    // below its own sidebar container). idle (sidebar L 0.894) < hover (#EAE3D9
    // L 0.919, +0.024) < selected (#F0EAE0 L 0.939, +0.045), each step clearing
    // the JND. sidebar.css supplies the border-strong containment edge.
    // NOTE: blocks on the registry owner relaxing SIDEBAR_ACTIVE/SIDEBAR_HOVER
    // perceptibility (currently still enforces the old rgba(0,0,0,*) darken tint),
    // mirroring the TOOLBAR_ARMED rewrite — flagged.
    "sidebar-active-bg": "#F0EAE0",
    "sidebar-hover-bg": "#EAE3D9",
    "toolbar-agent-hover-bg": "rgba(60,48,38,0.08)",
    "toolbar-control-hover-bg": "rgba(60,48,38,0.08)",
    "toolbar-control-hover-fg": "#A03A64",
    "toolbar-divider": "rgba(194,185,172,0.6)",
    "toolbar-project-bg":
      "linear-gradient(180deg, rgba(176,70,111,0.05), rgba(60,48,38,0.06)), linear-gradient(135deg, #E6DFD4, #DCD3C5)",
    "toolbar-project-border": "rgba(194,185,172,0.7)",
    "toolbar-project-chip-bg": "rgba(60,48,38,0.05)",
    "toolbar-project-chip-border": "rgba(194,185,172,0.7)",
    "toolbar-project-shadow": "inset 0 1px 0 rgba(60,48,38,0.07)",
    "toolbar-stats-bg": "rgba(60,48,38,0.05)",
    "toolbar-stats-border": "rgba(194,185,172,0.6)",
    "toolbar-stats-divider": "rgba(194,185,172,0.6)",
    "toolbar-stats-hover-bg": "rgba(60,48,38,0.08)",
    "worktree-section-hover-bg": "rgba(60,48,38,0.06)",
  },
};
