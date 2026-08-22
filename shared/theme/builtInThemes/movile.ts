import type { BuiltInThemeSource } from "../builtInThemeSources.js";

/**
 * Movile — the contrast-budget theme.
 *
 * Movile Cave sealed itself off about 5.5 million years ago. No sunlight has
 * reached it since, nothing photosynthesises, and the whole food web runs on
 * sulfur- and methane-oxidising bacteria. The endemic fauna are blind and
 * unpigmented. The only light that has ever been down there is the survey lamp
 * someone carried in.
 *
 * The palette is built on one measurable rule: exactly two things are allowed
 * to be bright — an agent waiting on you (`activity.waiting`, 13.09:1 on the
 * panel) and something broken (`status.danger`, 8.31:1). Every other activity,
 * status and accent value is capped at 4.55:1, so the quieter of the two signals
 * is 1.83x the loudest indicator. At nine panes that is the difference between
 * scanning and seeing.
 *
 * The cap governs INDICATOR colours — dots, fills, rails, chrome. Anything
 * rendered as TEXT is floored by AA instead and sits in a band above it
 * (category labels 6.5-6.7:1, search 6.4:1, `text.secondary` 6.7:1), which is
 * why the rule is "two semantic colours are bright", not "two things are
 * bright". Legibility outranks the budget wherever they disagree; the ordering
 * that has to hold is that nothing outside the two signals outranks them.
 *
 * Two acknowledged exceptions to the cap, both narrow. The category family is
 * dual-use — the same token is a panel-kind icon AND chip text — so it is
 * floored by AA at 5.7-5.9:1 rather than capped; see the note on it below.
 * `accent-hover` is derived by the engine as the accent mixed toward white and
 * lands at ~5.3:1, which is interaction-only and never at rest. Counting the
 * dual-use family, signal headroom over everything else is ~1.4x rather than
 * the 1.83x the indicator band alone reports.
 *
 * The quiet band sits at the TOP of that cap (4.40-4.53), not the bottom. Status
 * colours are rendered as badge and banner text, not just as dots, so crowding
 * them down toward the 3:1 indicator floor buys no extra headroom worth having
 * and costs real reading comfort.
 *
 * Three consequences of that rule, all deliberate:
 *
 * 1. The accent is unpigmented. It is a near-neutral bone (C = 0.018) rather
 *    than a hue, because the theme spends its colour budget on state and has
 *    none left for brand. Movile is the only dark built-in without a chromatic
 *    accent, which is also what buys distance from arashiyama's terracotta in
 *    the cross-theme ΔE audit — every warm sulfur accent sampled from the hero
 *    art landed at ΔE 0.08-0.10 against it, versus 0.1245 for this bone. That
 *    audit is warn-only, and Movile still warns against galapagos at 0.1172;
 *    the 0.12 line is advice, not a gate.
 * 2. Separation comes from edges, not shadow. `shadowStyle: "none"` plus the
 *    hairline-ring overrides below means the elevation profiles cast nothing;
 *    what actually separates a popover from the cave behind it is the 1px ring,
 *    plus occlusion and the modal scrim. The frosted material (blur 14) is real
 *    but contributes little at these luminances — there is not enough behind a
 *    surface for a blur to reveal. It is kept because the built-in gate demands
 *    a non-zero blur and it costs nothing, NOT because it is the depth model.
 *    Note also that the legacy `--shadow-overlay` / `--shadow-modal` / dock
 *    stacks in src/index.css derive straight from `shadow-color` and bypass the
 *    profiles entirely, so those DO still cast; `shadow-color` is dialled back
 *    below rather than left at a weight that would fight the flat design.
 * 3. The surface ladder is flat by dark-theme standards (grid→panel 1.05:1 vs
 *    1.13-1.30 across the rest of the cohort) and stays low: `elevated` sits at
 *    OKLab L 0.185 — darker than every other dark theme's PANEL (the next
 *    lowest is redwoods at 0.209). It is not below their grids; highlands' grid
 *    is 0.181, a hair under Movile's brightest plane. The app still never
 *    leaves the cave floor, but that is the honest version of the claim.
 *
 * `panelStateEdge` is deliberately NOT set. It compiles to a 2px
 * `panel-state-edge-width`, but only the `.light .panel-state-*` rules in
 * src/index.css read that variable — the dark rules hardcode a 1px spread. Dark
 * panels still get an activity-coloured state ring, just at 1px; opting in here
 * would set a token nothing reads and advertise a rail this theme does not get.
 *
 * Grounding: the dark warm limestone, black sulfidic water and sulfur-stained
 * ivory are real. The beam is a survey lamp, not daylight — Movile is entered
 * through an artificial shaft.
 */
export const theme: BuiltInThemeSource = {
  id: "movile",
  name: "Movile",
  type: "dark",
  builtin: true,
  location: "Movile Cave, Constanța County, Romania",
  heroImage: "/themes/movile.webp",
  palette: {
    type: "dark",
    // Warm limestone black. Steps are small on purpose; several sit under the
    // OKLab JND and the dark ramp audit warns rather than fails. Separation is
    // paid for by border-default, the state rail and the material — not by
    // stacking the planes further apart.
    surfaces: {
      grid: "#040404",
      sidebar: "#070605",
      canvas: "#0A0908",
      panel: "#0E0C0B",
      elevated: "#15120F",
    },
    text: {
      primary: "#D3CCC0",
      secondary: "#9E978B",
      // The engine applies no dark floor to muted (namib runs ~2.2:1), but muted
      // carries real small body copy — timestamps, helper text, metadata — and on
      // a field this dark that is where discomfort shows up first. Both quiet text
      // tiers are therefore floored ABOVE the cohort rather than below it:
      // secondary 6.74:1 and muted 5.00:1 on the panel, against daintree's 6.57
      // and 4.92 on a lighter one. Text is a neutral channel and carries no part
      // of the colour budget, so lifting it costs the thesis nothing — the rule
      // governs which SEMANTIC COLOUR shouts, not how legible the prose is.
      muted: "#878076",
      // Deep cave black rather than a surface hex: accent-foreground defaults to
      // this, and it needs 4.5:1 on the accent itself. #030303 lands at 4.68;
      // the sidebar hex would only reach ~4.0 and fail the gate.
      inverse: "#030303",
    },
    // The one structural seam. Dark themes have no border contrast floor, so
    // this is a design choice, not a derived value: with shadows off and the
    // ladder flat, a visible warm hairline is what stops panes dissolving into
    // the gutter.
    border: "#241F1B",
    accent: "#7F776D",
    accentSecondary: "#827862",
    status: {
      success: "#5D8160",
      warning: "#92763A",
      info: "#5D7B95",
      // Loud #2. Sulfur-oxidised ember — the only chromatic value in the theme
      // that is allowed to advance.
      danger: "#E89478",
    },
    activity: {
      active: "#687E6D",
      idle: "#58524A",
      working: "#687E6D",
      // Loud #1. The survey beam on wet calcite. This is the whole theme.
      waiting: "#EBD0A4",
    },
    // Warm cream: tints the wash/overlay ladder so hovers read as lamplight on
    // limestone rather than a grey film.
    overlayTint: "#E8DCC4",
    // Terminal is its own world, one step off the canvas. Desaturated (HSL S
    // runs ~15-51%, most slots in the teens and twenties) so diffs and logs stay
    // parseable without competing with the two loud signals; every slot clears
    // dL 0.18 on the background and every base/bright pair clears ΔE 0.03. The
    // twelve chromatic base/bright slots run 5.7-10.2:1 on the terminal
    // background; black and white are the ANSI extremes and sit outside that by
    // definition.
    terminal: {
      background: "#060505",
      foreground: "#C5BEB2",
      selection: "#281F14",
      red: "#C1725B",
      green: "#779B76",
      yellow: "#BE9956",
      blue: "#6D91B4",
      magenta: "#A183A6",
      cyan: "#719E9D",
      brightRed: "#D4937C",
      brightGreen: "#95B393",
      brightYellow: "#D3B37E",
      brightBlue: "#8DABC0",
      brightMagenta: "#BBA1BF",
      brightCyan: "#90B8B7",
      brightWhite: "#E5DFD4",
    },
    // Painted on surface-canvas in the file viewer as well as the terminal, so
    // every role clears AA 4.5:1 there; comment and quote take the 3.0 soft floor.
    syntax: {
      comment: "#66605A",
      punctuation: "#A19A8E",
      number: "#C19C61",
      string: "#8BA981",
      operator: "#8BA8A8",
      keyword: "#AF93B6",
      function: "#7EA0BC",
      link: "#87A8C0",
      quote: "#827B72",
      chip: "#7EA8A4",
    },
    strategy: {
      shadowStyle: "none",
      // Both must exceed 0 (builtInThemes.test.ts). Kept at a real value rather
      // than a token one, but do NOT mistake this for the depth model: at these
      // luminances there is too little behind a surface for a blur to reveal,
      // and the 1px rings plus the scrim are what actually separate floating
      // chrome. See the header.
      materialBlur: 14,
      materialSaturation: 105,
      // Tight, geological corners.
      radiusScale: 0.6,
      // Warm limestone ink instead of the engine's additive white, so the
      // derived border ladder is quiet but on-temperature rather than grey.
      borderInkOverride: "#C9B79A",
      // Banners stay legible; the wash just stops shouting on a field this dark.
      statusSurfaceOpacity: 0.75,
      // Wet rock, not sand. No grain layer at all.
      grainCharacter: "none",
    },
  },
  tokens: {
    "surface-toolbar": "#070605",
    // The "none" profile leaves floating chrome with no edge at all and gives
    // dialogs only a border-subtle ring. These put the separation back as a
    // hairline: flat, but delineated. This is what actually holds a popover off
    // the cave floor — see the note on material in the header.
    "shadow-floating": "0 0 0 1px var(--theme-border-strong)",
    "shadow-dialog": "0 0 0 1px var(--theme-border-strong)",
    // Read directly by the legacy --shadow-overlay / --shadow-modal / dock
    // stacks in src/index.css, which bypass the elevation profiles. Dialled to
    // 0.42 (daintree runs 0.55) so those stacks stay lighter than the cohort
    // instead of heavier — a flat theme should not cast the deepest shadow.
    "shadow-color": "rgba(3,3,3,0.42)",
    "scrim-soft": "rgba(3,3,3,0.32)",
    "scrim-medium": "rgba(3,3,3,0.60)",
    "scrim-strong": "rgba(3,3,3,0.76)",
    // Thick cave air behind modals — the material doing the work shadows won't.
    "scrim-blur": "20px",
    "scrim-blur-palette": "6px",
    // The accent is a near-neutral bone, so it cannot carry search highlighting;
    // search runs on the cool sulfidic-water lane instead (sanctioned split —
    // search is deliberately independent of accent).
    "search-highlight-background": "rgba(89,118,143,0.24)",
    // Search sits in its own tier, deliberately: a match is a locator the user
    // just asked for, not an ambient state, so it is allowed above the 4.55 cap
    // — but it must stay BELOW both real signals, and the engine's brighter blue
    // put it at 10.57:1, louder than `status.danger`. 6.42:1 keeps the ordering
    // waiting > danger > search > everything else, and still clears 5:1 against
    // its own composited highlight wash (the gate wants 3:1).
    "search-highlight-text": "#7C97B0",
    "search-match-badge-background": "rgba(89,118,143,0.24)",
    "search-match-badge-text": "#7C97B0",
    "search-selected-result-border": "rgba(89,118,143,0.40)",
    "search-selected-result-icon": "#7C97B0",
    // PR state colours are inherited from PR_STATE_DARK_TOKENS unless a theme
    // overrides them, and the GitHub-derived defaults land at 5.8-7.7:1 here —
    // ambient forge chrome in the toolbar and worktree cards sitting louder than
    // anything except the two signals. Re-cut into the quiet band with their hue
    // identity intact (green/purple/red/grey). A closed PR is information, not an
    // error; only `status.danger` gets to look like one.
    "pr-open": "#4E8156",
    "pr-merged": "#80709D",
    "pr-closed": "#A9655A",
    "pr-draft": "#757A7E",
    "focus-ring": "rgba(211,204,192,0.42)",
    // Category hues label branches, worktrees, action categories and panel
    // kinds. The engine hands them out at full strength — the dark defaults
    // (oklch(0.7 0.13 h)) measure ~6.1-8.2:1 on this panel, level with
    // `status.danger` — so they need re-cutting. How far down is bounded from
    // BELOW by accessibility, and that bound wins over the budget:
    //
    //   - `--color-category-*-text` (src/index.css) is the base mixed 15% toward
    //     `text-primary`, and `src/config/categoryColors.ts` documents a 4.5:1
    //     promise for 9-12px chip labels. AA is measured against the chip's own
    //     `-subtle` pill, not the panel, and there are two pill contexts (12%
    //     into canvas, 20% into elevated).
    //   - the raw base is ALSO painted as text, on its own alpha tint, in
    //     `CAT_COLOR_CLASSES` (`bg-cat-*/15 text-cat-*`) and
    //     `EVENT_CATEGORY_STYLES` (`/20`) in src/config/categoryColors.ts, plus
    //     the branch chips in shared/theme/entityColors.ts. So the base owes AA
    //     against ITS OWN TINT, not just the 3:1 it owes as a panel-kind icon.
    //
    // Lightness is solved PER HUE against the binding one of those — the raw
    // base on its own /20 tint. Everything else then clears: raw-on-tint
    // 4.51-4.60:1, derived labels 4.93-5.07:1 on their pills and 6.48-6.67:1 on
    // the panel, bases 5.73-5.93:1. That sits above the 4.55 cap and deliberately
    // so: the cap governs INDICATOR colours (dots, fills, chrome), while anything
    // rendered as text is floored by AA instead — the same rule that puts
    // `text.secondary` at 6.74:1. The check that replaces the cap here is that
    // every category label stays BELOW `text.secondary`, so a coloured chip is
    // never louder than the plain prose beside it, and all of them stay well
    // below both signals. Still far under the engine defaults' 6.1-8.2:1.
    //
    // Chroma is 0.11 for the eleven hues (slate is the deliberately achromatic
    // member at 0.025) and is NOT cut in proportion to lightness: chroma is what
    // survives colour-vision simulation, and cutting it collapsed blue/indigo
    // under deuteranopia. The blue/indigo and cyan/teal hue gaps are widened
    // instead. Worst simulated pair 0.0078 against the 0.005 gate.
    "category-blue": "oklch(0.638 0.11 246)",
    "category-purple": "oklch(0.652 0.11 312)",
    "category-cyan": "oklch(0.625 0.11 212)",
    "category-green": "oklch(0.633 0.11 145)",
    "category-amber": "oklch(0.646 0.11 75)",
    "category-orange": "oklch(0.654 0.11 42)",
    "category-teal": "oklch(0.625 0.11 188)",
    "category-indigo": "oklch(0.648 0.11 282)",
    "category-rose": "oklch(0.657 0.11 5)",
    "category-pink": "oklch(0.656 0.11 340)",
    "category-violet": "oklch(0.652 0.11 298)",
    "category-slate": "oklch(0.642 0.025 240)",
    // The engine derives this as `status-info` mixed 10% toward the tint, which
    // on dark means toward WHITE — landing at 5.26:1, a resting modified-state
    // dot brighter than the entire ambient band. Same shape, mixed toward the
    // panel instead and at 95/5 rather than 90/10: 4.05:1, inside the band, and
    // still visibly a shade of `status-info` rather than an unrelated colour.
    "state-modified": "color-mix(in oklab, #5D7B95 95%, #0E0C0B)",
    // Derived would be text-primary @42%, which lands at 2.99:1 against the
    // selected palette row once the field is this dark — a hair under the 3:1
    // that 1.4.11 demands of the row's only non-text indicator. Nudged up.
    "selection-outline": "rgba(211,204,192,0.48)",
  },
  extensions: {
    // The grid gutter carries a faint shaft from the top edge — the survey lamp,
    // at 3.5% alpha. The audited flat surfaces.grid hex stays the final layer,
    // so the ramp/contrast source of truth and the boot splash are unaffected.
    "panel-grid-bg":
      "radial-gradient(120% 80% at 50% 0%, rgba(235,208,164,0.035), transparent 62%), #040404",

    // Focus chrome inks from the bone accent. Focus IS the load-bearing signal
    // per region, so this is the theme's one sanctioned accent fill in the
    // panel area — nothing else in the grid carries accent.
    "panel-focus-border": "rgba(127,119,109,0.85)",
    "panel-focus-shadow": "0 0 0 1px rgba(127,119,109,0.45)",
    "panel-selected-bg": "rgba(232,220,196,0.03)",

    // Required dark interaction chrome. A no-chrome theme still has to answer
    // "did my click land", so these stay perceptible even though the resting
    // state is bare. armed/active clear hover by 0.07 (floor is 0.04).
    "sidebar-hover-bg": "rgba(255,255,255,0.035)",
    "sidebar-active-bg": "rgba(255,255,255,0.075)",
    "sidebar-action-hover-bg": "rgba(255,255,255,0.06)",
    "toolbar-control-hover-bg": "rgba(255,255,255,0.07)",
    "toolbar-control-armed-bg": "rgba(255,255,255,0.14)",
    "toolbar-control-active-bg": "rgba(255,255,255,0.14)",
    "toolbar-control-armed-shadow": "inset 0 0 0 1px rgba(255,255,255,0.14)",
    "toolbar-agent-hover-bg": "rgba(255,255,255,0.06)",

    // Flat toolbar: no gradient, no inset top-light. The pill is a fill and a
    // seam, matching the stats cluster exactly.
    "toolbar-divider": "rgba(201,183,154,0.14)",
    "toolbar-project-bg": "rgba(255,255,255,0.035)",
    "toolbar-project-border": "rgba(201,183,154,0.14)",
    "toolbar-project-chip-bg": "rgba(255,255,255,0.05)",
    "toolbar-project-chip-border": "rgba(201,183,154,0.18)",
    "toolbar-project-meta-fg": "#9E978B",
    "toolbar-stats-bg": "rgba(255,255,255,0.035)",
    "toolbar-stats-border": "rgba(201,183,154,0.14)",
    // Must equal toolbar-divider (#10029) — same separator ink as the rest of
    // the toolbar chrome.
    "toolbar-stats-divider": "rgba(201,183,154,0.14)",
    "toolbar-stats-hover-bg": "rgba(255,255,255,0.07)",

    "dock-bg": "#070605",
    "dock-border": "rgba(201,183,154,0.12)",

    "dialog-header-bg": "rgba(7,6,5,0.60)",
    "settings-dialog-bg": "#0E0C0B",
    "settings-card-bg": "#15120F",
    "settings-list-item-bg": "#15120F",
    "settings-kbd-bg": "#0A0908",
    "settings-search-bg": "#0A0908",
    "settings-search-muted": "#9E978B",
    "settings-sidebar-bg": "rgba(7,6,5,0.50)",
    // settings-sidebar-bg composited over the dialog shell.
    "settings-sidebar-scroll-fade": "#0A0908",
    "settings-nav-hover-bg": "rgba(255,255,255,0.035)",
    "settings-nav-active-bg": "rgba(255,255,255,0.075)",

    // Sulfur crust ramp, deep to lit. A data lane, so it sits outside the accent
    // budget — but it deliberately stops short of the beam ivory, which stays
    // reserved for an agent waiting on you.
    "pulse-heat-color": "#827862",
    "pulse-heat-1": "#1B1813",
    "pulse-heat-2": "#362F25",
    "pulse-heat-3": "#59523F",
    "pulse-heat-4": "#827862",
    "pulse-before-bg": "#080706",
    "pulse-card-bg": "#0E0C0B",
    "pulse-control-hover-bg": "rgba(255,255,255,0.05)",
    "pulse-empty-bg": "#15120F",
    "pulse-range-bg": "#0A0908",
    "pulse-ring-offset": "#0E0C0B",
    "pulse-skeleton-gradient": "linear-gradient(90deg, #15120F 25%, #1F1B18 50%, #15120F 75%)",

    "worktree-section-hover-bg": "rgba(255,255,255,0.035)",
  },
};
