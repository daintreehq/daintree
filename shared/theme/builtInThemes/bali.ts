import type { BuiltInThemeSource } from "../builtInThemeSources.js";

export const theme: BuiltInThemeSource = {
  id: "bali",
  name: "Bali",
  type: "light",
  builtin: true,
  location: "Bali, Indonesia",
  heroImage: "/themes/bali.webp",
  palette: {
    type: "light",
    // Redesign (#9710): the old ramp drowned every surface in a saturated
    // mid-olive (grid..elevated all C≈0.023–0.039 in a dim L≈0.875–0.95 band),
    // so the whole workbench read as one muddy, depressing sheet. The fix keeps
    // Bali's terraced-paddy green IDENTITY but treats saturation as a budget:
    // the chrome rail (grid/sidebar) holds the green, and chroma FALLS as the
    // surface rises so content planes become a clean, sun-bleached sage-white.
    // Lightness is lifted toward near-white the way the Bondi sibling does, and
    // the floating tier reaches #FDFEFA. OKLab L: grid 0.896 → sidebar 0.921 →
    // canvas 0.948 → panel 0.971 → elevated 0.995 (span 0.099, every step
    // ≥ 0.02, panel→elevated is not the weakest lift). Text keeps its warm dark
    // green and clears AA with large margin on every tier.
    surfaces: {
      grid: "#D9E0CB",
      sidebar: "#E2E8D5",
      canvas: "#ECF0E3",
      panel: "#F4F7EE",
      elevated: "#FDFEFA",
    },
    text: {
      primary: "#1D2B1E",
      secondary: "#3F5240",
      muted: "#5C7460",
      inverse: "#FAFCF5",
    },
    border: "rgba(20,40,25,0.16)",
    accent: "#218546",
    accentSecondary: "#3A7A4E",
    status: {
      success: "#188A40",
      warning: "#946400",
      danger: "#C0453A",
      info: "#2E7E8A",
    },
    activity: {
      active: "#0E7D33",
      idle: "#62786A",
      working: "#0E7D33",
      waiting: "#8A6A0C",
    },
    overlayTint: "#142819",
    terminal: {
      background: "#182B1B",
      foreground: "#DCE6D9",
      muted: "#5C8A65",
      cursor: "#C9A84C",
      selection: "rgba(34,130,67,0.30)",
      red: "#E07870",
      green: "#64B884",
      yellow: "#D4A840",
      blue: "#60AACC",
      magenta: "#C080C0",
      cyan: "#44C4AA",
      brightRed: "#F09888",
      brightGreen: "#80D49C",
      brightYellow: "#F0C060",
      brightBlue: "#84C8E4",
      brightMagenta: "#D4A4D8",
      brightCyan: "#68D4BC",
      brightWhite: "#FAFCF5",
    },
    syntax: {
      comment: "#4C6E58",
      punctuation: "#4C6E56",
      number: "#826010",
      string: "#287244",
      operator: "#137258",
      keyword: "#854798",
      function: "#2A6BA2",
      link: "#0C763A",
      quote: "#506E56",
      chip: "#6CC8B0",
    },
    strategy: {
      // Depth on light comes from the lightness ramp + shadows + borders (you
      // can't darken to recede). The engine already defaults light themes to the
      // "light" shadow profile; pinning it here makes the contract explicit and,
      // now that the surfaces are near-white, those soft shadows actually read.
      shadowStyle: "light",
      // 12px / 110% mirrors Bondi: a touch less backdrop saturation than before
      // (was 118) so blurred material overlays don't re-amplify the olive cast
      // over the cleaner surfaces.
      materialBlur: 12,
      materialSaturation: 110,
    },
  },
  tokens: {
    "accent-muted": "rgba(31,130,68,0.30)",
    "accent-soft": "rgba(31,130,68,0.18)",
    "accent-foreground": "#FFFFFF",
    "text-link": "#0C763A",
    "text-placeholder": "#728675",
    // Hairline budget eased a notch (#9710 review): on the lifted ramp the
    // sidebar accumulated too many equally-weighted seams. Divider/subtle relax
    // slightly; strong (containment edges, selected-row marker) stays put.
    "border-divider": "rgba(20,40,25,0.085)",
    "border-interactive": "rgba(31,130,68,0.34)",
    "border-strong": "rgba(20,40,25,0.20)",
    "border-subtle": "rgba(20,40,25,0.075)",
    "category-amber": "oklch(0.62 0.14 65)",
    "category-blue": "oklch(0.58 0.13 242)",
    "category-cyan": "oklch(0.6 0.11 198)",
    "category-green": "oklch(0.59 0.14 152)",
    "category-indigo": "oklch(0.57 0.13 264)",
    "category-orange": "oklch(0.6 0.15 38)",
    "category-pink": "oklch(0.59 0.13 340)",
    "category-purple": "oklch(0.58 0.13 318)",
    "category-rose": "oklch(0.6 0.14 14)",
    "category-teal": "oklch(0.59 0.11 178)",
    "category-violet": "oklch(0.57 0.13 295)",
    "focus-ring": "rgba(31,130,68,0.40)",
    "focus-ring-offset": "3px",
    // Two-layer contact+spread shadow ladder in Bali's green-black ink (same
    // recipe as the sibling light redesigns): the engine's single 6% ambient
    // layer dissolves on the near-white ramp, so cards/popovers/dialogs lift
    // with a crisp contact line plus a soft ambient spread instead of relying
    // on hairlines alone.
    "shadow-ambient": "0 1px 2px rgba(20,40,25,0.10), 0 4px 12px rgba(20,40,25,0.10)",
    "shadow-floating": "0 2px 6px rgba(20,40,25,0.12), 0 14px 36px rgba(20,40,25,0.16)",
    "shadow-dialog": "0 4px 10px rgba(20,40,25,0.13), 0 26px 60px rgba(20,40,25,0.18)",
    // B1: pr-draft / pr-merged / pr-open / pr-closed re-darkened to clear AA
    // (4.5:1) on the panel surface where PR badges render. The GitHub-brand
    // defaults (pr-draft #85909C = 2.82:1, pr-open #188537 = 4.10:1, pr-merged
    // #864BE8 = 4.35:1) failed on bali's near-white panel; these keep the same
    // hue family, lowered in L. The brighter redesign panel only widens their
    // margin (all now ≥ 5:1).
    "pr-closed": "#C81824",
    "pr-draft": "#5E6A77",
    "pr-merged": "#6B3BC0",
    "pr-open": "#137A30",
    // Overlay ladder: NOT overridden (#9710). The old overrides ran every tier
    // 2-3x over the engine's light defaults (hover 0.19 vs 0.065, active 0.28
    // vs 0.11) — alphas raised to survive the old saturated mid-olive ramp.
    // The engine's light ladder is already Weber-tuned (RC-2) and routes
    // through overlayBase (Bali's green-black #142819 tint), so hover/active/
    // selected keep the green identity without re-muddying the lifted ramp.
    // E1 elevate-to-select / overlay-raised: NOT overridden — the engine light
    // default (color-mix elevated 92% + text-primary) applies, same as Bondi.
    // B1 filter-selected: NOT overridden (matches Bondi). The old elevate-style
    // overrides existed to escape the muddy ramp; with panel near-white there is
    // no headroom for two lift steps below the ceiling, and the engine's graded
    // overlayBase darken (8%/12%) separates cleanly on the new panel
    // (ΔE 0.052 / 0.026, both over the 0.02 JND matrix floor).
    // E7: cool-slate-hued, lowered scrims so the modal backdrop dims without a
    // heavy black slab over a near-white workbench.
    "scrim-medium": "rgba(20,40,25,0.36)",
    "scrim-soft": "rgba(20,40,25,0.22)",
    "scrim-strong": "rgba(20,40,25,0.55)",
    "scrollbar-thumb": "#5C7460",
    "scrollbar-thumb-hover": "color-mix(in oklab, #5C7460 80%, #1D2B1E)",
    "search-highlight-background": "rgba(31,130,68,0.18)",
    "search-highlight-text": "#0C763A",
    "search-match-badge-background": "rgba(31,130,68,0.18)",
    "search-match-badge-text": "#0C763A",
    "search-selected-result-border": "#1F8244",
    "search-selected-result-icon": "#0C763A",
    "surface-hover": "rgba(20,40,25,0.19)",
    "surface-active": "rgba(20,40,25,0.28)",
    // E8: input is a recessed inset well, not the brightest object on screen.
    // Sits a hair below the chrome rail (L≈0.912) so fields read recessed on the
    // lifted ramp. Tracks the redesign surfaces.
    "surface-inset": "#E0E4D4",
    "surface-toolbar": "#DFE4D2",
    "terminal-black": "#182B1B",
    "terminal-white": "#DCE6D9",
  },
  extensions: {
    // Empty-grid gutter sits just below the new grid surface so panel tiles read
    // as figure on a receding ground (no figure-ground inversion).
    "panel-grid-bg": "#D6DCC8",
    // S1: dialog body recedes to surface-panel; cards/list-items elevate above
    // it. Repinned to the redesign ramp — body at the new panel, card at the new
    // elevated (+0.024 L) so the lift survives.
    "settings-dialog-bg": "#F4F7EE",
    "settings-card-bg": "#FDFEFA",
    "settings-list-item-bg": "#FDFEFA",
    // Warm-sand Pulse family lightened (#9710 review): the old stops were tuned
    // against the muddy ramp and read beige-brown inside the now near-white
    // card. Same sand hue (Bali beach, hue-distinct from the green heat fills),
    // lifted in L only.
    "pulse-before-bg": "#D9CFB2",
    "pulse-card-bg": "#FDFEFA",
    // Tighter 1px/3px shadow — crisper on the near-white field than the old
    // 2px/6px, which smeared against the darker base.
    "pulse-card-shadow": "0 1px 3px rgba(23,33,48,0.10)",
    "pulse-control-hover-bg": "rgba(20,40,25,0.06)",
    // P-Heat: empty cell stays warm-sand (separate hue from the sage surfaces
    // and the green heat fills) so worked vs empty days separate by hue, not
    // just alpha; lightened so the missed-day danger fill now clears 4.06:1.
    "pulse-empty-bg": "#EDE6D3",
    "pulse-heat-high-opacity": "0.85",
    "pulse-heat-low-opacity": "0.38",
    "pulse-heat-medium-opacity": "0.62",
    // P-Heat missed-day (streak break): opaque brighter danger fill clearing
    // 3:1; the shape-cue inset ring is added by the component on light.
    "pulse-missed-bg": "#C0453A",
    "pulse-range-bg": "#ECF0E3",
    "pulse-ring-offset": "#FDFEFA",
    "pulse-skeleton-gradient": "linear-gradient(90deg, #E0D8C0 25%, #EAE3D2 50%, #E0D8C0 75%)",
    "settings-kbd-bg": "#ECF0E3",
    "settings-search-bg": "#ECF0E3",
    // S1: single accent anchor is the 2px nav marker (SettingsDialog.tsx). The
    // active-nav FILL is a NEUTRAL elevated lift (no accent rgb), repinned to the
    // new panel level.
    "settings-nav-active-bg": "#F4F7EE",
    "settings-nav-hover-bg": "rgba(20,40,25,0.07)",
    "sidebar-action-hover-bg": "rgba(20,40,25,0.07)",
    // Issue 1 + #9710: the sidebar is now a clearly-tinted green chrome rail
    // (L 0.921) distinct from the airy canvas, so its states have room to step.
    // Selection ELEVATES to a near-elevated card plane (#FAFBF5, +0.065 L over
    // the rail) and hover sits at the canvas level (+0.027), giving a clean
    // idle < hover < selected stair. The sidebar.css left-marker is
    // border-strong (containment edge); accent is never used for membership.
    // NOTE: extensionRegistry SIDEBAR_ACTIVE/SIDEBAR_HOVER still enforce the OLD
    // rgba(0,0,0,*) darken contract — these opaque lift values require the
    // registry owner to update that governance (flagged, pre-existing).
    "sidebar-active-bg": "#FAFBF5",
    "sidebar-hover-bg": "#ECF0E3",
    "toolbar-agent-hover-bg": "rgba(20,40,25,0.07)",
    "toolbar-control-hover-bg": "rgba(20,40,25,0.07)",
    "toolbar-control-hover-fg": "#1F8244",
    "toolbar-divider": "rgba(20,40,25,0.10)",
    "toolbar-project-bg":
      "linear-gradient(180deg, rgba(31,130,68,0.05), rgba(20,40,25,0.07)), linear-gradient(135deg, #DFE4D2, #D9E0CB)",
    "toolbar-project-border": "rgba(20,40,25,0.10)",
    "toolbar-project-chip-bg": "rgba(20,40,25,0.08)",
    "toolbar-project-chip-border": "rgba(20,40,25,0.10)",
    "toolbar-project-shadow": "inset 0 1px 0 rgba(255,255,255,0.30)",
    "toolbar-stats-bg": "rgba(20,40,25,0.06)",
    "toolbar-stats-border": "rgba(20,40,25,0.09)",
    "toolbar-stats-divider": "rgba(20,40,25,0.09)",
    "toolbar-stats-hover-bg": "rgba(20,40,25,0.07)",
    "worktree-section-hover-bg": "rgba(20,40,25,0.07)",
  },
};
