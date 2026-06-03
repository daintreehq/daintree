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
    // Redesign (#9711): chroma hold at constant L. The old ramp decayed to
    // near-zero chroma as surfaces lightened (grid C 0.013 -> elevated C 0.001),
    // so most of the window read as indeterminate cold gray instead of pale
    // Bondi blue. Each surface keeps its L (ramp steps 0.020-0.021, max/min
    // 1.05x — audit gates clear) but holds C ~0.017 -> 0.009 into the lighter
    // bands on a unified ~248 hue. Depth is carried by the darker hairline
    // border and the recessed inset/filter-bar wells, not by bigger L jumps.
    surfaces: {
      grid: "#DAE5EE",
      sidebar: "#E3EBF4",
      canvas: "#EAF2F9",
      panel: "#F4F8FE",
      elevated: "#FEFFFF",
    },
    text: {
      primary: "#1C2028",
      secondary: "#48535F",
      muted: "#5F6A76",
      inverse: "#FDFDFE",
    },
    // Border darkened one step (L 0.885 -> 0.866, same slate-blue hue): with
    // every surface step at the ~0.02 floor, the 1px hairlines are what carry
    // figure-ground on light, and the old border barely registered.
    border: "#CCD4DD",
    accent: "#178463",
    accentSecondary: "#0A7E8C",
    status: {
      success: "#2A8649",
      warning: "#A86A0C",
      danger: "#C2433A",
      info: "#1E6FA0",
    },
    activity: {
      active: "#2A8649",
      idle: "#5F6A76",
      working: "#2A8649",
      waiting: "#A0700E",
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
      blue: "#4D9FD6",
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
      keyword: "#7536C8",
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
    // E7: drop the pure-black scrim overrides so the lowered, hued engine defaults
    // apply on light (withAlpha(overlayBase #163447, 0.22/0.36/0.55)) — a near-black
    // 0.50 slab over a near-white workbench read as a heavy flat wash.
    // pr-merged/pr-draft: GitHub-brand defaults fail AA on bondi's near-white panel
    // (#8250DF 4.48:1, #8B949E 2.73:1). Darken in L only (hue preserved) so both
    // clear AA on surface-panel AND surface-panel-elevated. E6.
    "pr-merged": "#7644CC",
    "pr-draft": "#646B73",
    // scrollbar-thumb (RC-6/E6): same slate hue, low enough L to clear the 3:1
    // graphical floor against the lifted surfaces.
    "scrollbar-thumb": "#6F757E",
    "scrollbar-thumb-hover": "color-mix(in oklab, #6F757E 85%, #1C2028)",
    "search-highlight-background": "rgba(35,94,150,0.14)",
    "search-highlight-text": "#235E96",
    "search-match-badge-background": "rgba(35,94,150,0.14)",
    "search-match-badge-text": "#235E96",
    "search-selected-result-border": "rgba(35,94,150,0.34)",
    "search-selected-result-icon": "#235E96",
    // E8: surface-input is derived RECESSED by the engine (just below canvas).
    // #9711: surface-inset decoupled from the grid floor — a real recessed well
    // (L 0.901, 0.036 below sidebar) so the diff/command chips read as inset
    // rather than painted on. Stays 0.034 above the border hairline.
    "surface-inset": "#D5E0E9",
    "surface-toolbar": "#E3EBF4",
    "terminal-bright-black": "#525D69",
    "terminal-white": "#C8D0D9",
    "text-link": "#0F5B41",
    "text-placeholder": "rgba(28,32,40,0.55)",
  },
  extensions: {
    "dock-bg": "#E3EBF4",
    // G1: keep the gutter at/just-below surface-grid (#DAE5EE) so it recedes and
    // the panel tiles read as figure (no figure-ground inversion).
    "panel-grid-bg": "#D8E2EC",
    "pulse-before-bg": "#DAE5EE",
    "pulse-card-bg": "#FEFFFF",
    // #9711: second, wider shadow layer — the single hairline shadow was
    // invisible over the near-white canvas, so the elevated card read as a
    // flat rectangle taped onto the grid.
    "pulse-card-shadow": "0 1px 2px rgba(23,33,48,0.10), 0 4px 10px rgba(23,33,48,0.08)",
    "pulse-control-hover-bg": "rgba(22,52,71,0.05)",
    "pulse-empty-bg": "#EAF2F9",
    "pulse-heat-high-opacity": "0.85",
    "pulse-heat-low-opacity": "0.38",
    "pulse-heat-medium-opacity": "0.62",
    "pulse-heat-color": "#0A7E8C",
    // P-Heat: opaque status-danger so the streak-break signal clears the 3:1
    // floor vs the empty cell and stays destructive-tier (consumer adds an inset
    // danger ring).
    "pulse-missed-bg": "#C2433A",
    "pulse-range-bg": "#EAF2F9",
    "pulse-ring-offset": "#FEFFFF",
    "pulse-skeleton-gradient": "linear-gradient(90deg, #DAE5EE 25%, #EAF2F9 50%, #DAE5EE 75%)",
    // S1: settings card/list/dialog/nav-active overrides dropped so the engine +
    // CSS defaults apply — dialog body inherits surface-panel, cards/list inherit
    // surface-panel-elevated (a clean lift above the body), and nav-active
    // inherits overlay-raised (the neutral elevate-to-select lift). The 2px accent
    // marker in SettingsDialog.tsx is the single accent anchor.
    "dialog-header-bg": "rgba(244,248,254,0.70)",
    "settings-kbd-bg": "#EAF2F9",
    "settings-kbd-border": "#CCD4DD",
    "settings-nav-hover-bg": "rgba(22,52,71,0.05)",
    "settings-search-bg": "#FEFFFF",
    "settings-sidebar-bg": "rgba(244,248,254,0.60)",
    "sidebar-action-hover-bg": "rgba(0,0,0,0.05)",
    // Issue 1 / #9711: selection elevates, container recedes. The selected card
    // lifts to pure white (L 1.0, a 0.063 jump over the sidebar) so the single
    // active worktree reads as crisp paper against the blue field; hover tracks
    // canvas (L 0.957) — idle < hover < selected.
    "sidebar-active-bg": "#FFFFFF",
    "sidebar-hover-bg": "#EAF2F9",
    "toolbar-agent-hover-bg": "rgba(22,52,71,0.06)",
    "toolbar-control-hover-bg": "rgba(22,52,71,0.07)",
    // #9711: neutral hover foreground (was accent green) — accent restraint;
    // the hover affordance is carried by toolbar-control-hover-bg.
    "toolbar-control-hover-fg": "#1C2028",
    "toolbar-control-hover-shadow": "none",
    "toolbar-divider": "rgba(204,212,221,0.6)",
    "toolbar-pill-radius": "0.5rem",
    "toolbar-project-bg":
      "linear-gradient(180deg, rgba(23,132,99,0.06), rgba(22,52,71,0.04)), linear-gradient(135deg, #EAF2F9, #E3EBF4)",
    "toolbar-project-border": "rgba(204,212,221,0.7)",
    "toolbar-project-chip-bg": "rgba(22,52,71,0.05)",
    "toolbar-project-chip-border": "rgba(204,212,221,0.7)",
    "toolbar-project-shadow": "inset 0 1px 0 rgba(255,255,255,0.5)",
    // #9711: hairline drop so the chrome strip separates from the canvas —
    // depth via the shadow budget, not a darker surface.
    "toolbar-shadow": "0 1px 2px rgba(23,33,48,0.06)",
    "toolbar-stats-bg": "rgba(22,52,71,0.05)",
    "toolbar-stats-border": "rgba(204,212,221,0.6)",
    "toolbar-stats-divider": "rgba(204,212,221,0.6)",
    "toolbar-stats-hover-bg": "rgba(22,52,71,0.07)",
    "toolbar-stats-shadow": "none",
    // #9711: the filter/search bar sits on its own recessed band — the deepest
    // surface in the sidebar (L 0.894, below inset) — so the control rail reads
    // as seated chrome instead of dissolving into the wash.
    "worktree-filter-bar-bg": "#D5DDE7",
    "worktree-section-hover-bg": "rgba(22,52,71,0.05)",
  },
};
