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
    surfaces: {
      grid: "#D2DABE",
      sidebar: "#DCE3C9",
      canvas: "#E4EAD2",
      panel: "#ECF1E0",
      elevated: "#FBFCF6",
    },
    text: {
      primary: "#1D2B1E",
      secondary: "#3F5240",
      muted: "#5C7460",
      inverse: "#FAFCF5",
    },
    border: "rgba(20,40,25,0.16)",
    accent: "#218546",
    accentSecondary: "#3A7A4E",
    status: {
      success: "#188A40",
      warning: "#946400",
      danger: "#C0453A",
      info: "#2E7E8A",
    },
    activity: {
      active: "#0E7D33",
      idle: "#62786A",
      working: "#0E7D33",
      waiting: "#8A6A0C",
    },
    overlayTint: "#142819",
    terminal: {
      background: "#182B1B",
      foreground: "#DCE6D9",
      muted: "#5C8A65",
      cursor: "#C9A84C",
      selection: "rgba(34,130,67,0.30)",
      red: "#E07870",
      green: "#64B884",
      yellow: "#D4A840",
      blue: "#60AACC",
      magenta: "#C080C0",
      cyan: "#44C4AA",
      brightRed: "#F09888",
      brightGreen: "#80D49C",
      brightYellow: "#F0C060",
      brightBlue: "#84C8E4",
      brightMagenta: "#D4A4D8",
      brightCyan: "#68D4BC",
      brightWhite: "#FAFCF5",
    },
    syntax: {
      comment: "#4C6E58",
      punctuation: "#4C6E56",
      number: "#826010",
      string: "#287244",
      operator: "#137258",
      keyword: "#854798",
      function: "#2A6BA2",
      link: "#0C763A",
      quote: "#506E56",
      chip: "#6CC8B0",
    },
    strategy: {
      materialBlur: 10,
      materialSaturation: 118,
    },
  },
  tokens: {
    "accent-muted": "rgba(31,130,68,0.30)",
    "accent-soft": "rgba(31,130,68,0.18)",
    "accent-foreground": "#FFFFFF",
    "text-link": "#0C763A",
    "text-placeholder": "#728675",
    "border-divider": "rgba(20,40,25,0.10)",
    "border-interactive": "rgba(31,130,68,0.34)",
    "border-strong": "rgba(20,40,25,0.20)",
    "border-subtle": "rgba(20,40,25,0.09)",
    "category-amber": "oklch(0.62 0.14 65)",
    "category-blue": "oklch(0.58 0.13 242)",
    "category-cyan": "oklch(0.6 0.11 198)",
    "category-green": "oklch(0.59 0.14 152)",
    "category-indigo": "oklch(0.57 0.13 264)",
    "category-orange": "oklch(0.6 0.15 38)",
    "category-pink": "oklch(0.59 0.13 340)",
    "category-purple": "oklch(0.58 0.13 318)",
    "category-rose": "oklch(0.6 0.14 14)",
    "category-teal": "oklch(0.59 0.11 178)",
    "category-violet": "oklch(0.57 0.13 295)",
    "focus-ring": "rgba(31,130,68,0.40)",
    "focus-ring-offset": "3px",
    // B1: pr-draft / pr-merged / pr-open / pr-closed re-darkened to clear AA
    // (4.5:1) on the panel surface where PR badges render. The GitHub-brand
    // defaults (pr-draft #85909C = 2.82:1, pr-open #188537 = 4.10:1, pr-merged
    // #864BE8 = 4.35:1) failed on bali's near-white panel; these keep the same
    // hue family, lowered in L.
    "pr-closed": "#C81824",
    "pr-draft": "#5E6A77",
    "pr-merged": "#6B3BC0",
    "pr-open": "#137A30",
    "overlay-emphasis": "rgba(20,40,25,0.20)",
    "overlay-medium": "rgba(20,40,25,0.11)",
    "overlay-soft": "rgba(20,40,25,0.07)",
    "overlay-strong": "rgba(20,40,25,0.15)",
    "overlay-subtle": "rgba(20,40,25,0.045)",
    "overlay-hover": "rgba(20,40,25,0.19)",
    "overlay-active": "rgba(20,40,25,0.28)",
    "overlay-selected": "rgba(20,40,25,0.20)",
    "overlay-elevated": "rgba(20,40,25,0.16)",
    // E1 elevate-to-select: NOT overridden. The engine light default
    // (color-mix elevated 92% + text-primary) sits a hair darker than the pure
    // elevated surface, so a selected menu/tab item still steps visibly even
    // when it sits ON an elevated floating plane. Pinning it to the raw
    // elevated hex would collapse that step on floating surfaces.
    // B1 filter-selected (membership, never accent): a lighter/elevated fill +
    // border-strong containment edge, lifting just above the panel rather than
    // the old overlayBase@0.08/0.12 darken.
    "filter-selected-bg-soft": "#F3F7EA",
    "filter-selected-bg-strong": "#FBFCF6",
    // E7: cool-slate-hued, lowered scrims so the modal backdrop dims without a
    // heavy black slab over a near-white workbench.
    "scrim-medium": "rgba(20,40,25,0.36)",
    "scrim-soft": "rgba(20,40,25,0.22)",
    "scrim-strong": "rgba(20,40,25,0.55)",
    "scrollbar-thumb": "#5C7460",
    "scrollbar-thumb-hover": "color-mix(in oklab, #5C7460 80%, #1D2B1E)",
    "search-highlight-background": "rgba(31,130,68,0.18)",
    "search-highlight-text": "#0C763A",
    "search-match-badge-background": "rgba(31,130,68,0.18)",
    "search-match-badge-text": "#0C763A",
    "search-selected-result-border": "#1F8244",
    "search-selected-result-icon": "#0C763A",
    "surface-hover": "rgba(20,40,25,0.19)",
    "surface-active": "rgba(20,40,25,0.28)",
    // E8: input is a recessed inset well, not the brightest object on screen.
    // Dropped the old raised #F2F6E8 (elevated) override so the engine's
    // recessed light default applies (canvas pulled a hair toward text).
    "surface-inset": "#DBE2C7",
    "surface-toolbar": "#DEE5CC",
    "terminal-black": "#182B1B",
    "terminal-white": "#DCE6D9",
  },
  extensions: {
    "panel-grid-bg": "#D7DEC4",
    // S1: dialog body recedes to surface-panel; cards/list-items elevate above it.
    // Body and card were both #FBFCF6 (collapsed, card inverted at/below body); body
    // now sits at panel #ECF1E0 so the elevated card (#FBFCF6, +0.039 L) reads lifted.
    "settings-dialog-bg": "#ECF1E0",
    "settings-card-bg": "#FBFCF6",
    "settings-list-item-bg": "#FBFCF6",
    "pulse-before-bg": "#CBBF9A",
    "pulse-card-bg": "#FBFCF6",
    "pulse-card-shadow": "0 2px 6px rgba(23,33,48,0.10)",
    "pulse-control-hover-bg": "rgba(20,40,25,0.06)",
    // P-Heat: empty cell was #D2BD9E (L 0.808) — so dark it read as active and
    // the missed-day danger fill only reached 2.77:1 over it. Lightened to
    // #E6DCC4 (L 0.896), same warm-sand hue, so the opaque missed-day danger
    // now clears 3.71:1.
    "pulse-empty-bg": "#E6DCC4",
    "pulse-heat-high-opacity": "0.85",
    "pulse-heat-low-opacity": "0.38",
    "pulse-heat-medium-opacity": "0.62",
    // P-Heat missed-day (streak break): was a ~14% transparent red film (~1.3:1
    // over empty, invisible). Now an opaque brighter danger fill clearing 3:1;
    // the shape-cue inset ring is added by the component on light.
    "pulse-missed-bg": "#C0453A",
    "pulse-range-bg": "#E4EAD2",
    "pulse-ring-offset": "#FBFCF6",
    "pulse-skeleton-gradient": "linear-gradient(90deg, #CFC4A0 25%, #DAD0B8 50%, #CFC4A0 75%)",
    "settings-kbd-bg": "#E4EAD2",
    "settings-search-bg": "#E4EAD2",
    // S1: single accent anchor is the 2px nav marker (SettingsDialog.tsx). The
    // active-nav FILL is now a NEUTRAL elevated lift (no accent rgb) instead of
    // the old accent-tinted darken rgba(31,130,68,0.18). The accent inset ring
    // (settings-nav-active-shadow) is dropped — S1 removed its CSS consumer and
    // is retiring the key; bali drops its value to support that retirement.
    "settings-nav-active-bg": "#F4F7EA",
    "settings-nav-hover-bg": "rgba(20,40,25,0.07)",
    "sidebar-action-hover-bg": "rgba(20,40,25,0.07)",
    // Issue 1: selection ELEVATES on light. The active row lifts to an opaque
    // surface between panel and elevated (+0.067 OKLab L over surface-sidebar,
    // clearing the JND audit); hover sits between sidebar and canvas (+0.029),
    // so idle < hover < selected all clear JND. The sidebar.css left-marker is
    // border-strong (containment edge). Dark is unchanged (white-alpha fallback
    // in sidebar.css). NOTE: extensionRegistry SIDEBAR_ACTIVE/SIDEBAR_HOVER
    // still enforce the OLD rgba(0,0,0,*) darken contract — these opaque values
    // require the registry owner to update that governance (flagged).
    "sidebar-active-bg": "#F4F7EA",
    "sidebar-hover-bg": "#E6ECD6",
    "toolbar-agent-hover-bg": "rgba(20,40,25,0.07)",
    "toolbar-control-hover-bg": "rgba(20,40,25,0.07)",
    "toolbar-control-hover-fg": "#1F8244",
    "toolbar-divider": "rgba(20,40,25,0.10)",
    "toolbar-project-bg":
      "linear-gradient(180deg, rgba(31,130,68,0.05), rgba(20,40,25,0.07)), linear-gradient(135deg, #DEE5CC, #D2DABE)",
    "toolbar-project-border": "rgba(20,40,25,0.10)",
    "toolbar-project-chip-bg": "rgba(20,40,25,0.08)",
    "toolbar-project-chip-border": "rgba(20,40,25,0.10)",
    "toolbar-project-shadow": "inset 0 1px 0 rgba(255,255,255,0.30)",
    "toolbar-stats-bg": "rgba(20,40,25,0.06)",
    "toolbar-stats-border": "rgba(20,40,25,0.09)",
    "toolbar-stats-divider": "rgba(20,40,25,0.09)",
    "toolbar-stats-hover-bg": "rgba(20,40,25,0.07)",
    "worktree-section-hover-bg": "rgba(20,40,25,0.07)",
  },
};
