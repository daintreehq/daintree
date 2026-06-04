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
    // Winter-dawn composition (#9712, Bondi-standard rebuild): ONE lavender
    // snow family for the whole field (H~292-298) with white-crust content on
    // top. The frozen lake appears only as detail — the violet accent, the
    // deep-indigo terminal, info blue, search highlights — and the dawn sky
    // only as a whisper on the project pill, never as a field surface.
    // Everything that carries content lifts TOWARD white — never a darker
    // fill on a light container.
    // Ramp L 0.882/0.937/0.958/0.978/1.0: steps 0.0204-0.0555 (gate ≥ 0.02,
    // runaway ratio 2.72 < 3), span 0.118, panel→elevated not the smallest
    // step. The grid is SHADOWED SNOW at the lake edge — a full register
    // deeper and richer in chroma than the drifted-snow sidebar, so
    // chrome/field/well read as three planes and white panels get real
    // figure-ground pop (the old ramp packed all five tiers into 0.11 L with
    // sub-perceptual chroma steps and read as one violet-gray sheet).
    surfaces: {
      grid: "#D9D5E8",
      sidebar: "#EAE9F2",
      canvas: "#F1F0F7",
      panel: "#F8F7FC",
      elevated: "#FFFFFF",
    },
    text: {
      primary: "#282630",
      // Near-neutral ink (C ≤ 0.012) — the old #565C78/#5E6685 carried enough
      // blue-violet chroma to read dirty on the hued field: secondary now
      // 6.1:1 on the grid, muted 4.9:1 on the grid and 6.2:1 on canvas.
      secondary: "#4B4A52",
      muted: "#5A585F",
      inverse: "#FDFCFF",
    },
    border: "#D3CFDD",
    accent: "#6E57DB",
    accentSecondary: "#2C7458",
    // success/danger/warning render as TEXT (diff numerals, status labels) on
    // the near-white chips — all hold ≥ 3.5:1 on the grid and ≥ 4.4:1 on
    // every content surface up to #FFFFFF.
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
      // working (h163 green) and waiting amber stay deuteranope-separable by
      // luminance (ΔE 0.150), and waiting holds ≥ 3.4:1 on the new canvas.
      waiting: "#A57A10",
    },
    // Violet ink, not the old slate-mauve #525276: the overlay/wash ladder
    // composites onto the snow field, and a mid-L chromatic tint there reads
    // as grime — the ink must be a dark near-neutral in the field's own hue.
    overlayTint: "#33313D",
    terminal: {
      // The terminal is the frozen lake at dusk — its own deep-indigo
      // environment below the snow field.
      background: "#22273B",
      foreground: "#E2E8F4",
      // Quieter than ANSI blue (the old value aliased terminal-blue #80A0D6,
      // giving "muted" full ANSI salience); 3.9:1 on the terminal background.
      muted: "#76849F",
      cursor: "#C2A170",
      selection: "#313963",
      // 4.77:1 on the terminal background (the old #C87070 sat at 4.23:1) —
      // every ANSI slot clears ~4.5:1.
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
      // 4.9:1 on the brighter canvas (the old #71708A fell to 4.2:1 there).
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
      materialBlur: 12,
      materialSaturation: 115,
    },
  },
  tokens: {
    "accent-muted": "rgba(110,87,219,0.30)",
    "accent-soft": "rgba(110,87,219,0.18)",
    // Curated category ramp: the engine's light defaults collide with
    // hokkaido's status set under CVD (category-indigo vs status-info #3A6FC0
    // collapses to ΔE 0.002 under deuteranopia).
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
    "overlay-hover": "rgba(51,49,61,0.08)",
    // Derived 3% is sub-threshold over near-white surfaces.
    "overlay-soft": "rgba(51,49,61,0.055)",
    // Opaque elevate-to-select for menu/palette rows on white popovers; kept
    // in the lavender family so a selected row reads as the same material,
    // not a gray slab.
    "overlay-raised": "#EAE8F0",
    // The engine's pr-merged purple (#7544CC) sits ΔE 0.045 from hokkaido's
    // violet accent — a merged badge would read as a second accent signal.
    // Shift it to plum (h322, ΔE 0.125 from the accent, 6.2:1 on the panel)
    // and re-ink the draft slate onto the field temperature.
    "pr-draft": "#5E5A6E",
    "pr-merged": "#8A3D96",
    "scrollbar-thumb": "#6A7290",
    "scrollbar-thumb-hover": "color-mix(in oklab, #6A7290 85%, #282630)",
    // Engine light scrims (0.22/0.36/0.55) read as a storm front here.
    "scrim-soft": "rgba(51,49,61,0.16)",
    "scrim-medium": "rgba(51,49,61,0.28)",
    "scrim-strong": "rgba(51,49,61,0.46)",
    "search-highlight-background": "rgba(58,111,192,0.22)",
    "search-highlight-text": "#27539A",
    "search-match-badge-background": "rgba(58,111,192,0.22)",
    "search-match-badge-text": "#27539A",
    "search-selected-result-border": "#3A6FC0",
    "search-selected-result-icon": "#27539A",
    // Two-layer contact+spread in the violet ink; the engine "light" single
    // penumbra has no contact edge on a near-white field.
    "shadow-ambient": "0 1px 2px rgba(43,41,55,0.10), 0 6px 16px rgba(43,41,55,0.10)",
    // Dialogs sit a full z-tier above menus/popovers (the floating fallback
    // would give a centered modal the same shadow as a context menu).
    "shadow-dialog": "0 2px 6px rgba(43,41,55,0.10), 0 24px 60px rgba(43,41,55,0.18)",
    "shadow-floating": "0 1px 3px rgba(43,41,55,0.12), 0 12px 32px rgba(43,41,55,0.14)",
    // The engine's rgba(0,0,0,0.12) shadow ink is off-temperature on the
    // lavender field; dock-shadow re-alphas these channels via rgb(from ...).
    "shadow-color": "rgba(43,41,55,0.12)",
    // In-card chips: a lavender-stone inset one quiet step below the white
    // card, not a recessed slab (the old #CECBDD sat two registers down and
    // read as grime).
    "surface-inset": "#F3F1F9",
    // Inputs are raised on light, never recessed (overrides the engine's
    // recessed derivation; promote to the engine once the light family is
    // rebuilt from Bondi).
    "surface-input": "#FCFBFF",
    // Snow chrome: the frame (toolbar/dock/panel caps/dialog headers) carries
    // Hokkaido's lavender note at whisper chroma (H~294), one register apart
    // from the field surfaces rather than a darker slab.
    "surface-toolbar": "#EDECF2",
    "terminal-bright-black": "#6A708C",
    "terminal-white": "#E2E8F4",
    "text-link": "#574EC0",
    // 4.3:1 on the raised input (0.55 sat at 3.8:1 and fell away).
    "text-placeholder": "rgba(40,38,48,0.62)",
  },
  extensions: {
    "dock-bg": "#EDECF2",
    "dock-input-bg": "#FCFBFF",
    // Registry format guard: shadow-color channels, alpha ≥ 0.25.
    "dock-shadow": "0 -2px 8px rgb(from var(--theme-shadow-color) r g b / 0.25)",
    // Panel title bars join the snow chrome; the focused pane's cap brightens.
    "panel-header-bg": "#EFEEF3",
    "panel-header-focus-bg": "#F5F4F8",
    // Emoji tiles get a white-gloss lift instead of the dark-theme black wash
    // (which rendered murky gray chips on the light field).
    "project-tile-wash":
      "linear-gradient(to bottom, rgba(255,255,255,0.40), rgba(255,255,255,0.10))",
    "project-tile-shadow": "inset 0 1px 1px rgba(43,41,55,0.10), 0 0 0 1px rgba(43,41,55,0.10)",
    "pulse-before-bg": "#D9D5E8",
    "pulse-card-bg": "#FFFFFF",
    "pulse-card-header-bg": "#F7F6FB",
    "pulse-card-shadow": "0 1px 2px rgba(43,41,55,0.10), 0 4px 10px rgba(43,41,55,0.08)",
    "pulse-control-hover-bg": "rgba(51,49,61,0.05)",
    "pulse-empty-bg": "#F1F0F7",
    "pulse-heat-high-opacity": "0.85",
    "pulse-heat-low-opacity": "0.38",
    "pulse-heat-medium-opacity": "0.62",
    "pulse-heat-color": "#2C7458",
    // Opaque so the streak-break signal clears the 3:1 graphical floor.
    "pulse-missed-bg": "#BE3C48",
    "pulse-range-bg": "#F1F0F7",
    "pulse-ring-offset": "#FFFFFF",
    "pulse-skeleton-gradient": "linear-gradient(90deg, #D9D5E8 25%, #F1F0F7 50%, #D9D5E8 75%)",
    "dialog-header-bg": "#F9F8FD",
    "review-commit-input-bg": "#FCFBFF",
    "settings-kbd-bg": "#F3F1F9",
    "settings-kbd-border": "#D3CFDD",
    // Nav selection elevates to white + the 2px accent marker; the inherited
    // overlay-raised darker-lift is for menu rows on white popovers only.
    "settings-nav-active-bg": "#FFFFFF",
    // Flat like the dark themes: the white fill + 2px accent marker carry
    // selection, no ring or shadow.
    "settings-nav-active-shadow": "none",
    "settings-nav-hover-bg": "rgba(56,52,82,0.05)",
    // Scope pill elevates to white on the tinted settings sidebar.
    "settings-scope-bg": "#FFFFFF",
    "settings-sidebar-bg": "rgba(234,233,242,0.60)",
    "sidebar-action-hover-bg": "rgba(56,52,82,0.05)",
    // Worktree cards are paper highlights on the snow field; hover brightens
    // toward white; selected is pure white + the accent rail.
    // idle < hover < selected is audit-enforced; the old ladder ran hover
    // BELOW the idle card's natural plane — these sit ~1.6 OKLab points
    // apart. Soft contact shadow only — no ring: the card must not read as
    // bordered (selection = bg + right accent border).
    "sidebar-card-bg": "#F4F2FA",
    "sidebar-card-shadow": "0 1px 2px rgba(43,40,58,0.05)",
    "sidebar-active-bg": "#FFFFFF",
    "sidebar-hover-bg": "#F9F8FC",
    "toolbar-agent-hover-bg": "rgba(40,38,48,0.06)",
    "toolbar-control-hover-bg": "rgba(40,38,48,0.06)",
    // Accent restraint: hover affordance is the bg, not a violet foreground.
    "toolbar-control-hover-fg": "#282630",
    "toolbar-control-hover-shadow": "none",
    "toolbar-divider": "rgba(211,207,221,0.7)",
    "toolbar-pill-radius": "0.5rem",
    // One dawn-pink whisper on the project pill — the sunrise from the hero
    // shot; everything else quiet ink. Pills sit LIGHTER than the chrome
    // strip (raised, like all content).
    "toolbar-project-bg":
      "linear-gradient(180deg, rgba(226,139,177,0.08), rgba(40,38,48,0.02)), #F8F7FB",
    "toolbar-project-border": "rgba(211,207,221,0.75)",
    "toolbar-project-chip-bg": "rgba(40,38,48,0.04)",
    "toolbar-project-chip-border": "rgba(211,207,221,0.75)",
    "toolbar-project-shadow": "inset 0 1px 0 rgba(255,255,255,0.5)",
    "toolbar-shadow": "0 1px 2px rgba(43,41,55,0.06)",
    "toolbar-stats-bg": "#F8F7FB",
    "toolbar-stats-border": "rgba(211,207,221,0.7)",
    "toolbar-stats-divider": "rgba(211,207,221,0.7)",
    "toolbar-stats-hover-bg": "#FBFAFD",
    // Filter rail sits flush on the field; the raised search input carries it.
    "worktree-filter-bar-bg": "#EAE9F2",
    // Active quick-state tab lifts to white under its inset underline.
    "worktree-quick-state-active-bg": "#FFFFFF",
    "worktree-search-input-bg": "#FCFBFF",
    "worktree-section-hover-bg": "rgba(56,52,82,0.05)",
  },
};
