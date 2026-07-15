import type { BuiltInThemeSource } from "../builtInThemeSources.js";

export const theme: BuiltInThemeSource = {
  id: "highlands",
  name: "Highlands",
  type: "dark",
  builtin: true,
  location: "Scottish Highlands, Scotland",
  heroImage: "/themes/highlands.webp",
  palette: {
    type: "dark",
    surfaces: {
      // Keep field chroma ≤ ~0.009 at every tier — more reads as a violet filter.
      grid: "#131114",
      sidebar: "#171519",
      canvas: "#1F1E22",
      panel: "#2B292D",
      elevated: "#3C3A3F",
    },
    text: {
      primary: "#E0DDE3",
      secondary: "#B0ADB3",
      muted: "#928F96",
      inverse: "#1F1E22",
    },
    border: "#3B383E",
    // Heather accent; clears 3:1 on every surface.
    accent: "#B487D8",
    accentSecondary: "#C48A4A",
    status: {
      success: "#84B882",
      warning: "#A88554",
      danger: "#C08078",
      info: "#848C96",
    },
    activity: {
      active: "#64A36B",
      idle: "#5D5A61",
      working: "#64A36B",
      // Deliberately NOT the terminal cursor gold — state and grace note stay
      // separate pixels.
      waiting: "#BA9241",
    },
    overlayTint: "#CFC0E1",
    terminal: {
      // The one warm surface in a cool field; ANSI floors audited against it.
      background: "#1B1611",
      cursor: "#E1AF4A",
      selection: "#3D311D",
      red: "#D88078",
      green: "#64A36B",
      yellow: "#A88554",
      blue: "#7B9FCC",
      magenta: "#A580C3",
      cyan: "#6BADB8",
      brightRed: "#E8A098",
      brightGreen: "#86C28B",
      brightYellow: "#C9A870",
      brightBlue: "#9BBFE0",
      brightMagenta: "#C7A9E1",
      brightCyan: "#8FCAD3",
      brightWhite: "#F0EBF4",
    },
    syntax: {
      comment: "#73767C",
      punctuation: "#C3BCCC",
      number: "#C9A870",
      string: "#86C28B",
      operator: "#8ABDC8",
      // The one syntax role allowed accent-family bloom.
      keyword: "#C09EDC",
      function: "#8AABDC",
      link: "#7AB8CC",
      quote: "#A8A0B0",
      chip: "#9BC4C8",
    },
    strategy: {
      shadowStyle: "atmospheric",
      materialBlur: 10,
      materialSaturation: 105,
      radiusScale: 0.95,
      grainCharacter: "coarse",
    },
  },
  tokens: {
    "border-strong": "rgba(224,221,227,0.12)",
    "border-subtle": "rgba(224,221,227,0.06)",
    "chrome-noise-texture":
      "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.55' numOctaves='4' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='200' height='200' filter='url(%23noise)' opacity='0.02'/%3E%3C/svg%3E\")",
    "focus-ring": "rgba(180,135,216,0.50)",
    "scrim-blur": "16px",
    "grain-opacity": "0.03",
    // Peat ink (warm brown-black), never violet-black — ties scrims to the
    // terminal and shadow layers.
    "scrim-medium": "rgba(14,10,7,0.48)",
    "scrim-soft": "rgba(14,10,7,0.22)",
    "scrim-strong": "rgba(14,10,7,0.62)",
    "scrollbar-thumb": "#5D5A61",
    "scrollbar-thumb-hover": "color-mix(in oklab, #5D5A61 85%, #E0DDE3)",
    "search-highlight-background": "rgba(180,135,216,0.18)",
    "search-highlight-text": "#C9B6E2",
    "search-match-badge-background": "rgba(180,135,216,0.20)",
    "search-selected-result-border": "rgba(180,135,216,0.30)",
    "shadow-ambient": "0 1px 2px rgba(18,13,9,0.35), 0 4px 14px rgba(18,13,9,0.22)",
    "shadow-color": "rgba(18,13,9,0.50)",
    "shadow-dialog": "0 3px 8px rgba(18,13,9,0.30), 0 28px 72px rgba(18,13,9,0.45)",
    "shadow-floating": "0 2px 5px rgba(18,13,9,0.30), 0 18px 48px rgba(18,13,9,0.40)",
    // = sidebar exactly; toolbar, sidebar, and dock are one continuous shell.
    "surface-toolbar": "#171519",
    "text-placeholder": "#656269",
  },
  extensions: {
    "dock-bg": "#171519",
    // Pale-heather focus ink — NOT the accent (budget stays whole) and not
    // amber (collides with the panel-state-waiting border). Selected and
    // focused share it; outer-only, no inset (inset rings read as a defect).
    "panel-focus-border": "rgba(207,192,225,0.36)",
    "panel-focus-shadow": "0 0 0 1px rgba(207,192,225,0.10), 0 0 12px rgba(207,192,225,0.04)",
    "pulse-before-bg": "#151316",
    "pulse-card-bg": "#2B292D",
    "pulse-card-shadow": "0 1px 2px rgba(18,13,9,0.35), 0 4px 14px rgba(18,13,9,0.22)",
    "pulse-control-hover-bg": "rgba(207,192,225,0.05)",
    "pulse-empty-bg": "#312F34",
    // Heather heat ramp: opaque stops on H ~308, stepping L and C.
    "pulse-heat-1": "#554662",
    "pulse-heat-2": "#7F6596",
    "pulse-heat-3": "#A07EBE",
    "pulse-heat-4": "#BD92E4",
    "pulse-heat-color": "#BD92E4",
    "pulse-range-bg": "#1F1E22",
    "pulse-ring-offset": "#2B292D",
    "pulse-skeleton-gradient": "linear-gradient(90deg, #3C3A3F 25%, #454248 50%, #3C3A3F 75%)",
    // The single accent-tinted membership fill in the chrome.
    // Rows one step above the panel shell, well below elevated: secondary-text
    // labels hold ~6.1:1 here (washed out on the elevated fallback).
    "settings-card-bg": "#2F2D32",
    "settings-list-item-bg": "#2F2D32",
    "settings-nav-active-bg": "rgba(180,135,216,0.11)",
    "settings-nav-hover-bg": "rgba(207,192,225,0.05)",
    "settings-search-bg": "rgba(19,17,20,0.60)",
    "settings-sidebar-bg": "rgba(23,21,25,0.60)",
    // Composited settings-sidebar-bg over the shell.
    "settings-sidebar-scroll-fade": "#1F1D21",
    "sidebar-action-hover-bg": "rgba(207,192,225,0.05)",
    "sidebar-active-bg": "rgba(255,255,255,0.05)",
    "sidebar-hover-bg": "rgba(255,255,255,0.03)",
    "toolbar-agent-hover-bg": "rgba(207,192,225,0.06)",
    "toolbar-control-active-bg": "rgba(207,192,225,0.14)",
    "toolbar-control-armed-bg": "rgba(207,192,225,0.14)",
    "toolbar-control-armed-shadow": "inset 0 0 0 1px rgba(255,255,255,0.12)",
    "toolbar-control-hover-bg": "rgba(207,192,225,0.10)",
    "toolbar-divider": "rgba(59,56,62,0.5)",
    // Pill-sized gradient (small surface, no banding risk); same gold ink as
    // the cursor and welcome mark.
    "toolbar-project-bg":
      "linear-gradient(180deg, rgba(225,175,74,0.07) 0%, rgba(225,175,74,0.02) 100%)",
    "toolbar-project-border": "rgba(59,56,62,0.5)",
    "toolbar-project-chip-bg": "rgba(207,192,225,0.05)",
    "toolbar-project-chip-border": "rgba(59,56,62,0.5)",
    "toolbar-project-shadow": "inset 0 1px 0 rgba(255,255,255,0.05)",
    "toolbar-stats-bg": "rgba(207,192,225,0.05)",
    "toolbar-stats-border": "rgba(59,56,62,0.5)",
    "toolbar-stats-divider": "rgba(59,56,62,0.5)",
    "toolbar-stats-hover-bg": "rgba(207,192,225,0.10)",
    // Flat wash — a gradient here spans the whole welcome field and would band.
    "welcome-field-wash": "rgba(225,175,74,0.03)",
    "welcome-mark-color": "rgba(225,175,74,0.65)",
  },
};
