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
    // Redesign r3 (#9711): white cards on pale sky. The r2 ramp held one hue but
    // translated the dark theme's "chips recede" idiom as darker-than-surface
    // gray slabs — on light that reads as mud. r3 inverts the on-surface
    // language: the field (grid/sidebar) is a genuinely chromatic Bondi sky
    // (C 0.020-0.021), and everything that carries content (cards, chips,
    // inputs, selection) lifts TOWARD white instead of receding into gray.
    // Ramp L 0.916 / 0.937 / 0.957 / 0.979 / 1.0 — steps 0.0205-0.0219 (all
    // ≥ 0.02), span 0.084, panel→elevated not the smallest step. Elevated is
    // pure white (C = 0, achromatic — sea foam) so the hue family stays clean.
    surfaces: {
      grid: "#D9E5F0",
      sidebar: "#DFECF8",
      canvas: "#EAF2FA",
      panel: "#F3F9FF",
      elevated: "#FFFFFF",
    },
    text: {
      primary: "#1C2028",
      secondary: "#48535F",
      muted: "#5F6A76",
      inverse: "#FDFDFE",
    },
    // Hairline re-pinned to the unified H248 sky hue (the r2 border drifted to
    // H251). With cards carrying figure-ground, the border is a quiet seam.
    border: "#CBD4DD",
    accent: "#178463",
    accentSecondary: "#0A7E8C",
    // r3: success freshened from the r2 forest #216E3E — that darkening was
    // tuned for numerals on the old recessed #D5DDE7 wells. On the lifted
    // near-white chips a lighter eucalyptus reads sunny and still clears AA
    // everywhere it renders as text (4.77:1 on the deepest chip #EFF5FB,
    // 4.94:1 on cards, 5.24:1 on white). warning darkened one notch so the
    // amber numeral clears 4.5:1 on cards (was 4.19).
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
      // Bondi shallow-water cyan-blue: the dark terminal's ANSI ramp reads
      // gold/cyan/green — sun, water, eucalyptus.
      blue: "#37A6D9",
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
      // Deeper orchid keyword sits inside the marine family instead of
      // fighting it (AA-clear on the light panel).
      keyword: "#6A3FB0",
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
    // The derived 3% soft fill is sub-threshold over the near-white
    // palette/list surfaces; 5.5% keeps the same ink, just visible.
    "overlay-soft": "rgba(22,52,71,0.055)",
    // r3: hue-true elevate-to-select. The r2 value mixed elevated toward
    // text-primary and composited to a dead neutral gray (~#DBDCDD, C 0.003)
    // — a gray patch on the chroma-held sky reads as grime. Same lift,
    // pinned to the sky family instead (L 0.945, C 0.014, H 248).
    "overlay-raised": "#E6EEF6",
    // pr-merged/pr-draft: GitHub-brand defaults fail AA on bondi's near-white
    // panel; darkened in L only (hue preserved).
    "pr-merged": "#7644CC",
    "pr-draft": "#646B73",
    // r3: scrollbar re-pinned from the neutral gray #6F757E onto the sky hue
    // (H 248, same L band) — clears the 3:1 graphical floor on every surface.
    "scrollbar-thumb": "#6A7787",
    "scrollbar-thumb-hover": "color-mix(in oklab, #6A7787 85%, #1C2028)",
    // r3: sunnier scrims. The engine's hued defaults (overlayBase at
    // 0.22/0.36/0.55) read as a storm front over a near-white workbench;
    // same slate ink, lighter hand.
    "scrim-soft": "rgba(22,52,71,0.16)",
    "scrim-medium": "rgba(22,52,71,0.28)",
    "scrim-strong": "rgba(22,52,71,0.46)",
    "search-highlight-background": "rgba(35,94,150,0.14)",
    "search-highlight-text": "#235E96",
    "search-match-badge-background": "rgba(35,94,150,0.14)",
    "search-match-badge-text": "#235E96",
    "search-selected-result-border": "rgba(35,94,150,0.34)",
    "search-selected-result-icon": "#235E96",
    // Two-layer contact+spread stacks in the theme's own ink give
    // menus/popovers a defined edge over the near-white field.
    "shadow-ambient": "0 1px 2px rgba(23,33,48,0.10), 0 6px 16px rgba(23,33,48,0.10)",
    "shadow-floating": "0 1px 3px rgba(23,33,48,0.12), 0 12px 32px rgba(23,33,48,0.14)",
    // r3: surface-inset flipped from the recessed #D5DDE7 slab (L 0.894 —
    // BELOW the grid floor, the single muddiest value in r2) to a lifted
    // sky-tinted inset (L 0.967). In-card chips now read as quiet frosted
    // wells one step below their white card, not gray boxes painted on it.
    "surface-inset": "#EFF5FB",
    // r3: inputs are raised, not recessed — the brief explicitly rejects the
    // darker-text-input idiom. Near-white with a sky whisper; the hairline
    // border carries the field boundary. (Engine still derives light inputs
    // recessed; Bondi overrides at the theme layer as the gold standard —
    // promote to the engine once the light family is rebuilt from Bondi.)
    "surface-input": "#F9FCFF",
    // r3: neutral chrome strip — the header read "too blue" with the sidebar
    // tone; the toolbar drops to a whisper of the sky hue (C 0.003) so the
    // color lives in the field and content, not the chrome.
    "surface-toolbar": "#ECEEF0",
    "terminal-bright-black": "#525D69",
    "terminal-white": "#C8D0D9",
    "text-link": "#0F5B41",
    // r3: softened for the raised near-white input (composites to exactly
    // 3.1:1 — the engine's 0.58 was tuned for the old recessed well).
    "text-placeholder": "rgba(28,32,40,0.52)",
  },
  extensions: {
    // Dock tracks the neutral toolbar chrome; shadow softened from the 0.35
    // global fallback (registry format: shadow-color channels, alpha ≥ 0.25).
    "dock-bg": "#ECEEF0",
    "dock-shadow": "0 -2px 8px rgb(from var(--theme-shadow-color) r g b / 0.25)",
    // Gutter sits exactly at the grid floor — one sky tone, no third band.
    "panel-grid-bg": "#D9E5F0",
    "pulse-before-bg": "#D9E5F0",
    "pulse-card-bg": "#FFFFFF",
    // Deliberate quiet sky header band on the white card (the fallback is
    // transparent; an explicit in-family band keeps the card structured).
    "pulse-card-header-bg": "#F7FBFF",
    "pulse-card-shadow": "0 1px 2px rgba(23,33,48,0.10), 0 4px 10px rgba(23,33,48,0.08)",
    "pulse-control-hover-bg": "rgba(22,52,71,0.05)",
    "pulse-empty-bg": "#EAF2FA",
    "pulse-heat-high-opacity": "0.85",
    "pulse-heat-low-opacity": "0.38",
    "pulse-heat-medium-opacity": "0.62",
    "pulse-heat-color": "#0A7E8C",
    // Opaque status-danger so the streak-break signal clears the 3:1 floor.
    "pulse-missed-bg": "#A83C34",
    "pulse-range-bg": "#EAF2FA",
    "pulse-ring-offset": "#FFFFFF",
    "pulse-skeleton-gradient": "linear-gradient(90deg, #D9E5F0 25%, #EAF2FA 50%, #D9E5F0 75%)",
    // Solid header a hair above the dialog body; settings cards/list inherit
    // the engine defaults (body = panel, cards = elevated white).
    "dialog-header-bg": "#F7FBFF",
    "settings-kbd-bg": "#EAF2FA",
    "settings-kbd-border": "#CBD4DD",
    // r3: selected settings-nav row elevates to white + the 2px accent
    // marker (the inherited overlay-raised fill is a darker lift — correct
    // for menu rows on white popovers, wrong for nav selection on the tinted
    // settings sidebar).
    "settings-nav-active-bg": "#FFFFFF",
    "settings-nav-active-shadow": "0 0 0 1px rgba(28,38,50,0.08), 0 1px 2px rgba(23,33,48,0.05)",
    "settings-nav-hover-bg": "rgba(22,52,71,0.05)",
    "settings-sidebar-bg": "rgba(243,249,255,0.60)",
    "sidebar-action-hover-bg": "rgba(22,52,71,0.05)",
    // r3: white cards on pale sky. Idle worktree cards lift to the panel
    // plane with a hairline ring + contact shadow; hover brightens; the
    // selected card reaches pure white. The sidebar field shows through the
    // gaps as genuine Bondi sky, and status colors finally pop on white.
    "sidebar-card-bg": "#F3F9FF",
    "sidebar-card-shadow": "0 0 0 1px rgba(28,38,50,0.08), 0 1px 2px rgba(23,33,48,0.05)",
    "sidebar-active-bg": "#FFFFFF",
    "sidebar-hover-bg": "#FAFBFC",
    "toolbar-agent-hover-bg": "rgba(28,32,40,0.06)",
    "toolbar-control-hover-bg": "rgba(28,32,40,0.06)",
    // Neutral hover foreground (accent restraint); the hover affordance is
    // carried by toolbar-control-hover-bg.
    "toolbar-control-hover-fg": "#1C2028",
    "toolbar-control-hover-shadow": "none",
    "toolbar-divider": "rgba(203,212,221,0.6)",
    "toolbar-pill-radius": "0.5rem",
    // r3: neutral chrome pills — the r2 info-blue washes plus the sky
    // gradient made the whole header read blue. One whisper of lifeguard
    // gold survives on the project pill; everything else is quiet ink.
    "toolbar-project-bg":
      "linear-gradient(180deg, rgba(245,184,20,0.04), rgba(28,32,40,0.02)), #F2F4F6",
    "toolbar-project-border": "rgba(203,212,221,0.7)",
    "toolbar-project-chip-bg": "rgba(28,32,40,0.04)",
    "toolbar-project-chip-border": "rgba(203,212,221,0.7)",
    "toolbar-project-shadow": "inset 0 1px 0 rgba(255,255,255,0.5)",
    // Hairline drop so the chrome strip separates from the canvas.
    "toolbar-shadow": "0 1px 2px rgba(23,33,48,0.06)",
    "toolbar-stats-bg": "rgba(28,32,40,0.04)",
    "toolbar-stats-border": "rgba(203,212,221,0.6)",
    "toolbar-stats-divider": "rgba(203,212,221,0.6)",
    "toolbar-stats-hover-bg": "rgba(28,32,40,0.065)",
    // r3: the filter/search rail sits flush on the sky field (the r2 band
    // recessed BELOW the grid floor — the darkest region in the sidebar).
    // The raised white search input carries the rail now.
    "worktree-filter-bar-bg": "#DFECF8",
    "worktree-search-input-bg": "#F9FCFF",
    "worktree-section-hover-bg": "rgba(22,52,71,0.05)",
  },
};
