import type { BuiltInThemeSource } from "../builtInThemeSources.js";

export const theme: BuiltInThemeSource = {
  id: "hokkaido",
  name: "Hokkaido",
  type: "light",
  builtin: true,
  location: "Hokkaido, Japan",
  heroImage: "/themes/hokkaido.webp",
  palette: {
    type: "light",
    // One lavender-snow family; content lifts toward white — never a darker
    // fill on a light container. Chroma drains monotonically up the ramp
    // (shadowed snow → achromatic crust) — keep that arc when editing.
    surfaces: {
      grid: "#D5D3F2",
      sidebar: "#E9E7F3",
      canvas: "#F1F0F7",
      panel: "#F8F7FB",
      elevated: "#FFFFFF",
    },
    text: {
      // Near-neutral ink (C ≤ 0.012); muted ≥ 4.8:1 on the grid.
      primary: "#282630",
      secondary: "#4B4A52",
      muted: "#5A585F",
      inverse: "#FDFCFF",
    },
    border: "#D3CFDD",
    accent: "#6E57DB",
    // Doubles as status.success.
    accentSecondary: "#2C7458",
    // Status colors render as text — ≥ 3.4:1 on the grid, ≥ 4.4:1 on every
    // content surface up to #FFFFFF.
    status: {
      success: "#2C7458",
      warning: "#9A6310",
      danger: "#BE3C48",
      info: "#3A6FC0",
    },
    activity: {
      active: "#2E8A66",
      idle: "#6C7494",
      working: "#2E8A66",
      // working/waiting stay deuteranope-separable by luminance.
      waiting: "#A57A10",
    },
    // Cold near-neutral ink — the wash ladder must never read as grime on the
    // hued field.
    overlayTint: "#2C2C3B",
    terminal: {
      // Every chromatic ANSI slot clears ~4.5:1 on this background.
      background: "#22273B",
      foreground: "#E2E8F4",
      // Quieter than ANSI blue so muted output keeps de-emphasis salience.
      muted: "#76849F",
      cursor: "#CCA45E",
      selection: "#313963",
      red: "#D17A7A",
      green: "#7AA889",
      yellow: "#C2A170",
      blue: "#80A0D6",
      magenta: "#A28AD6",
      cyan: "#7FB9C2",
      brightRed: "#D4909A",
      brightGreen: "#91BEA8",
      brightYellow: "#D4B88A",
      brightBlue: "#9BBAE0",
      brightMagenta: "#B8A4E0",
      brightCyan: "#99CCD4",
      brightWhite: "#F2F4FA",
    },
    syntax: {
      comment: "#67667E",
      punctuation: "#525A74",
      number: "#92496A",
      string: "#356C62",
      operator: "#465680",
      keyword: "#564AA4",
      function: "#385AA8",
      link: "#574EC0",
      quote: "#565C7A",
      chip: "#4A7A8C",
    },
    strategy: {
      shadowStyle: "light",
      materialBlur: 8,
      materialSaturation: 108,
      radiusScale: 1.05,
      grainCharacter: "fine",
    },
  },
  tokens: {
    "accent-muted": "rgba(110,87,219,0.30)",
    "accent-soft": "rgba(110,87,219,0.18)",
    // Curated ramp: the engine light defaults collide with this status set
    // under CVD.
    "category-amber": "oklch(0.60 0.11 72)",
    "category-blue": "oklch(0.55 0.12 246)",
    "category-cyan": "oklch(0.58 0.08 214)",
    "category-green": "oklch(0.56 0.10 154)",
    "category-indigo": "oklch(0.54 0.12 270)",
    "category-orange": "oklch(0.58 0.12 42)",
    "category-pink": "oklch(0.58 0.10 338)",
    "category-purple": "oklch(0.56 0.11 314)",
    "category-rose": "oklch(0.57 0.11 12)",
    "category-slate": "oklch(0.53 0.025 248)",
    "category-teal": "oklch(0.57 0.09 186)",
    "category-violet": "oklch(0.55 0.11 292)",
    "focus-ring": "rgba(110,87,219,0.35)",
    // Screen-blended so grain reads as glint, not dirt, on the light field;
    // under the 0.05 texture ceiling.
    "grain-blend": "screen",
    "grain-opacity": "0.035",
    "overlay-hover": "rgba(44,44,59,0.08)",
    // Derived 3% is sub-threshold over near-white surfaces.
    "overlay-soft": "rgba(44,44,59,0.055)",
    // Opaque elevate-to-select for menu/palette rows on white popovers.
    "overlay-raised": "#E9E8F1",
    // Engine pr-merged sits too close to the violet accent — shifted to plum;
    // draft slate re-inked onto the field temperature.
    "pr-draft": "#5E5A6E",
    "pr-merged": "#8A3D96",
    "scrollbar-thumb": "#6A7290",
    "scrollbar-thumb-hover": "color-mix(in oklab, #6A7290 85%, #282630)",
    "scrim-blur": "16px",
    "scrim-blur-palette": "8px",
    "scrim-soft": "rgba(38,41,66,0.16)",
    "scrim-medium": "rgba(38,41,66,0.28)",
    "scrim-strong": "rgba(38,41,66,0.46)",
    "search-highlight-background": "rgba(58,111,192,0.22)",
    "search-highlight-text": "#27539A",
    "search-match-badge-background": "rgba(58,111,192,0.22)",
    "search-match-badge-text": "#27539A",
    "search-selected-result-border": "#3A6FC0",
    "search-selected-result-icon": "#27539A",
    // Blue shadow ink, short spreads — the contact edge dominates; the engine
    // "light" single penumbra has no contact edge on a near-white field.
    "shadow-ambient": "0 1px 2px rgba(44,48,78,0.12), 0 4px 12px rgba(44,48,78,0.08)",
    // Dialogs sit a full z-tier above menus/popovers.
    "shadow-dialog": "0 2px 6px rgba(44,48,78,0.12), 0 20px 48px rgba(44,48,78,0.16)",
    "shadow-floating": "0 1px 3px rgba(44,48,78,0.14), 0 10px 24px rgba(44,48,78,0.12)",
    // dock-shadow re-alphas these channels via rgb(from ...).
    "shadow-color": "rgba(44,48,78,0.12)",
    "surface-inset": "#F3F1F9",
    // Inputs are raised on light, never recessed (overrides the engine's
    // recessed derivation).
    "surface-input": "#FCFBFF",
    "surface-toolbar": "#ECEBF4",
    "terminal-bright-black": "#6A708C",
    "terminal-white": "#E2E8F4",
    "text-link": "#574EC0",
    // 4.3:1 on the raised input.
    "text-placeholder": "rgba(40,38,48,0.62)",
  },
  extensions: {
    "dock-bg": "#ECEBF4",
    "dock-input-bg": "#FCFBFF",
    // Lifts to white; the engine's accent hairline stays as the dock region's
    // one load-bearing signal.
    "dock-item-bg-active": "#FFFFFF",
    // Registry format guard: shadow-color channels, alpha ≥ 0.25.
    "dock-shadow": "0 -2px 8px rgb(from var(--theme-shadow-color) r g b / 0.25)",
    // Focus is the panel region's one accent signal — no other accent fill in
    // this region; no inset component. Selected fill keeps the elevated-white
    // fallback (lift-to-white law).
    "panel-focus-border": "rgba(110,87,219,0.70)",
    "panel-focus-shadow": "0 0 0 1px rgba(110,87,219,0.25), 0 1px 2px rgba(44,48,78,0.10)",
    // Panel title bars join the snow chrome; the focused pane's cap brightens.
    "panel-header-bg": "#DFDDF2",
    "panel-header-focus-bg": "#F4F4F9",
    // White-gloss lift for emoji tiles (the dark wash renders murky on light).
    "project-tile-wash":
      "linear-gradient(to bottom, rgba(255,255,255,0.40), rgba(255,255,255,0.10))",
    "project-tile-shadow": "inset 0 1px 1px rgba(44,48,78,0.10), 0 0 0 1px rgba(44,48,78,0.10)",
    "pulse-before-bg": "#D5D3F2",
    "pulse-card-bg": "#FFFFFF",
    "pulse-card-header-bg": "#F7F6FB",
    "pulse-card-shadow": "0 1px 2px rgba(44,48,78,0.10), 0 4px 10px rgba(44,48,78,0.08)",
    "pulse-control-hover-bg": "rgba(44,44,59,0.05)",
    "pulse-empty-bg": "#F1F0F7",
    // Lamp-amber heat (lavender would alias the accent): ≥ 3:1 on the white
    // card; the low stop must stay ≥ JND above the empty cell.
    "pulse-heat-high-opacity": "0.9",
    "pulse-heat-low-opacity": "0.35",
    "pulse-heat-medium-opacity": "0.6",
    "pulse-heat-color": "#A97416",
    "pulse-range-bg": "#F1F0F7",
    "pulse-ring-offset": "#FFFFFF",
    "pulse-skeleton-gradient": "linear-gradient(90deg, #D5D3F2 25%, #F1F0F7 50%, #D5D3F2 75%)",
    "dialog-header-bg": "#F9F8FD",
    "review-commit-input-bg": "#FCFBFF",
    "settings-kbd-bg": "#F3F1F9",
    "settings-kbd-border": "#D3CFDD",
    // Nav selection elevates to white + the 2px accent marker.
    "settings-nav-active-bg": "#FFFFFF",
    "settings-nav-active-shadow": "none",
    "settings-nav-hover-bg": "rgba(56,52,82,0.05)",
    // Scope pill elevates to white on the tinted settings sidebar.
    "settings-scope-bg": "#FFFFFF",
    "settings-sidebar-bg": "rgba(233,231,243,0.60)",
    // Composited settings-sidebar-bg over the shell.
    "settings-sidebar-scroll-fade": "#EFEDF6",
    "sidebar-action-hover-bg": "rgba(56,52,82,0.05)",
    // idle < hover < selected (audit-enforced); contact shadow only, no ring —
    // selection = bg + right accent rail.
    "sidebar-card-bg": "#F4F2FA",
    "sidebar-card-shadow": "0 1px 2px rgba(44,48,78,0.05)",
    "sidebar-active-bg": "#FFFFFF",
    "sidebar-hover-bg": "#F9F8FC",
    "toolbar-agent-hover-bg": "rgba(40,38,48,0.06)",
    "toolbar-control-hover-bg": "rgba(40,38,48,0.06)",
    // Accent restraint: hover affordance is the bg, not an accent foreground.
    "toolbar-control-hover-fg": "#282630",
    "toolbar-control-hover-shadow": "none",
    "toolbar-divider": "rgba(211,207,221,0.7)",
    // Pills sit lighter than the chrome strip (raised, like all content).
    "toolbar-project-bg":
      "linear-gradient(180deg, rgba(226,139,177,0.08), rgba(40,38,48,0.02)), #F8F7FB",
    "toolbar-project-border": "rgba(211,207,221,0.75)",
    "toolbar-project-chip-bg": "rgba(40,38,48,0.04)",
    "toolbar-project-chip-border": "rgba(211,207,221,0.75)",
    "toolbar-project-shadow": "inset 0 1px 0 rgba(255,255,255,0.5)",
    "toolbar-shadow": "0 1px 2px rgba(44,48,78,0.06)",
    "toolbar-stats-bg": "#F8F7FB",
    "toolbar-stats-border": "rgba(211,207,221,0.7)",
    "toolbar-stats-divider": "rgba(211,207,221,0.7)",
    "toolbar-stats-hover-bg": "#FBFAFD",
    // Flat tint — a gradient here spans the whole welcome field and would band.
    "welcome-field-wash": "rgba(64,66,118,0.04)",
    "welcome-mark-color": "rgba(178,92,130,0.70)",
    // Filter rail sits flush on the field; the raised search input carries it.
    "worktree-filter-bar-bg": "#E9E7F3",
    // Active quick-state tab lifts to white under its inset underline.
    "worktree-quick-state-active-bg": "#FFFFFF",
    "worktree-search-input-bg": "#FCFBFF",
    "worktree-section-hover-bg": "rgba(56,52,82,0.05)",
  },
};
