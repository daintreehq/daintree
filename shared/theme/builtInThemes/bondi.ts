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
    // Lightness rebalance: the ramp was lifted into a lighter, airier band
    // (grid L 0.873 -> 0.916, canvas 0.925 -> 0.958, elevated -> 0.999) so the
    // theme reads as genuinely light and the empty panel grid no longer looks
    // gray. Hue/chroma preserved (cool Bondi blue); only L moved. Steps stay
    // ~0.02 and depth is carried by the shadow/border/overlay budget.
    surfaces: {
      grid: "#DDE4EC",
      sidebar: "#E4EBF1",
      canvas: "#ECF2F7",
      panel: "#F4F8FB",
      elevated: "#FEFFFF",
    },
    text: {
      primary: "#1C2028",
      secondary: "#48535F",
      muted: "#5F6A76",
      inverse: "#FDFDFE",
    },
    border: "#D3DAE2",
    accent: "#178463",
    accentSecondary: "#0A7E8C",
    status: {
      success: "#2A8649",
      warning: "#A86A0C",
      danger: "#C2433A",
      info: "#1E6FA0",
    },
    activity: {
      active: "#2A8649",
      idle: "#5F6A76",
      working: "#2A8649",
      waiting: "#A0700E",
    },
    overlayTint: "#163447",
    terminal: {
      background: "#1E252E",
      foreground: "#C8D0D9",
      muted: "#5C6670",
      cursor: "#F5B814",
      selection: "#2A3A4A",
      red: "#E05C5C",
      green: "#2EBD88",
      yellow: "#F5B814",
      blue: "#4D9FD6",
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
      keyword: "#7536C8",
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
    // E7: drop the pure-black scrim overrides so the lowered, hued engine defaults
    // apply on light (withAlpha(overlayBase #163447, 0.22/0.36/0.55)) — a near-black
    // 0.50 slab over a near-white workbench read as a heavy flat wash.
    // pr-merged/pr-draft: GitHub-brand defaults fail AA on bondi's near-white panel
    // (#8250DF 4.48:1, #8B949E 2.73:1). Darken in L only (hue preserved) so both
    // clear AA on surface-panel AND surface-panel-elevated. E6.
    "pr-merged": "#7644CC",
    "pr-draft": "#646B73",
    // scrollbar-thumb (RC-6/E6): same slate hue, low enough L to clear the 3:1
    // graphical floor against the lifted surfaces.
    "scrollbar-thumb": "#6F757E",
    "scrollbar-thumb-hover": "color-mix(in oklab, #6F757E 85%, #1C2028)",
    "search-highlight-background": "rgba(35,94,150,0.14)",
    "search-highlight-text": "#235E96",
    "search-match-badge-background": "rgba(35,94,150,0.14)",
    "search-match-badge-text": "#235E96",
    "search-selected-result-border": "rgba(35,94,150,0.34)",
    "search-selected-result-icon": "#235E96",
    // E8: surface-input is derived RECESSED by the engine (just below canvas);
    // surface-inset tracks the grid floor.
    "surface-inset": "#DDE4EC",
    "surface-toolbar": "#E4EBF1",
    "terminal-bright-black": "#525D69",
    "terminal-white": "#C8D0D9",
    "text-link": "#0F5B41",
    "text-placeholder": "rgba(28,32,40,0.55)",
  },
  extensions: {
    "dock-bg": "#E4EBF1",
    // G1: keep the gutter at/just-below surface-grid (#DDE4EC) so it recedes and
    // the panel tiles read as figure (no figure-ground inversion).
    "panel-grid-bg": "#DBE2EA",
    "pulse-before-bg": "#DDE4EC",
    "pulse-card-bg": "#FEFFFF",
    "pulse-card-shadow": "0 1px 3px rgba(23,33,48,0.10)",
    "pulse-control-hover-bg": "rgba(22,52,71,0.05)",
    "pulse-empty-bg": "#ECF2F7",
    "pulse-heat-high-opacity": "0.85",
    "pulse-heat-low-opacity": "0.38",
    "pulse-heat-medium-opacity": "0.62",
    "pulse-heat-color": "#0A7E8C",
    // P-Heat: opaque status-danger so the streak-break signal clears the 3:1
    // floor vs the empty cell and stays destructive-tier (consumer adds an inset
    // danger ring).
    "pulse-missed-bg": "#C2433A",
    "pulse-range-bg": "#ECF2F7",
    "pulse-ring-offset": "#FEFFFF",
    "pulse-skeleton-gradient": "linear-gradient(90deg, #DDE4EC 25%, #ECF2F7 50%, #DDE4EC 75%)",
    // S1: settings card/list/dialog/nav-active overrides dropped so the engine +
    // CSS defaults apply — dialog body inherits surface-panel, cards/list inherit
    // surface-panel-elevated (a clean lift above the body), and nav-active
    // inherits overlay-raised (the neutral elevate-to-select lift). The 2px accent
    // marker in SettingsDialog.tsx is the single accent anchor.
    "dialog-header-bg": "rgba(244,248,251,0.70)",
    "settings-kbd-bg": "#ECF2F7",
    "settings-kbd-border": "#D3DAE2",
    "settings-nav-hover-bg": "rgba(22,52,71,0.05)",
    "settings-search-bg": "#FEFFFF",
    "settings-sidebar-bg": "rgba(244,248,251,0.60)",
    "sidebar-action-hover-bg": "rgba(0,0,0,0.05)",
    // Issue 1: selection elevates, container recedes. Selected lifts to panel
    // (L 0.977 vs sidebar 0.936), hover to canvas (L 0.958) — idle < hover < selected.
    "sidebar-active-bg": "#F4F8FB",
    "sidebar-hover-bg": "#ECF2F7",
    "toolbar-agent-hover-bg": "rgba(22,52,71,0.06)",
    "toolbar-control-hover-bg": "rgba(22,52,71,0.07)",
    "toolbar-control-hover-fg": "#178463",
    "toolbar-control-hover-shadow": "none",
    "toolbar-divider": "rgba(211,218,226,0.6)",
    "toolbar-pill-radius": "0.5rem",
    "toolbar-project-bg":
      "linear-gradient(180deg, rgba(23,132,99,0.06), rgba(22,52,71,0.04)), linear-gradient(135deg, #EBF2F8, #E4EBF3)",
    "toolbar-project-border": "rgba(211,218,226,0.7)",
    "toolbar-project-chip-bg": "rgba(22,52,71,0.05)",
    "toolbar-project-chip-border": "rgba(211,218,226,0.7)",
    "toolbar-project-shadow": "inset 0 1px 0 rgba(255,255,255,0.5)",
    "toolbar-shadow": "none",
    "toolbar-stats-bg": "rgba(22,52,71,0.05)",
    "toolbar-stats-border": "rgba(211,218,226,0.6)",
    "toolbar-stats-divider": "rgba(211,218,226,0.6)",
    "toolbar-stats-hover-bg": "rgba(22,52,71,0.07)",
    "toolbar-stats-shadow": "none",
    "worktree-section-hover-bg": "rgba(22,52,71,0.05)",
  },
};
