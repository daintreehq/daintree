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
    // Ramp rebalance (#9714): the prior band floored at L≈0.87 (grid #C9D6E2),
    // which read as an overcast mid-gray rather than arctic snow. Lifted into an
    // airy band where the content surfaces (canvas/panel/elevated) trend toward
    // clean glacial white while the structural floor (grid) and the sidebar rail
    // hold the cool chroma. The sidebar→canvas step is the largest in the ramp
    // (dL≈0.033) so the navigation rail reads as a distinct deeper zone instead
    // of merging into the canvas. Audit-clean: even ramp, span 0.104,
    // panel→elevated keeps the strongest top-tier lift.
    surfaces: {
      grid: "#CFDDE8",
      sidebar: "#D7E4ED",
      canvas: "#E6EEF3",
      panel: "#F1F6F9",
      elevated: "#FAFEFF",
    },
    text: {
      primary: "#1B2A38",
      secondary: "#3F5364",
      muted: "#586B7E",
      inverse: "#FFFFFF",
    },
    border: "#A2B1BD",
    accent: "#1577A8",
    accentSecondary: "#1F7E62",
    status: {
      success: "#1E7A5C",
      // Cold-sunlight amber (OKLCH hue ~62) instead of the old olive #8A661A
      // (hue ~81) — the lone khaki note on an otherwise cool field read as
      // mustard against arctic blue. Same lightness, AA-clean on all surfaces.
      warning: "#9A5F24",
      danger: "#C0413E",
      info: "#2E6E96",
    },
    activity: {
      active: "#1E7A5C",
      idle: "#586B7E",
      working: "#1E7A5C",
      waiting: "#9A5F24",
    },
    overlayTint: "#142332",
    terminal: {
      background: "#1C2630",
      foreground: "#D2D9E0",
      muted: "#8C9E94",
      // Icy caret (5.8:1 on the dark field) — the old muddy gold #8F7335 was
      // the one warm spike on the cold terminal and sat at 3.4:1.
      cursor: "#7DA4C0",
      selection: "#2A3A4A",
      red: "#C87878",
      green: "#5DA88A",
      yellow: "#B89858",
      blue: "#6898C0",
      magenta: "#9880B0",
      cyan: "#5AA8B8",
      brightRed: "#D89898",
      brightGreen: "#78C0A0",
      brightYellow: "#D0B878",
      brightBlue: "#88B8D8",
      brightMagenta: "#B0A0C8",
      brightCyan: "#78C0CC",
      brightWhite: "#E8EEF2",
    },
    syntax: {
      comment: "#5A6B7C",
      punctuation: "#516172",
      number: "#7E5C14",
      string: "#177053",
      operator: "#286287",
      keyword: "#7A4FA8",
      function: "#3A5FB0",
      link: "#1E6A88",
      quote: "#566472",
      chip: "#68B0B8",
    },
    strategy: {
      shadowStyle: "light",
      materialBlur: 14,
      materialSaturation: 118,
    },
  },
  tokens: {
    "accent-hover": "color-mix(in oklab, #1577A8 90%, #ffffff)",
    // Two-layer contact+spread shadows tinted in Svalbard's own ink
    // (rgb(20,35,50), the overlayTint) — the derived "light" profile's wide
    // thin blur renders zero visible pixels against this theme's near-white
    // surfaces, so tooltips/popovers/cards separated by border alone.
    "shadow-ambient": "0 1px 2px rgba(20,35,50,0.10), 0 4px 12px rgba(20,35,50,0.09)",
    "shadow-floating": "0 2px 6px rgba(20,35,50,0.12), 0 14px 36px rgba(20,35,50,0.15)",
    "shadow-dialog": "0 4px 10px rgba(20,35,50,0.13), 0 26px 60px rgba(20,35,50,0.18)",
    "text-link": "#1E5A72",
    "text-placeholder": "#5E6B77",
    "category-amber": "oklch(0.60 0.110 75)",
    "category-blue": "oklch(0.58 0.110 242)",
    "category-cyan": "oklch(0.59 0.080 198)",
    "category-green": "oklch(0.58 0.100 158)",
    "category-indigo": "oklch(0.57 0.100 264)",
    "category-orange": "oklch(0.59 0.120 40)",
    "category-pink": "oklch(0.58 0.100 340)",
    "category-purple": "oklch(0.58 0.100 318)",
    "category-rose": "oklch(0.59 0.110 16)",
    "category-slate": "oklch(0.54 0.020 230)",
    "category-teal": "oklch(0.58 0.090 180)",
    "category-violet": "oklch(0.57 0.100 295)",
    "focus-ring": "rgba(21,119,168,0.30)",
    "pr-closed": "#B83E3B",
    "pr-draft": "#586470",
    "pr-merged": "#6C5CA8",
    "pr-open": "#1E7A5C",
    "label-pill-bg-opacity": "0.09",
    "label-pill-border-opacity": "0.16",
    "scrollbar-thumb": "#708395",
    "scrollbar-thumb-hover": "color-mix(in oklab, #708395 80%, #1B2A38)",
    "search-highlight-background": "rgba(21,119,168,0.16)",
    "search-highlight-text": "#1A5066",
    "search-match-badge-background": "rgba(21,119,168,0.14)",
    "search-match-badge-text": "#1A5066",
    "search-selected-result-border": "#1A5066",
    "search-selected-result-icon": "#1A5066",
    "surface-input": "#E2EAF0",
    // A real well: deep enough to read as recessed on the sidebar rail
    // (dL -0.027), not just on the snow-white selected row.
    "surface-inset": "#CEDBE5",
    "surface-toolbar": "#DAE5ED",
    "terminal-black": "#1C2630",
    "terminal-bright-black": "#52606B",
    "terminal-white": "#D2D9E0",
  },
  extensions: {
    "panel-grid-bg": "#C9D7E2",
    "pulse-before-bg": "#D7E4ED",
    "pulse-card-bg": "#FAFEFF",
    "pulse-control-hover-bg": "rgba(20,35,50,0.05)",
    "pulse-empty-bg": "#E6EEF3",
    "pulse-heat-high-opacity": "0.90",
    "pulse-heat-low-opacity": "0.42",
    "pulse-heat-medium-opacity": "0.66",
    "pulse-missed-bg": "#C0413E",
    "pulse-range-bg": "#E6EEF3",
    "pulse-ring-offset": "#FAFEFF",
    "pulse-skeleton-gradient": "linear-gradient(90deg, #CEDBE5 25%, #E6EEF3 50%, #CEDBE5 75%)",
    "settings-card-bg": "#FAFEFF",
    "settings-kbd-bg": "#CEDBE5",
    "settings-kbd-border": "rgba(20,35,50,0.10)",
    "settings-list-item-bg": "#FAFEFF",
    "settings-nav-active-bg": "#FAFEFF",
    "settings-search-bg": "#E2EAF0",
    "settings-sidebar-bg": "#D7E4ED",
    // Issue 1: selection elevates, container recedes. Selected lifts to elevated
    // (L 0.994 vs sidebar 0.912), hover to canvas (L 0.944) — idle < hover < selected.
    "sidebar-active-bg": "#FAFEFF",
    "sidebar-hover-bg": "#E6EEF3",
    "toolbar-control-hover-fg": "#1577A8",
    "toolbar-divider": "rgba(162,177,189,0.55)",
    "toolbar-project-bg":
      "linear-gradient(180deg, rgba(21,119,168,0.06), rgba(20,35,50,0.05)), linear-gradient(135deg, #DCE7EF, #CFDDE8)",
    "toolbar-project-border": "rgba(162,177,189,0.65)",
    "toolbar-project-chip-bg": "rgba(20,35,50,0.05)",
    "toolbar-project-chip-border": "rgba(162,177,189,0.65)",
    "toolbar-project-shadow": "inset 0 1px 0 rgba(255,255,255,0.45)",
    "toolbar-stats-border": "rgba(162,177,189,0.55)",
    "toolbar-stats-divider": "rgba(162,177,189,0.55)",
  },
};
