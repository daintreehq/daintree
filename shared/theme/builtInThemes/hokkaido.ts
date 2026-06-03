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
    surfaces: {
      grid: "#D6D3E3",
      sidebar: "#DEDBEA",
      canvas: "#E5E3EF",
      panel: "#EDEBF4",
      elevated: "#FBF9FD",
    },
    text: {
      primary: "#2B2F42",
      secondary: "#565C78",
      muted: "#5E6685",
      inverse: "#FDFCFF",
    },
    border: "#BFBBD2",
    accent: "#6E57DB",
    accentSecondary: "#2C7458",
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
      // B2: working (h163 green) and waiting (h83 amber) were near-isoluminant
      // (dL 0.0099) — a single luminance channel left them separable by hue only,
      // which collapses on the deuteranope confusion line on a 6px dot. Lift
      // waiting's L within its own amber family (#9A7314 → #A57A10) so it now
      // clears the JND vs working (dL 0.0368) while holding ≥3:1 vs canvas (3.07).
      waiting: "#A57A10",
    },
    overlayTint: "#525276",
    terminal: {
      background: "#22273B",
      foreground: "#E2E8F4",
      muted: "#80A0D6",
      cursor: "#C2A170",
      selection: "#313963",
      red: "#C87070",
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
      comment: "#71708A",
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
      materialBlur: 10,
      materialSaturation: 115,
    },
  },
  tokens: {
    "accent-muted": "rgba(110,87,219,0.30)",
    "accent-soft": "rgba(110,87,219,0.18)",
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
    "focus-ring": "rgba(110,87,219,0.30)",
    // AA 4.5:1 on hokkaido's near-white panel (#EDEBF4) & elevated (#FBF9FD);
    // prior values were 4.11/2.39/3.86/3.91:1. Darkened keeping hue (E6/B1).
    "pr-closed": "#C02631",
    "pr-draft": "#525B66",
    "pr-merged": "#7544CA",
    "pr-open": "#1A722F",
    "label-pill-bg-opacity": "0.10",
    "label-pill-border-opacity": "0.18",
    // filter-selected (membership, never accent): elevate-to-select. The engine
    // darkening default left strong-vs-soft at ΔE 0.019 (sub-JND merge on hokkaido's
    // tight violet ramp); explicit opaque lifts clear the JND (soft-vs-panel 0.021,
    // strong-vs-soft 0.023). panel #EDEBF4 < soft < strong toward elevated #FBF9FD.
    "filter-selected-bg-soft": "#F4F2FA",
    "filter-selected-bg-strong": "#FCFAFE",
    "shadow-color": "rgba(38,33,58,0.12)",
    // E7: scrim overrides dropped. The engine now derives the light scrim from the
    // hued overlayBase (overlayTint #525276) at lowered alphas (soft 0.22 / medium
    // 0.36 / strong 0.55) — same cool-violet temperature these overrides carried,
    // but lighter so the dim behind a modal reads as a veil over a near-white
    // workbench rather than a heavy slab. Inheriting keeps hokkaido on the shared
    // model instead of pinning its own heavier values.
    // scrollbar-thumb must clear 3:1 vs panel & canvas (E6): #9BA3BE was 2.12/1.98.
    "scrollbar-thumb": "#6A7290",
    "scrollbar-thumb-hover": "color-mix(in oklab, #6A7290 85%, #2B2F42)",
    "search-highlight-background": "rgba(58,111,192,0.22)",
    "search-highlight-text": "#27539A",
    "search-match-badge-background": "rgba(58,111,192,0.22)",
    "search-match-badge-text": "#27539A",
    "search-selected-result-border": "#3A6FC0",
    "search-selected-result-icon": "#27539A",
    "overlay-hover": "rgba(82,82,118,0.10)",
    "state-chip-bg-opacity": "0.12",
    "state-chip-border-opacity": "0.32",
    // E8: surface-input override dropped. It used to pin the input to #FAF8FD
    // (L 0.982 — the brightest plane, the opposite of the macOS / VS Code inset
    // well). The engine now derives surface-input RECESSED on light
    // (color-mix(surface-canvas 96%, text-primary) ≈ just below canvas) so the
    // input field sits in a well; placeholder over it clears ~3:1 at the raised
    // 0.58 alpha. Inheriting the recessed default is the E8 fix.
    "surface-inset": "#CECBDD",
    "surface-toolbar": "#DAD7E7",
    "terminal-black": "#2D334A",
    "terminal-bright-black": "#6A708C",
    "terminal-white": "#E2E8F4",
    "text-link": "#574EC0",
    "text-placeholder": "rgba(43,47,66,0.55)",
  },
  extensions: {
    // G1: panel-grid-bg is the gutter behind the panel tiles. It was #E5E3EF
    // (= canvas, L 0.921) — BRIGHTER than the panel tiles, a figure-ground
    // inversion that made the tiles read as wells. Drop it to #D2CFE0 (L 0.862,
    // at/below surface-grid L 0.874) so the gutter recedes and the tiles read as
    // raised figures against it.
    "panel-grid-bg": "#D2CFE0",
    "pulse-card-bg": "#FBF9FD",
    "pulse-control-hover-bg": "rgba(82,82,118,0.065)",
    "pulse-empty-bg": "#E9E7F2",
    "pulse-heat-high-opacity": "0.85",
    "pulse-heat-low-opacity": "0.38",
    "pulse-heat-medium-opacity": "0.62",
    // P-Heat: missed-day is a destructive streak-break signal. It was a ~12% red
    // film (≈1.2:1 vs the empty cell — invisible). Make it an opaque brighter
    // danger fill (status-danger #BE3C48 = 4.37:1 vs pulse-empty-bg) so the gap
    // reads as a real break; the P-Heat consumer also adds an inset danger ring
    // shape cue on light.
    "pulse-missed-bg": "#BE3C48",
    "pulse-range-bg": "#E9E7F2",
    "pulse-ring-offset": "#FBF9FD",
    "pulse-skeleton-gradient": "linear-gradient(90deg, #D8D5E6 25%, #E6E3F1 50%, #D8D5E6 75%)",
    // S1: the settings dialog body was pinned at #FBF9FD (= elevated, L 0.985 —
    // the ceiling), so cards/list-items that default to surface-panel-elevated
    // collapsed flush into the body. Recess the body to #EDEBF4 (= surface-panel)
    // so cards on the elevated plane lift above it (the S1 "cards above the dialog
    // body" model). Card/list-item bg are intentionally left unset — they inherit
    // the surface-panel-elevated fallback the S1 consumer ships.
    "settings-dialog-bg": "#EDEBF4",
    "dialog-header-bg": "rgba(222,219,234,0.55)",
    "settings-kbd-bg": "#E2DFEE",
    // S1: the single load-bearing accent in the settings nav is the 2px marker
    // (before:bg-daintree-accent). The active-row FILL must not be a second accent
    // cue, so drop the accent-rgb tint (was rgba(110,87,219,0.16)) for a NEUTRAL
    // elevated hex (#F4F2FA, L 0.965 — a lift over the recessed nav). The accent
    // inset ring (settings-nav-active-shadow) is retired below.
    "settings-nav-active-bg": "#F4F2FA",
    "settings-nav-hover-bg": "rgba(82,82,118,0.065)",
    "settings-search-bg": "#FAF8FD",
    "settings-sidebar-bg": "rgba(214,211,227,0.78)",
    "sidebar-action-hover-bg": "rgba(82,82,118,0.065)",
    // Issue 1: the selected worktree row must ELEVATE on light, not darken. These
    // were rgba(0,0,0,*) ink (the selected row sank below its own recessed
    // sidebar container — grime, not lift). Replace with OPAQUE surfaces stepping
    // UP from the sidebar (L 0.898): hover #EBE9F3 (L 0.939, dL +0.040) then
    // selected #F8F6FC (L 0.976, dL +0.078 vs sidebar, +0.038 vs hover) — idle <
    // hover < selected, every step clearing the JND. The sidebar.css consumer
    // pairs this lift with a border-strong containment edge. NOTE: this trips the
    // extensionRegistry SIDEBAR_ACTIVE/SIDEBAR_HOVER perceptibility guard, which
    // still mandates the old rgba(0,0,0,*) darken form — see flagged notes.
    "sidebar-active-bg": "#F8F6FC",
    "sidebar-hover-bg": "#EBE9F3",
    "toolbar-agent-hover-bg": "rgba(82,82,118,0.065)",
    "toolbar-control-hover-bg": "rgba(82,82,118,0.065)",
    "toolbar-control-hover-fg": "#6E57DB",
    "toolbar-divider": "rgba(191,187,210,0.6)",
    "toolbar-project-bg":
      "linear-gradient(180deg, rgba(110,87,219,0.05), rgba(82,82,118,0.05)), linear-gradient(135deg, rgba(255,255,255,0.85), rgba(222,219,234,0.92))",
    "toolbar-project-border": "rgba(191,187,210,0.7)",
    "toolbar-project-chip-bg": "rgba(82,82,118,0.055)",
    "toolbar-project-chip-border": "rgba(191,187,210,0.7)",
    "toolbar-stats-bg": "rgba(82,82,118,0.055)",
    "toolbar-stats-border": "rgba(191,187,210,0.6)",
    "toolbar-stats-divider": "rgba(191,187,210,0.6)",
    "toolbar-stats-hover-bg": "rgba(82,82,118,0.065)",
    "worktree-section-hover-bg": "rgba(82,82,118,0.065)",
    "dock-bg": "#D2CFE0",
    "dock-border": "rgba(82,82,118,0.16)",
    "dock-shadow":
      "inset 0 1px 0 rgba(255,255,255,0.55), 0 -2px 8px rgb(from var(--theme-shadow-color) r g b / 0.35)",
  },
};
