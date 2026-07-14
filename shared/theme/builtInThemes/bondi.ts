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
    // One warm sand/stone family; content lifts toward white — never a darker
    // fill on a light container. Water is detail only (accent, search, info,
    // heat, terminal), never a field surface.
    surfaces: {
      grid: "#DCD8CA",
      sidebar: "#EDEAE0",
      canvas: "#F3F1EA",
      panel: "#F9F8F3",
      elevated: "#FFFFFF",
    },
    text: {
      // Near-neutral ink; muted ≥ 5.2:1 on the grid, 6.0:1 on canvas.
      primary: "#1C2028",
      secondary: "#454D56",
      muted: "#555B62",
      inverse: "#FDFDFE",
    },
    border: "#D1CDC3",
    accent: "#178463",
    accentSecondary: "#0A7E8C",
    // Status colors render as text — keep ≥ 4.5:1 on every surface up to #FFFFFF.
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
    // Warm ink: a cool overlay tint reads as grime on the sand field.
    overlayTint: "#322E26",
    terminal: {
      background: "#1E252E",
      foreground: "#C8D0D9",
      // 3.38:1 on the terminal background.
      muted: "#6B7783",
      cursor: "#F5B814",
      selection: "#123941",
      red: "#E05C5C",
      green: "#2EBD88",
      yellow: "#F5B814",
      blue: "#37A6D9",
      magenta: "#AE6BF2",
      cyan: "#0FA8C0",
      // Every bright sits above its base in OKLCH L and ≥ 4.5:1 on the background.
      brightRed: "#F07F77",
      brightGreen: "#56D1A3",
      brightYellow: "#EFCA61",
      brightBlue: "#7EC9ED",
      brightMagenta: "#C39DEE",
      brightCyan: "#6FDBE1",
      brightWhite: "#E8F4FD",
    },
    syntax: {
      comment: "#59697E",
      punctuation: "#5C6875",
      number: "#895E00",
      string: "#1C7350",
      operator: "#0B7184",
      // Keyword L pinned at 0.46: needs ΔL ≥ 0.18 on the terminal bg, 4.5:1 on canvas.
      keyword: "#644395",
      function: "#1C68A8",
      link: "#10704F",
      quote: "#5A6878",
      chip: "#0A7E8C",
    },
    strategy: {
      shadowStyle: "light",
      materialBlur: 12,
      materialSaturation: 115,
      // The granular tile replaces the universal photographic noise.
      grainCharacter: "coarse",
    },
  },
  tokens: {
    "accent-muted": "rgba(23,132,99,0.30)",
    "accent-soft": "rgba(23,132,99,0.18)",
    // De-aliased from accent/accentSecondary hues so worktree stripes and
    // pills never read as the focus signal.
    "category-green": "oklch(0.53 0.15 142)",
    "category-teal": "oklch(0.5 0.075 187)",
    "category-cyan": "oklch(0.6 0.09 218)",
    // Alpha baked into the tile — the token replaces the engine value wholesale.
    "chrome-noise-texture":
      "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='sand'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23sand)' opacity='0.018'/%3E%3C/svg%3E\"), radial-gradient(circle at 78% 115%, rgb(15 20 28 / 0.02), transparent 60%)",
    "focus-ring": "rgba(23,132,99,0.35)",
    "grain-opacity": "0.03",
    "overlay-hover": "rgba(50,46,38,0.08)",
    // Derived 3% is sub-threshold over near-white surfaces.
    "overlay-soft": "rgba(50,46,38,0.055)",
    // Opaque elevate-to-select for menu/palette rows on white popovers.
    "overlay-raised": "#ECEAE2",
    // GitHub-brand defaults fail AA on the near-white panel.
    "pr-merged": "#7644CC",
    "pr-draft": "#646B73",
    "scrollbar-thumb": "#7B766C",
    "scrollbar-thumb-hover": "color-mix(in oklab, #7B766C 85%, #1C2028)",
    "scrim-soft": "rgba(50,46,38,0.16)",
    "scrim-medium": "rgba(50,46,38,0.28)",
    "scrim-strong": "rgba(50,46,38,0.46)",
    "scrim-blur": "16px",
    "search-highlight-background": "rgba(35,94,150,0.14)",
    "search-highlight-text": "#235E96",
    "search-match-badge-background": "rgba(35,94,150,0.14)",
    "search-match-badge-text": "#235E96",
    "search-selected-result-border": "rgba(35,94,150,0.34)",
    "search-selected-result-icon": "#235E96",
    // Two-layer contact+spread: the engine "light" single penumbra has no
    // contact edge on a near-white field.
    "shadow-ambient": "0 1px 2px rgba(43,38,31,0.10), 0 6px 16px rgba(43,38,31,0.10)",
    // Dialogs sit a full z-tier above menus/popovers.
    "shadow-dialog": "0 2px 6px rgba(43,38,31,0.10), 0 24px 60px rgba(43,38,31,0.18)",
    "shadow-floating": "0 1px 3px rgba(43,38,31,0.12), 0 12px 32px rgba(43,38,31,0.14)",
    "surface-inset": "#F1EFE8",
    // Inputs are raised on light, never recessed (overrides the engine's
    // recessed derivation).
    "surface-input": "#FDFCF8",
    "surface-toolbar": "#EFEEE9",
    // Dim tier floor: ≥ 3:1 on the terminal background.
    "terminal-bright-black": "#66727F",
    "terminal-white": "#C8D0D9",
    "text-link": "#0F5B41",
    // 4.3:1 on the raised input.
    "text-placeholder": "rgba(28,32,40,0.60)",
  },
  extensions: {
    "dock-bg": "#EFEEE9",
    "dock-input-bg": "#FDFCF8",
    // Lifts to white; the accent hairline border fallback stays as the one
    // signal, matching the worktree-card white-plus-rail idiom.
    "dock-item-bg-active": "#FFFFFF",
    // Registry format guard: shadow-color channels, alpha ≥ 0.25.
    "dock-shadow": "0 -2px 8px rgb(from var(--theme-shadow-color) r g b / 0.25)",
    // Panel title bars join the sand chrome; the focused pane's cap brightens.
    "panel-header-bg": "#E4E1D5",
    "panel-header-focus-bg": "#F7F6F2",
    // Warm ink only, never accent — the white-card-plus-rail selection stays
    // the region's one accent signal. Selected and focused share this border.
    "panel-focus-border": "rgba(43,38,31,0.50)",
    "panel-focus-shadow": "0 1px 2px rgba(43,38,31,0.12)",
    // The audited flat grid hex stays the final layer; surfaces.grid is
    // untouched so the ramp audit is unaffected.
    "panel-grid-bg": "linear-gradient(180deg, #DDDACC 0%, #DAD5C7 100%), #DCD8CA",
    // White-gloss lift for emoji tiles (the dark wash renders murky on light).
    "project-tile-wash":
      "linear-gradient(to bottom, rgba(255,255,255,0.40), rgba(255,255,255,0.10))",
    "project-tile-shadow": "inset 0 1px 1px rgba(43,38,31,0.10), 0 0 0 1px rgba(44,39,31,0.10)",
    "pulse-before-bg": "#DAD9CF",
    "pulse-card-bg": "#FFFFFF",
    "pulse-card-header-bg": "#F9F8F2",
    "pulse-card-shadow": "0 1px 2px rgba(43,38,31,0.10), 0 4px 10px rgba(43,38,31,0.08)",
    "pulse-control-hover-bg": "rgba(50,46,38,0.05)",
    "pulse-empty-bg": "#F3F1EA",
    // Bathymetric heat ramp: opaque stops (these supersede the
    // heat-color/opacity keys at the consumer).
    "pulse-heat-1": "#CAF1F0",
    "pulse-heat-2": "#6BC9CC",
    "pulse-heat-3": "#0099A2",
    "pulse-heat-4": "#006171",
    "pulse-range-bg": "#F3F1EA",
    "pulse-ring-offset": "#FFFFFF",
    "pulse-skeleton-gradient": "linear-gradient(90deg, #DCD8CA 25%, #F3F1EA 50%, #DCD8CA 75%)",
    "dialog-header-bg": "#FAF9F5",
    "review-commit-input-bg": "#FDFCF8",
    "settings-kbd-bg": "#F1EFE8",
    "settings-kbd-border": "#D1CDC3",
    // Nav selection elevates to white + the 2px accent marker.
    "settings-nav-active-bg": "#FFFFFF",
    "settings-nav-active-shadow": "none",
    "settings-nav-hover-bg": "rgba(58,48,30,0.05)",
    // Scope pill elevates to white on the tinted settings sidebar.
    "settings-scope-bg": "#FFFFFF",
    "settings-sidebar-bg": "rgba(237,234,224,0.60)",
    // Composited settings-sidebar-bg over the shell.
    "settings-sidebar-scroll-fade": "#F2F0E8",
    "sidebar-action-hover-bg": "rgba(58,48,30,0.05)",
    // idle < hover < selected (audit-enforced); contact shadow only, no ring —
    // selection = bg + right accent rail.
    "sidebar-card-bg": "#F8F6EF",
    "sidebar-card-shadow": "0 1px 2px rgba(48,40,28,0.05)",
    "sidebar-active-bg": "#FFFFFF",
    "sidebar-hover-bg": "#FCFBF7",
    "toolbar-agent-hover-bg": "rgba(28,32,40,0.06)",
    "toolbar-control-hover-bg": "rgba(28,32,40,0.06)",
    // Accent restraint: hover affordance is the bg, not an accent foreground.
    "toolbar-control-hover-fg": "#1C2028",
    "toolbar-control-hover-shadow": "none",
    "toolbar-divider": "rgba(211,208,199,0.7)",
    "toolbar-pill-radius": "0.5rem",
    // Pills sit lighter than the chrome strip (raised, like all content).
    "toolbar-project-bg":
      "linear-gradient(180deg, rgba(245,184,20,0.07), rgba(28,32,40,0.02)), #F9F8F4",
    "toolbar-project-border": "rgba(211,208,199,0.75)",
    "toolbar-project-chip-bg": "rgba(28,32,40,0.04)",
    "toolbar-project-chip-border": "rgba(211,208,199,0.75)",
    "toolbar-project-shadow": "inset 0 1px 0 rgba(255,255,255,0.5)",
    "toolbar-shadow": "0 1px 2px rgba(43,38,31,0.06)",
    "toolbar-stats-bg": "#F9F8F4",
    "toolbar-stats-border": "rgba(211,208,199,0.7)",
    "toolbar-stats-divider": "rgba(211,208,199,0.7)",
    "toolbar-stats-hover-bg": "#FCFBF7",
    // Filter rail sits flush on the field; the raised search input carries it.
    "worktree-filter-bar-bg": "#EDEAE0",
    // Active quick-state tab lifts to white under its inset underline.
    "worktree-quick-state-active-bg": "#FFFFFF",
    "worktree-search-input-bg": "#FDFCF8",
    "worktree-section-hover-bg": "rgba(58,48,30,0.05)",
  },
};
