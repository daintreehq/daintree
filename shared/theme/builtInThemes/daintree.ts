import type { BuiltInThemeSource } from "../builtInThemeSources.js";

export const theme: BuiltInThemeSource = {
  id: "daintree",
  name: "Daintree",
  type: "dark",
  builtin: true,
  location: "Daintree Rainforest, Queensland, Australia",
  heroImage: "/themes/daintree.webp",
  palette: {
    type: "dark",
    surfaces: {
      // Neutral-earthy charcoal by design: biome green lives in accent, focus
      // light, and data lanes only — never the field.
      //
      // Two properties are load-bearing and easy to undo by accident.
      //
      // ONE HUE FAMILY. Every rung sits on the same warm axis. The ladder used
      // to change family halfway up — grid and sidebar at OKLCH H 107, then
      // canvas, panel and elevated at H 286, three stock Tailwind zincs — so
      // the five planes were two different neutrals glued together.
      //
      // CAST ON THE SHELL, NOT ON THE WORK. A smoked umber (H ~48) at C 0.008
      // in the grid, 0.005 in the sidebar, tapering to ~0.002 by canvas: the
      // structural planes carry the character, the surfaces you actually read
      // on stay neutral. Hue matters as much as amount. H 48 is ~115° from the
      // accent's H 162.5, so the field moves AWAY from `#36CE94` and buys it
      // 1.8-3.1% more chroma-plane separation. An olive field (H ~105) was
      // tried first: it cost the accent 2.9-3.7% and turned the whole app
      // olive, because the cast was not confined to the shell.
      //
      // The lightness ladder is 0.163 / 0.185 / 0.214 / 0.240 / 0.289 in OKLab
      // L — steps .022 .029 .026 .048, ratio 2.19. canvas→panel used to be
      // .017, under the engine's own .02 JND, so panel cards did not lift off
      // the canvas at all and the ramp ratio ran to 3.37 against a limit of 3.
      // Both audits are warn-only on dark, so that shipped green for a long
      // time. Keep every adjacent step above .02.
      grid: "#110d0b",
      sidebar: "#151211",
      canvas: "#1a1918",
      panel: "#201f1f",
      elevated: "#2b2b2a",
    },
    text: {
      primary: "#e4e4e7",
      secondary: "#a1a1aa",
      muted: "#8a8a93",
      inverse: "#1a1918",
    },
    border: "#292828",
    accent: "#36CE94",
    accentSecondary: "#6B8D72",
    status: {
      success: "#6B8D72",
      warning: "#C59A4E",
      danger: "#C8746C",
      info: "#7B8C96",
    },
    activity: {
      active: "#2EB37C",
      // Idle carries the surface's own warm-neutral cast (H ~107, C 0.008), not
      // a cool zinc. It is field chrome — it also derives the scrollbar thumb
      // and the diff omit-gutter — so it belongs to the ladder's hue family,
      // and biome green stays out of the field per the note on `surfaces`.
      idle: "#585853",
      working: "#2EB37C",
      waiting: "#fbbf24",
    },
    overlayTint: "#D4E8DD",
    // Terminal background intentionally unset — inherits the canvas. Every
    // legibility-bearing ANSI slot holds dL ≥ 0.18 on #1a1918 and base-vs-bright
    // ΔE ≥ 0.03; `black` is exempt by design (it derives to the background and
    // doubles as hidden text, so the validator skips it).
    terminal: {
      // Selection is a fill, not a glyph: 1.41:1 on the terminal background puts
      // it in the cohort's visible band (arashiyama 1.41, highlands 1.42) while
      // foreground text over it still clears 9.8:1.
      selection: "#22392c",
      red: "#e07a70",
      green: "#2fbf85",
      yellow: "#ECB23F",
      blue: "#5fb3e8",
      magenta: "#bf93ec",
      cyan: "#4fc8d8",
      brightRed: "#eb9a91",
      brightGreen: "#5bd6a4",
      brightYellow: "#ecc777",
      brightBlue: "#93cdf0",
      brightMagenta: "#d4b0f2",
      brightCyan: "#86dde2",
      brightWhite: "#fafafa",
    },
    // All roles ≥ 4.5:1 on canvas except the soft-floor (3.0:1) comment/quote pair.
    syntax: {
      comment: "#74807a",
      punctuation: "#ccd6cf",
      number: "#e2b369",
      string: "#95c879",
      operator: "#8acfd6",
      keyword: "#c89ce8",
      function: "#6fb7e8",
      link: "#5fb8e4",
      quote: "#a9b4ac",
      chip: "#7fd4cf",
    },
    strategy: {
      shadowStyle: "atmospheric",
      // noiseOpacity deliberately omitted. Setting it emits a single
      // `radial-gradient(circle at 20% 20%, …)` chrome sheen, which bands across
      // a surface as wide as the toolbar. Omitting it resolves
      // `chrome-noise-texture` to `none`; the tiling `grainCharacter` below is
      // what actually carries this theme's texture.
      materialBlur: 16,
      materialSaturation: 115,
      grainCharacter: "paper",
    },
  },
  tokens: {
    "focus-ring": "rgba(54,206,148,0.55)",
    "search-highlight-background": "rgba(54,206,148,0.20)",
    "search-highlight-text": "#36CE94",
    "search-match-badge-background": "rgba(54,206,148,0.20)",
    "search-match-badge-text": "#36CE94",
    "search-selected-result-border": "rgba(54,206,148,0.30)",
    "search-selected-result-icon": "#36CE94",
    "surface-toolbar": "#151211",
    // ANSI 90 is the conventional dim slot for hints, timestamps and secondary
    // output — it is read as body text, so it owes AA. 4.55:1 on the terminal
    // background, and still 3.0x quieter than the foreground's 13.85:1, so it
    // reads de-emphasized rather than merely dark. Split out of `activity.idle`
    // (which it used to inherit at 2.27:1) because a quiet idle dot and legible
    // dim text are different jobs.
    "terminal-bright-black": "#82827c",
    // Forge metadata, re-cut off GitHub's brand hexes and into this palette.
    // The engine defaults (#3fb950 / #a371f7 / #f85149 / #8b949e) put a fourth
    // green and a neon red into resting toolbar chrome. All four now land in a
    // 5.7-6.2:1 band on `surface-panel`: above the muted-text floor, below
    // `text-secondary` (6.57:1), so a forge chip is never louder than the prose
    // it annotates — and far below the waiting signal at 10.09:1.
    "pr-open": "#5FA47F",
    "pr-merged": "#AE8ED6",
    "pr-closed": "#D0827A",
    "pr-draft": "#9A9A94",
    // Green-black shadow/scrim ink; keep C ≤ ~0.02 or the fog reads as a
    // colored glow instead of air.
    "shadow-color": "rgba(6,11,8,0.55)",
    "shadow-ambient": "0 4px 16px rgba(5,10,7,0.18)",
    "shadow-floating": "0 14px 40px rgba(5,10,7,0.30)",
    "shadow-dialog": "0 20px 56px rgba(5,10,7,0.36)",
    "scrim-soft": "rgba(6,11,8,0.22)",
    "scrim-medium": "rgba(6,11,8,0.46)",
    "scrim-strong": "rgba(6,11,8,0.64)",
    "scrim-blur": "18px",
    "grain-opacity": "0.03",
  },
  extensions: {
    "pulse-before-bg": "#181616",
    "pulse-card-bg": "#201f1f",
    "pulse-card-shadow": "0 1px 3px rgba(5,10,7,0.40)",
    "pulse-control-hover-bg": "rgba(255,255,255,0.05)",
    "pulse-empty-bg": "#252424",
    // Glow-worm heat ramp: opaque stops, level 4 = accent (a data lane, outside
    // the accent budget); level 1 must stay ≥ JND above the empty cell.
    "pulse-heat-color": "#36CE94",
    "pulse-heat-1": "#23402f",
    "pulse-heat-2": "#2b6243",
    "pulse-heat-3": "#319966",
    "pulse-heat-4": "#36CE94",
    "pulse-range-bg": "#1a1918",
    "pulse-ring-offset": "#201f1f",
    "pulse-skeleton-gradient": "linear-gradient(90deg, #2b2b2a 25%, #313130 50%, #2b2b2a 75%)",
    "dock-bg": "#151211",
    "settings-dialog-bg": "#201f1f",
    "settings-card-bg": "#252424",
    "settings-list-item-bg": "#252424",
    // rgb(19,19,18) = the sidebar surface; keep in lockstep with surfaces.sidebar.
    "dialog-header-bg": "rgba(21,18,17,0.60)",
    "settings-kbd-bg": "#1A1918",
    "settings-nav-active-bg": "rgba(54,206,148,0.10)",
    "settings-nav-active-shadow": "none",
    "settings-nav-hover-bg": "rgba(255,255,255,0.03)",
    "settings-search-bg": "#1A1918",
    "settings-search-muted": "#a1a1aa",
    "settings-sidebar-bg": "rgba(21,18,17,0.50)",
    // Composited settings-sidebar-bg over the shell.
    "settings-sidebar-scroll-fade": "#1b1918",
    "sidebar-action-hover-bg": "rgba(255,255,255,0.05)",
    "sidebar-active-bg": "rgba(255,255,255,0.065)",
    "sidebar-hover-bg": "rgba(255,255,255,0.048)",
    // No panel-focus overrides: the default theme keeps the app's stock focus
    // chrome by design.
    "toolbar-agent-hover-bg": "rgba(255,255,255,0.06)",
    "toolbar-control-active-bg": "rgba(255,255,255,0.14)",
    "toolbar-control-armed-bg": "rgba(255,255,255,0.14)",
    "toolbar-control-armed-shadow": "inset 0 0 0 1px rgba(255,255,255,0.12)",
    "toolbar-control-hover-bg": "rgba(255,255,255,0.10)",
    "toolbar-divider": "rgba(41,40,40,0.5)",
    // Neutral white top-light, deliberately very subtle — don't re-tint it green.
    "toolbar-project-bg":
      "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0) 70%), rgba(255,255,255,0.03)",
    "toolbar-project-border": "rgba(41,40,40,0.5)",
    "toolbar-project-chip-bg": "rgba(255,255,255,0.05)",
    "toolbar-project-chip-border": "rgba(41,40,40,0.6)",
    "toolbar-project-meta-fg": "#a1a1aa",
    "toolbar-project-shadow": "inset 0 1px 0 rgba(255,255,255,0.06)",
    "toolbar-stats-bg": "rgba(255,255,255,0.05)",
    "toolbar-stats-border": "rgba(41,40,40,0.5)",
    "toolbar-stats-divider": "rgba(41,40,40,0.5)",
    "toolbar-stats-hover-bg": "rgba(255,255,255,0.10)",
  },
};
