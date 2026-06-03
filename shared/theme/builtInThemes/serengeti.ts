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
    // Deep savanna chrome (grid/sidebar) framing warm-white content
    // (canvas/panel/elevated). The ladder is deliberately wider than the other
    // light themes (#9713): OKLab L ~0.84 → 0.99 so the sidebar reads as a
    // distinct warm column instead of the same shade as the canvas. Chroma
    // falls as surfaces rise — the saturated tans live in the chrome and the
    // content field rests near warm-white, so the app reads as "warm white
    // with earth chrome" rather than uniformly tinted beige.
    surfaces: {
      grid: "#DCCB9D",
      sidebar: "#E7D8B0",
      canvas: "#F4EBD2",
      panel: "#FAF4E4",
      elevated: "#FFFEFA",
    },
    text: {
      primary: "#382818",
      secondary: "#5E4D33",
      muted: "#6E5A2C",
      inverse: "#FFFEFA",
    },
    border: "#BBA86E",
    // Sunlit acacia gold — saturated enough to register as the one accent
    // against the warm browns of the text ramp.
    accent: "#9C6400",
    accentSecondary: "#467030",
    // Status hues nudged a few percent deeper than the original Serengeti
    // values so they clear the 3:1 graphical floor on the deeper grid chrome.
    status: {
      success: "#467D28",
      warning: "#A36010",
      danger: "#C2402F",
      info: "#346C94",
    },
    // Activity dots decoupled from the text-grade status colors: the dots are
    // where the living acacia green shows against the dry-grass field, so they
    // spend a little more chroma than status.success (which stays deep for
    // contrast). Idle is a warm bark amber, not an olive smudge.
    activity: {
      active: "#3E8A24",
      idle: "#9A7B3C",
      working: "#3E8A24",
      waiting: "#A87529",
    },
    overlayTint: "#2C210F",
    terminal: {
      background: "#2C2115",
      foreground: "#E8DDC5",
      muted: "#6B7B3A",
      cursor: "#A87A20",
      selection: "rgba(158,127,34,0.28)",
      red: "#D47060",
      green: "#6BAA55",
      yellow: "#C49840",
      blue: "#6A98B8",
      magenta: "#A87898",
      cyan: "#5AACA0",
      brightRed: "#E89080",
      brightGreen: "#88C070",
      brightYellow: "#DDB860",
      brightBlue: "#88B8D4",
      brightMagenta: "#C098B0",
      brightCyan: "#78C8BA",
      brightWhite: "#F8F0DD",
    },
    syntax: {
      comment: "#6B6050",
      punctuation: "#74624A",
      number: "#8C5E0E",
      string: "#3A7026",
      operator: "#1C7264",
      keyword: "#90486A",
      function: "#2A6796",
      link: "#2A6796",
      quote: "#6E5A2C",
      chip: "#78B898",
    },
    strategy: {
      shadowStyle: "light",
      materialBlur: 12,
      materialSaturation: 100,
      // Warm charcoal border ink (near text-primary) so the derived border
      // ladder stays on-temperature; the engine's cool default reads as gray
      // grime against the savanna tan.
      borderInkOverride: "#3A2A18",
    },
  },
  tokens: {
    "accent-foreground": "#FFFEFA",
    "category-amber": "oklch(0.60 0.15 75)",
    "category-blue": "oklch(0.54 0.11 235)",
    "category-cyan": "oklch(0.56 0.09 190)",
    "category-green": "oklch(0.55 0.12 145)",
    "category-indigo": "oklch(0.52 0.11 270)",
    "category-orange": "oklch(0.58 0.16 50)",
    "category-pink": "oklch(0.57 0.11 10)",
    "category-purple": "oklch(0.54 0.12 320)",
    "category-rose": "oklch(0.57 0.13 25)",
    "category-slate": "oklch(0.50 0.03 230)",
    "category-teal": "oklch(0.55 0.09 180)",
    "category-violet": "oklch(0.53 0.11 295)",
    // Engine border-strong is withAlpha(borderInk, 0.18); a touch more weight
    // crisps the 1px frame on white-over-cream floating surfaces (tooltips,
    // popovers, menus), which dissolve at the neutral-light default.
    "border-strong": "rgba(58, 42, 24, 0.24)",
    "focus-ring": "rgba(156,100,0,0.55)",
    // The engine's lowest overlay rungs (0.02/0.03/0.05) are tuned for neutral
    // light fields and vanish on Serengeti's saturated tans — the quick-state
    // segmented control's active fill (overlay-subtle) was invisible on the
    // filter band. Lift the lower ladder while keeping it monotonic below
    // overlay-strong (0.08).
    "overlay-subtle": "rgba(44, 33, 15, 0.045)",
    "overlay-soft": "rgba(44, 33, 15, 0.06)",
    "overlay-medium": "rgba(44, 33, 15, 0.075)",
    // Menu/list selection primitive: a warm cream lift (sibling of
    // sidebar-active-bg) instead of the engine's elevated-toward-ink mix,
    // which reads as muddy gray on the warm palette.
    "overlay-raised": "#F3E9CC",
    "pr-closed": "#C81F2B",
    "pr-draft": "#656E79",
    "pr-merged": "#7340CC",
    "pr-open": "#176E30",
    "scrim-medium": "rgba(44,33,15,0.36)",
    "scrim-soft": "rgba(44,33,15,0.22)",
    "scrim-strong": "rgba(44,33,15,0.55)",
    "scrollbar-thumb": "#86764D",
    "scrollbar-thumb-hover": "color-mix(in oklab, #86764D 85%, #382818)",
    "search-highlight-background": "rgba(70,112,48,0.16)",
    "search-highlight-text": "#3E6A2A",
    "search-match-badge-background": "rgba(70,112,48,0.18)",
    "search-match-badge-text": "#3E6A2A",
    "search-selected-result-border": "#3E6A2A",
    "search-selected-result-icon": "#3E6A2A",
    // Warm-ink shadows: same magnitudes as the engine's "light" profile, but
    // tinted with the theme's overlay ink (#2C210F) instead of the profile's
    // cool blue-gray, which hazes gray over the warm tan surfaces.
    "shadow-ambient": "0 8px 24px rgba(44, 33, 15, 0.10)",
    "shadow-color": "rgba(44, 33, 15, 0.12)",
    "shadow-dialog": "0 28px 64px rgba(44, 33, 15, 0.14)",
    // Tighter + deeper than the profile default so near-white floating cards
    // separate from the warm canvas instead of dissolving into it.
    "shadow-floating": "0 14px 40px rgba(44, 33, 15, 0.17)",
    "terminal-black": "#2C2115",
    "terminal-white": "#E8DDC5",
    "text-link": "#6E5400",
    "text-placeholder": "#8E7C54",
  },
  extensions: {
    "panel-grid-bg": "#D9C796",
    "settings-dialog-bg": "#FAF4E4",
    "settings-card-bg": "#FFFEFA",
    "settings-list-item-bg": "#FFFEFA",
    "pulse-card-bg": "#FFFEFA",
    "pulse-card-shadow": "0 1px 3px rgba(44,33,15,0.08)",
    "pulse-control-hover-bg": "rgba(44,33,15,0.05)",
    "pulse-empty-bg": "#F4EBD2",
    // The heatmap is the one sanctioned vivid-chroma surface — a brighter
    // growth green keeps low-opacity cells from going muddy olive over cream.
    "pulse-heat-color": "#3F8A1C",
    "pulse-heat-high-opacity": "0.88",
    "pulse-heat-low-opacity": "0.42",
    "pulse-heat-medium-opacity": "0.65",
    "pulse-missed-bg": "#C2402F",
    "pulse-range-bg": "#F4EBD2",
    "pulse-ring-offset": "#FFFEFA",
    "pulse-skeleton-gradient": "linear-gradient(90deg, #DCCB9D 25%, #ECE0C0 50%, #DCCB9D 75%)",
    "settings-nav-active-bg": "#FBF5E6",
    "settings-nav-hover-bg": "rgba(156,100,0,0.08)",
    // Settings nav rail drops to grid-chrome depth so the dialog gets the same
    // chrome-frames-content separation as the main window.
    "settings-sidebar-bg": "#DCCB9D",
    "sidebar-action-hover-bg": "rgba(156,100,0,0.08)",
    // Row states re-baselined as upward opaque lifts over the deeper sidebar:
    // idle #E7D8B0 < hover #F2E7C7 < active #F7EDCF < elevated.
    "sidebar-active-bg": "#F7EDCF",
    "sidebar-hover-bg": "#F2E7C7",
    "toolbar-agent-hover-bg": "rgba(156,100,0,0.07)",
    "toolbar-control-hover-bg": "rgba(156,100,0,0.08)",
    "toolbar-divider": "rgba(187,168,110,0.7)",
    "toolbar-project-bg":
      "linear-gradient(180deg, rgba(44,33,15,0.03), rgba(44,33,15,0.06)), linear-gradient(135deg, #ECDFBD, #DCCB9D)",
    "toolbar-project-border": "rgba(187,168,110,0.65)",
    "toolbar-project-chip-bg": "rgba(44,33,15,0.06)",
    "toolbar-project-chip-border": "rgba(187,168,110,0.65)",
    "toolbar-project-shadow": "inset 0 1px 0 rgba(255,254,250,0.5)",
    "toolbar-stats-bg": "rgba(156,100,0,0.07)",
    "toolbar-stats-border": "rgba(187,168,110,0.65)",
    "toolbar-stats-divider": "rgba(187,168,110,0.65)",
    "toolbar-stats-hover-bg": "rgba(156,100,0,0.08)",
    // Recessed savanna header band behind the worktree search/filter region —
    // one step deeper and warmer than the sidebar so the top of the column
    // reads as structured chrome instead of more of the same beige.
    "worktree-filter-bar-bg": "#DBC894",
    // Opaque warm lift (was an 8% gold alpha, which darkened on light — wrong
    // polarity for the light selection matrix).
    "worktree-section-hover-bg": "#F0E7CD",
  },
};
