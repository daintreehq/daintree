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
    // One cream family, hue 81. The lightness of every tier is deliberately
    // unchanged from the theme this replaces — only hue and chroma move
    // (94 -> 81, grid C 0.019 -> 0.027), so the app gets warmer without getting
    // darker and body-text contrast is preserved to within 0.01 everywhere.
    // Chroma is also carried further up the ladder than before (panel 0.0090 vs
    // 0.0067) so the warmth survives into the content tiers instead of fading to
    // neutral white; `elevated` stays pure white because the top tier's job is
    // maximum lift for popovers.
    //
    // The grid -> sidebar step is 2.7x the others. That is intentional and
    // inherited: the grid is the gutter the panels sit in and wants to be
    // clearly below them. Evening the ramp out costs perceived lightness on the
    // three tiers you actually read on, which is a bad trade.
    // Water is a highlight only (accent, links, focus, heat ramp, terminal),
    // never a field surface: a blue plane at this lightness reads as nursery,
    // not ocean.
    surfaces: {
      grid: "#E1D7C5",
      sidebar: "#F2E9DA",
      canvas: "#F7F1E7",
      panel: "#FBF8F2",
      elevated: "#FFFFFF",
    },
    text: {
      // Cool ink against warm paper — the counterpoint that stops cream from
      // going sepia. muted ≥ 4.9:1 on every surface.
      primary: "#1C2028",
      secondary: "#454D56",
      muted: "#555B62",
      inverse: "#FDFDFE",
    },
    // Deepened from the 1.59:1-on-white it had been: on a light theme the border
    // is the main definition channel, and a hairline that faint let panel
    // headers and controls dissolve into the surfaces behind them.
    border: "#CFC7B8",
    // Deep water. Dark enough to carry near-white CTA text at 9:1, and far
    // enough from svalbard's arctic blue (ΔE 0.14) that the two cool light
    // themes stop reading as siblings — the previous accent was ΔE 0.04 from
    // bali's green and, worse, ΔE 0.03 from this theme's own "agent working".
    accent: "#004E6B",
    // Deep seagrass, not a second blue. `auditCrossThemeAccents` only compares
    // primary-to-primary, so the previous secondary sat DeltaE 0.041 from
    // svalbard's PRIMARY unreported; this clears it at 0.133 and also clears
    // status.info (0.125) and status.success (0.100).
    accentSecondary: "#0C5D55",
    // Status colors render as text — every one clears 3:1 on all five surfaces.
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
      // Deeper than status.warning: on a light field loudness is depth, so
      // waiting has to out-weigh a warning rather than tie with it.
      waiting: "#8F6100",
    },
    // Warm ink: a cool overlay tint reads as grime on the cream field.
    overlayTint: "#322E26",
    terminal: {
      // Deep water rather than slate — the ANSI ramp gains margin on every
      // slot against it (worst dL 0.296 vs 0.285 on the old background).
      background: "#16242B",
      foreground: "#C8D0D9",
      // 3.47:1 on the terminal background.
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
      // Links join the water family rather than sitting in the success green.
      link: "#005F77",
      quote: "#5A6878",
      chip: "#0C5D55",
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
    "accent-muted": "rgba(0,78,107,0.30)",
    // Bondi's selection vocabulary is "elevate to white, mark with a rail" — it
    // never fills with accent. `accent-soft`'s single consumer is QuickRun's
    // selected autocomplete row, where the derived blue composited to #D6E3E7:
    // a pale blue field, which is exactly what this palette must not produce.
    // Warm raised tint instead, matching `overlay-raised`.
    "accent-soft": "rgba(174,136,68,0.16)",
    // Alpha baked into the tile — the token replaces the engine value wholesale.
    // `--color-category-*-text` is the base mixed 85% toward text-primary and
    // painted on a 12-20% tint of the same base (src/index.css). Five of the
    // twelve engine defaults land at 3.97-4.36:1 on that pill — under AA for
    // small labels — and orange clears AA at 4.55 but sits on the line. The
    // contrast matrix skips all of them because their values are oklch().
    // These six are the darkest lightness clearing 4.55:1 in BOTH the
    // canvas/12% and elevated/20% compositions; the other six already pass.
    "category-blue": "oklch(0.53 0.14 242)",
    "category-cyan": "oklch(0.52 0.11 198)",
    "category-green": "oklch(0.5 0.14 155)",
    "category-amber": "oklch(0.545 0.15 65)",
    "category-orange": "oklch(0.555 0.16 38)",
    "category-teal": "oklch(0.51 0.12 178)",
    "chrome-noise-texture":
      "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='sand'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23sand)' opacity='0.018'/%3E%3C/svg%3E\"), radial-gradient(circle at 78% 115%, rgb(15 20 28 / 0.02), transparent 60%)",
    "focus-ring": "rgba(0,78,107,0.38)",
    // The engine derives this as status-info mixed 90% toward black, landing at
    // #19608B — DeltaE 0.073 from the accent, on persistent dots and rails in
    // Settings where accent markers also live. Mixing toward white instead
    // keeps the conventional "modified" blue and clears the accent at 0.160.
    // Must stay in color-mix() form; a plain hex fails builtInThemes.test.ts.
    "state-modified": "color-mix(in oklab, #1E6FA0 92%, #FFFFFF)",
    "grain-opacity": "0.03",
    "overlay-hover": "rgba(50,46,38,0.08)",
    // Derived 3% is sub-threshold over near-white surfaces.
    "overlay-soft": "rgba(50,46,38,0.055)",
    // Opaque elevate-to-select for menu/palette rows on white popovers.
    "overlay-raised": "#F6F0E7",
    // Deliberate hue choices, kept from the previous palette. Note this is no
    // longer an AA repair: the current engine defaults (#7544CC / #5C6571)
    // score 6.08:1 and 5.91:1 on white.
    "pr-merged": "#7644CC",
    "pr-draft": "#646B73",
    "scrollbar-thumb": "#857F77",
    "scrollbar-thumb-hover": "color-mix(in oklab, #857F77 85%, #1C2028)",
    "scrim-soft": "rgba(50,46,38,0.16)",
    "scrim-medium": "rgba(50,46,38,0.28)",
    "scrim-strong": "rgba(50,46,38,0.46)",
    "scrim-blur": "16px",
    // Never set before, so `dock-shadow` (which extracts shadow-color channels)
    // was casting pure black while every authored shadow here uses warm ink.
    "shadow-color": "rgba(43,38,31,0.12)",
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
    "surface-inset": "#F7F2EA",
    // Inputs are raised on light, never recessed (overrides the engine's
    // recessed derivation).
    "surface-input": "#FDFBF7",
    "surface-toolbar": "#F3ECE0",
    // Dim tier floor: ≥ 3:1 on the terminal background.
    "terminal-bright-black": "#66727F",
    "terminal-white": "#C8D0D9",
    "text-link": "#105269",
    // Placeholders render on more than the input surface — real consumers also
    // sit on the canvas, sidebar and grid. The previous 0.60 scored 4.10-4.36:1
    // there; 0.62 still missed on three of six. 0.66 is the first value that
    // clears AA on every background it actually paints on (4.57-5.27:1). The
    // contrast matrix only enforces 3:1 here, so this passed silently.
    "text-placeholder": "rgba(28,32,40,0.66)",
  },
  extensions: {
    "dock-bg": "#F3ECE0",
    "dock-input-bg": "#FDFBF7",
    // Lifts to white; the accent hairline border fallback stays as the one
    // signal, matching the worktree-card white-plus-rail idiom.
    "dock-item-bg-active": "#FFFFFF",
    // Registry format guard: shadow-color channels, alpha ≥ 0.25.
    "dock-shadow": "0 -2px 8px rgb(from var(--theme-shadow-color) r g b / 0.25)",
    // Panel title bars sit clearly between the grid gutter and the panel body
    // (dL 0.043 above the gutter, 0.053 below it). They previously landed at the
    // same lightness as the gutter, so an unfocused pane's cap dissolved into
    // the grid behind it and the panel lost its top edge. The focused pane's cap
    // goes all the way to white.
    "panel-header-bg": "#EDE5D8",
    "panel-header-focus-bg": "#FFFFFF",
    // Warm ink only, never accent — the white-card-plus-rail selection stays
    // the region's one accent signal. Selected and focused share this border.
    "panel-focus-border": "rgba(43,38,31,0.50)",
    "panel-focus-shadow": "0 1px 2px rgba(43,38,31,0.12)",
    // The audited flat grid hex stays the final layer; surfaces.grid is
    // untouched so the ramp audit is unaffected.
    "panel-grid-bg": "linear-gradient(180deg, #E3D9C7 0%, #DFD4C1 100%), #E1D7C5",
    // White-gloss lift for emoji tiles (the dark wash renders murky on light).
    "project-tile-wash":
      "linear-gradient(to bottom, rgba(255,255,255,0.40), rgba(255,255,255,0.10))",
    "project-tile-shadow": "inset 0 1px 1px rgba(43,38,31,0.10), 0 0 0 1px rgba(44,39,31,0.10)",
    "pulse-before-bg": "#EDE5D8",
    "pulse-card-bg": "#FFFFFF",
    "pulse-card-header-bg": "#FCF9F5",
    "pulse-card-shadow": "0 1px 2px rgba(43,38,31,0.10), 0 4px 10px rgba(43,38,31,0.08)",
    "pulse-control-hover-bg": "rgba(50,46,38,0.05)",
    "pulse-empty-bg": "#F7F1E7",
    // Bathymetric ramp: dry sand → shallows → ocean → the accent itself. The
    // light end stays warm on purpose; a pale blue first step reads as nursery
    // against cream, which is the one thing this palette must not do.
    "pulse-heat-1": "#E3DCCD",
    "pulse-heat-2": "#AFC3C4",
    "pulse-heat-3": "#55879E",
    "pulse-heat-4": "#004E6B",
    "pulse-range-bg": "#F7F1E7",
    "pulse-ring-offset": "#FFFFFF",
    "pulse-skeleton-gradient": "linear-gradient(90deg, #E1D7C5 25%, #F6F1E8 50%, #E1D7C5 75%)",
    "dialog-header-bg": "#FCF9F5",
    "review-commit-input-bg": "#FDFBF7",
    "settings-kbd-bg": "#F7F2EA",
    "settings-kbd-border": "#CFC7B8",
    // Nav selection elevates to white + the 2px accent marker.
    "settings-nav-active-bg": "#FFFFFF",
    "settings-nav-active-shadow": "none",
    "settings-nav-hover-bg": "rgba(58,48,30,0.05)",
    // Scope pill elevates to white on the tinted settings sidebar.
    "settings-scope-bg": "#FFFFFF",
    "settings-sidebar-bg": "rgba(242,233,218,0.60)",
    // Composited settings-sidebar-bg over the shell (#F4EFE6 is the result over
    // white, which is not what it sits on).
    "settings-sidebar-scroll-fade": "#F7F2E9",
    "sidebar-action-hover-bg": "rgba(58,48,30,0.05)",
    // idle < hover < selected; only hover < selected is test-enforced, the rest
    // is held by hand. Contact shadow only, no ring —
    // selection = bg + right accent rail.
    "sidebar-card-bg": "#F7F2E9",
    "sidebar-card-shadow": "0 1px 2px rgba(48,40,28,0.05)",
    "sidebar-active-bg": "#FFFFFF",
    "sidebar-hover-bg": "#FBF8F3",
    "toolbar-agent-hover-bg": "rgba(28,32,40,0.06)",
    "toolbar-control-hover-bg": "rgba(28,32,40,0.06)",
    // Accent restraint: hover affordance is the bg, not an accent foreground.
    "toolbar-control-hover-fg": "#1C2028",
    "toolbar-control-hover-shadow": "none",
    "toolbar-divider": "rgba(207,199,184,0.7)",
    "toolbar-pill-radius": "0.5rem",
    // Pills sit lighter than the chrome strip (raised, like all content).
    "toolbar-project-bg":
      "linear-gradient(180deg, rgba(245,184,20,0.07), rgba(28,32,40,0.02)), #F6F0E7",
    "toolbar-project-border": "rgba(207,199,184,0.75)",
    "toolbar-project-chip-bg": "rgba(28,32,40,0.04)",
    "toolbar-project-chip-border": "rgba(207,199,184,0.75)",
    "toolbar-project-shadow": "inset 0 1px 0 rgba(255,255,255,0.5)",
    "toolbar-shadow": "0 1px 2px rgba(43,38,31,0.06)",
    "toolbar-stats-bg": "#F6F0E7",
    "toolbar-stats-border": "rgba(207,199,184,0.7)",
    "toolbar-stats-divider": "rgba(207,199,184,0.7)",
    "toolbar-stats-hover-bg": "#F9F4ED",
    // Filter rail sits flush on the field; the raised search input carries it.
    "worktree-filter-bar-bg": "#F2E9DA",
    // Active quick-state tab lifts to white under its inset underline.
    "worktree-quick-state-active-bg": "#FFFFFF",
    "worktree-search-input-bg": "#FDFBF7",
    "worktree-section-hover-bg": "rgba(58,48,30,0.05)",
  },
};
