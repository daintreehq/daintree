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
      // The understorey in shade: a moss-black field at OKLCH H ~122, sampled
      // off the hero's own darks (#1D2015 is H 120) rather than invented.
      //
      // The hue is also the theme's cohort address. The field used to be a
      // smoked umber at H 48, which is Redwoods' hue (H 48-61), while Galápagos
      // owns the green-teals (H 175-182). Moss sits between them and matches
      // the art in the theme picker.
      //
      // CAST ON THE SHELL, NOT ON THE WORK. C 0.011 in the grid and 0.010 in
      // the sidebar, tapering to ~0.006 on the planes you read on. An olive
      // cast carried at full strength across every rung is what makes a dark
      // UI read as dirty; confined to the shell it reads as shade.
      //
      // Lightness ladder in OKLab L: .164 / .192 / .220 / .250 / .292 — steps
      // .028 .028 .030 .042, every one above the engine's .02 JND. Both ramp
      // audits are warn-only on dark, so keep them there by hand.
      grid: "#0d0f0a",
      sidebar: "#131510",
      canvas: "#1a1b18",
      panel: "#21221f",
      elevated: "#2c2c29",
    },
    // Lichen, not zinc. The ramp shares the field's hue family at C ~0.011-0.016
    // so body copy stops reading cool against a warm-green field; stock zinc
    // (H 286) was the one cold family in the theme.
    text: {
      primary: "#dfe0d8",
      secondary: "#a5a89d",
      muted: "#93968b",
      inverse: "#1a1b18",
    },
    border: "#2d2e2a",
    accent: "#36CE94",
    accentSecondary: "#6B9571",
    status: {
      success: "#6B9571",
      // Weathered straw rather than stock amber: warning is an indicator and has
      // to stay well below the waiting signal, which shares its hue.
      warning: "#AD9561",
      danger: "#D3786D",
      info: "#7B8C96",
    },
    activity: {
      // Fern rather than the accent's own jade. A running process is live and
      // keeps its green, but at C 0.085 it no longer rivals the brand accent or
      // outshouts danger.
      active: "#69A178",
      // Field chrome — it also derives the scrollbar thumb and the diff
      // omit-gutter — so it carries the ladder's moss cast.
      idle: "#575954",
      working: "#69A178",
      waiting: "#fbbf24",
    },
    overlayTint: "#dfe0d8",
    // Terminal background intentionally unset — it inherits the canvas.
    //
    // Fern, straw, bark-red, river blue, orchid and creek teal: every slot keeps
    // its ANSI role but trades chroma (C 0.07-0.10) for a place in the palette.
    // Saturated terminal colour on a near-black field is where a dark theme
    // vibrates, and the terminal is most of the screen.
    terminal: {
      selection: "#22392c",
      red: "#d58679",
      green: "#85b476",
      yellow: "#d2b46a",
      blue: "#75adcd",
      magenta: "#bf94c0",
      cyan: "#76bab0",
      brightRed: "#e7a99e",
      brightGreen: "#a8ce9b",
      brightYellow: "#e5cf94",
      brightBlue: "#9cc8e3",
      brightMagenta: "#d7b3d8",
      brightCyan: "#9fd4cc",
      brightWhite: "#eeefe9",
    },
    syntax: {
      comment: "#868c7d",
      punctuation: "#bcc0b2",
      number: "#ceb170",
      string: "#9fc185",
      operator: "#91bfb8",
      keyword: "#c1a0cb",
      function: "#8bb4d0",
      link: "#82b7cf",
      quote: "#a3a69a",
      chip: "#97c3af",
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
    // Every match at once is membership, not a focus anchor, so the wash is
    // lichen-neutral like the palette's own match band. The one current match
    // keeps the accent: xterm paints it from `search-highlight-text`, and the
    // CodeMirror current match underlines with `search-selected-result-border`.
    "search-highlight-background": "rgba(223,224,216,0.14)",
    "search-highlight-text": "#36CE94",
    "search-selected-result-border": "rgba(54,206,148,0.30)",
    // Toolbar, sidebar and dock are one shell plane; keep them in lockstep.
    "surface-toolbar": "#131510",
    // The resting edge of every text field. An input boundary is a UI component
    // under WCAG 1.4.11 and owes 3:1 on its own; the divider ladder is tuned for
    // separation and would read as hard ruled lines at that weight. Solid, not
    // white-alpha, because an alpha border composites differently on every
    // surface. 3.22:1 on `surface-input` (#2c2c29), 3.67:1 on `surface-panel`.
    "border-input": "#787a71",
    // The keyboard selection ring in menus and palettes. The derived 42% lichen
    // measured 2.98:1 against a highlighted row on the lifted overlay plane;
    // 44% is the floor; 48% leaves margin against both the row and the plane.
    "selection-outline": "rgba(223,224,216,0.48)",
    // A placeholder is the quietest rung of the ramp, so this house tiers it at
    // 3:1 rather than AA (`scripts/theme-text-contrast.test.ts` orders the ramp).
    // 3.58:1 on the elevated field up to 4.92:1 on the grid. Solid rather than
    // alpha-derived: an alpha text colour bakes into `color-mix()`.
    "text-placeholder": "#7f8278",
    // ANSI 90, the dim slot for hints and timestamps, is read as body text and
    // owes AA: 4.88:1 on the terminal background, still 2.7x quieter than the
    // foreground's 13.01:1. Split from `activity.idle`, which is a quiet dot.
    "terminal-bright-black": "#878981",
    // Settled completion is demoted, not green (status-success-policy.md). This
    // paints the project switcher's review tone; slate matches the agent's own
    // completed check (`text-category-slate`).
    "activity-completed": "#7B8C96",
    // Forge metadata re-cut off GitHub's brand hexes into this palette. All four
    // sit at 5.4-5.8:1 on `surface-panel`, below `text-secondary` (6.62:1), so a
    // forge chip is never louder than the prose it annotates.
    "pr-open": "#5FA47F",
    "pr-merged": "#AE8ED6",
    "pr-closed": "#D0827A",
    "pr-draft": "#9A9A94",
    // The engine's categories run at C 0.11-0.14, close to the working and brand
    // greens. Organisational metadata should not compete with agent state, so
    // they keep their hues at roughly half the chroma. Orange sits at L 0.70 to
    // stay clear of `status-success` under protanopia.
    "category-blue": "oklch(0.68 0.075 250)",
    "category-purple": "oklch(0.68 0.075 310)",
    "category-cyan": "oklch(0.70 0.065 215)",
    "category-green": "oklch(0.68 0.070 145)",
    "category-amber": "oklch(0.71 0.080 75)",
    "category-orange": "oklch(0.70 0.085 45)",
    "category-teal": "oklch(0.68 0.065 185)",
    "category-indigo": "oklch(0.67 0.085 275)",
    "category-rose": "oklch(0.68 0.080 5)",
    "category-pink": "oklch(0.70 0.075 340)",
    "category-violet": "oklch(0.68 0.075 295)",
    "category-slate": "oklch(0.67 0.030 240)",
    // Green-black shadow and scrim ink; keep C ≤ ~0.02 or the fog reads as a
    // coloured glow instead of air.
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
    "pulse-before-bg": "#161814",
    "pulse-card-bg": "#21221f",
    "pulse-card-shadow": "0 1px 3px rgba(5,10,7,0.40)",
    "pulse-control-hover-bg": "rgba(255,255,255,0.05)",
    "pulse-empty-bg": "#252622",
    // Heat ramp: opaque stops, level 4 = accent (a data lane, outside the
    // accent budget); level 1 must stay ≥ JND above the empty cell.
    "pulse-heat-color": "#36CE94",
    "pulse-heat-1": "#23402f",
    "pulse-heat-2": "#2b6243",
    "pulse-heat-3": "#319966",
    "pulse-heat-4": "#36CE94",
    "pulse-range-bg": "#1a1b18",
    "pulse-ring-offset": "#21221f",
    "pulse-skeleton-gradient": "linear-gradient(90deg, #2c2c29 25%, #31322f 50%, #2c2c29 75%)",
    "dock-bg": "#131510",
    // Menus, palettes, popovers and tooltips. The shared dark overlay is the
    // sidebar plane, which here sits below every panel it floats over, so menus
    // read as holes. This lifts them between panel (#21221f) and the elevated
    // input plane (#2c2c29): above what they cover, below the search field
    // inside them. Text on it: 11.3 / 6.2 / 5.0:1 for primary / secondary / muted.
    "overlay-surface-color": "#262724",
    // The one shaft of the hero's light: its sunlit bark (#9C9168) on the brand
    // mark of the welcome screen and the empty workbench. 6.1:1 on the grid,
    // below secondary prose and far below the waiting amber.
    "welcome-mark-color": "#9C9168",
    "grid-mark-color": "#9C9168",
    "settings-dialog-bg": "#21221f",
    "settings-card-bg": "#252622",
    "settings-list-item-bg": "#252622",
    // rgb(19,21,16) is the sidebar surface; keep in lockstep with surfaces.sidebar.
    "dialog-header-bg": "rgba(19,21,16,0.60)",
    "settings-search-bg": "#1a1b18",
    "settings-search-muted": "#a5a89d",
    "settings-sidebar-bg": "rgba(19,21,16,0.50)",
    // settings-sidebar-bg composited over settings-dialog-bg.
    "settings-sidebar-scroll-fade": "#1a1c18",
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
    "toolbar-divider": "rgba(45,46,42,0.5)",
    // A warm top-light off the hero's sunlit mist, deliberately very subtle —
    // don't re-tint it green.
    "toolbar-project-bg":
      "linear-gradient(180deg, rgba(208,190,161,0.07), rgba(208,190,161,0) 70%), rgba(255,255,255,0.03)",
    "toolbar-project-border": "rgba(45,46,42,0.5)",
    "toolbar-project-chip-bg": "rgba(255,255,255,0.05)",
    "toolbar-project-chip-border": "rgba(45,46,42,0.6)",
    "toolbar-project-meta-fg": "#a5a89d",
    "toolbar-project-shadow": "inset 0 1px 0 rgba(255,255,255,0.06)",
    "toolbar-stats-bg": "rgba(255,255,255,0.05)",
    "toolbar-stats-border": "rgba(45,46,42,0.5)",
    "toolbar-stats-divider": "rgba(45,46,42,0.5)",
    "toolbar-stats-hover-bg": "rgba(255,255,255,0.10)",
  },
};
