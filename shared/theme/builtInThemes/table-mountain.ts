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
    // Surface ramp (OKLCH L): the workbench chrome — the panel gutter (grid) and
    // the left rail (sidebar) — is pulled deeper than before so the rail reads
    // as a distinct structural band instead of merging into the canvas, and
    // panels lift clearly off the gutter. `canvas` stays airy, and `elevated`
    // keeps the strongest single jump so popovers/dialogs float. Warmth (chroma)
    // is held across the whole ramp — the brightest tiers stay warm paper rather
    // than collapsing to bleached white, which is what made the old light theme
    // read as flat and cold up top.
    surfaces: {
      grid: "#D4C9B8", // L 0.840  gutter / structural base
      sidebar: "#DED4C4", // L 0.874  left rail + toolbar
      canvas: "#EBE4D9", // L 0.921  content canvas
      panel: "#F1EBE0", // L 0.942  cards / dialogs
      elevated: "#FBF6EC", // L 0.974  tooltips / popovers — kept warm (C 0.014), not bleached white
    },
    text: {
      primary: "#2C2622",
      secondary: "#574E47",
      // Darkened a step (was #6F665C) to clear 3.5:1 on the deeper grid.
      muted: "#6A6157",
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
      // The engine's default border ink is a cool blue-black (#0f141b). On this
      // warm-sand workbench that composited to a muddy grey hairline — the main
      // reason the sidebar's border-driven structure read as dirty/depressing.
      // Swap to a warm espresso so every derived separator (border-subtle/strong/
      // divider) sits on-temperature with the surfaces: present and crisp, not grey.
      borderInkOverride: "#2A211A",
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
    // The engine's light overlay-subtle (0.02 ink) is invisible on a near-white
    // workbench, so membership/active-segment fills (e.g. the worktree quick-state
    // filter bar's active tab) read as unstyled. Raise to a perceptible warm wash.
    "overlay-subtle": "rgba(60,48,38,0.07)",
    // The engine derives overlay-raised as mix(elevated 92%, text-primary); with
    // the warmer elevated (L 0.974) that lands at ~L 0.918 — BELOW canvas/panel,
    // inverting the elevate-to-select contract. Pin an opaque warm lift instead:
    // L 0.966, above panel (0.942), just under elevated.
    "overlay-raised": "#F8F3EA",
    // surface-disabled falls back to mix(panel 70%, canvas) ≈ L 0.936 — nearly
    // panel-level, so disabled fields read raised. Pin it to the input-well
    // neighborhood instead (L 0.903, just below canvas).
    "surface-disabled": "#E5DED3",
    // With the espresso border ink, the derived divider composites ~1.176:1 on
    // elevated — a hair under the documented 1.18 separator floor. Nudge it over.
    "border-divider": "rgba(42,33,26,0.09)",
    // The engine's "light" shadow profile is slate-tinted — the one remaining
    // cool cast on this warm workbench. Re-tint the elevation ladder in the
    // theme's own espresso ink (two-layer contact+spread, sibling convention).
    "shadow-ambient": "0 1px 2px rgba(60,48,38,0.10), 0 4px 12px rgba(60,48,38,0.10)",
    "shadow-floating": "0 2px 6px rgba(60,48,38,0.12), 0 14px 36px rgba(60,48,38,0.16)",
    "shadow-dialog": "0 4px 10px rgba(60,48,38,0.13), 0 26px 60px rgba(60,48,38,0.18)",
    // scrollbar-thumb must clear 3:1 vs panel & canvas (E6): #9B8E7E was 2.75/2.54.
    "scrollbar-thumb": "#7E7363",
    "scrollbar-thumb-hover": "color-mix(in oklab, #7E7363 80%, #2C2622)",
    "search-highlight-background": "rgba(58,111,144,0.18)",
    "search-highlight-text": "#2F5A77",
    "search-match-badge-background": "rgba(58,111,144,0.14)",
    "search-match-badge-text": "#2F5A77",
    "search-selected-result-border": "rgba(58,111,144,0.40)",
    "search-selected-result-icon": "#2F5A77",
    // E8: drop the raised surface-input override so it inherits the engine's
    // RECESSED default mix(canvas 96%, text) — the inset-well idiom.
    // filter-selected (membership, never accent): elevate on light, don't darken.
    // soft lifts above the rail (L 0.918, clear of surface-panel), strong toward
    // elevated (L 0.963).
    "filter-selected-bg-soft": "#EAE3D6",
    "filter-selected-bg-strong": "#F7F2E9",
    // Inset well + toolbar surface, re-pinned to the deeper ramp: both sit
    // between the rail (sidebar L 0.874) and the canvas (L 0.921).
    "surface-inset": "#E5DDD1",
    "surface-toolbar": "#E5DDD0",
    "terminal-black": "#261F1B",
    "terminal-bright-black": "#968C84",
    "terminal-white": "#E0D8D0",
    "text-placeholder": "#827869",
  },
  extensions: {
    // G1: the gutter must recede BELOW the panel tiles it frames. Pinned to
    // surface-grid (L 0.840, well below panel L 0.942) so panels read as raised
    // figures, not wells.
    "panel-grid-bg": "#D4C9B8",
    "settings-dialog-bg": "#F1EBE0",
    "settings-card-bg": "#FBF6EC",
    "settings-list-item-bg": "#FBF6EC",
    "pulse-card-bg": "#FBF6EC",
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
    "pulse-ring-offset": "#FBF6EC",
    "pulse-skeleton-gradient": "linear-gradient(90deg, #D4C9B8 25%, #DFD6C7 50%, #D4C9B8 75%)",
    "dialog-header-bg": "rgba(212,201,184,0.55)",
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
    "settings-sidebar-bg": "rgba(212,201,184,0.55)",
    "sidebar-action-hover-bg": "rgba(60,48,38,0.08)",
    // Issue 1: selection LIFTS on light — the row elevates toward an opaque
    // brighter surface, it does not darken. Against the now-deeper rail (sidebar
    // L 0.874) the lift reads even more clearly: idle 0.874 < hover (#EAE3D9
    // L 0.919, +0.045) < selected (#F0EAE0 L 0.939, +0.065), each step clearing
    // the JND. sidebar.css supplies the border-strong containment edge.
    "sidebar-active-bg": "#F0EAE0",
    "sidebar-hover-bg": "#EAE3D9",
    "toolbar-agent-hover-bg": "rgba(60,48,38,0.08)",
    "toolbar-control-hover-bg": "rgba(60,48,38,0.08)",
    "toolbar-control-hover-fg": "#A03A64",
    "toolbar-divider": "rgba(194,185,172,0.6)",
    "toolbar-project-bg":
      "linear-gradient(180deg, rgba(176,70,111,0.05), rgba(60,48,38,0.06)), linear-gradient(135deg, #E2D9CA, #D6CCBB)",
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
