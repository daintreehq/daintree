import type { BuiltInThemeSource } from "../builtInThemeSources.js";

export const theme: BuiltInThemeSource = {
  id: "galapagos",
  name: "Galápagos",
  type: "dark",
  builtin: true,
  location: "Galápagos Islands, Ecuador",
  heroImage: "/themes/galapagos.webp",
  palette: {
    type: "dark",
    surfaces: {
      grid: "#0A0D0C",
      sidebar: "#111615",
      canvas: "#161D1B",
      panel: "#1A2421",
      elevated: "#23322E",
    },
    text: {
      primary: "#DCE6E3",
      secondary: "#9AB0A9",
      muted: "#7A8C87",
      inverse: "#161D1B",
    },
    border: "#2A3A35",
    accent: "#4A9E7F",
    // Coral second lane: keep H well clear of danger clay (#D17B72) so the
    // lanes never alias; ≥ 3:1 on every surface.
    accentSecondary: "#EB7A4D",
    status: {
      success: "#5A8068",
      warning: "#C99F59",
      danger: "#D17B72",
      info: "#759DB0",
    },
    activity: {
      active: "#32C781",
      idle: "#536660",
      working: "#32C781",
      waiting: "#F2B850",
    },
    overlayTint: "#8CC8B4",
    terminal: {
      // ANSI set is audited against this background, not the canvas (all ≥ 3:1).
      background: "#0D1416",
      foreground: "#DCE6E3",
      // Keep the cursor hue-distinct from ANSI red so it never aliases danger.
      cursor: "#F4683C",
      // Cyan-glass selection, deliberately not the accent green.
      selection: "rgba(74,176,184,0.22)",
      red: "#D17B72",
      green: "#4A9E7F",
      yellow: "#C99F59",
      blue: "#5BB5D9",
      magenta: "#9B7FBF",
      cyan: "#4AB0B8",
      brightRed: "#E8907F",
      brightGreen: "#32C781",
      brightYellow: "#F2B850",
      brightBlue: "#8DCDE8",
      brightMagenta: "#B89FD4",
      brightCyan: "#6BBFA8",
      brightWhite: "#DCE6E3",
    },
    syntax: {
      comment: "#5A7268",
      punctuation: "#A8BDB8",
      number: "#C99F59",
      string: "#6AAF8A",
      operator: "#5AC0C8",
      keyword: "#9B7FBF",
      function: "#5BB5D9",
      link: "#68AEC4",
      quote: "#9AB0A9",
      chip: "#4A9E7F",
    },
    strategy: {
      shadowStyle: "crisp",
      materialBlur: 8,
      materialSaturation: 110,
      radiusScale: 0.95,
      grainCharacter: "coarse",
    },
  },
  tokens: {
    "border-divider": "rgba(140,200,180,0.05)",
    // Must stay above `border-strong`: interactive is the lift a control shows
    // on focus or hover, and several resting borders (the palette input among
    // them) sit at strong. At 0.12 the lift landed *below* the resting state, so
    // focusing the palette search box faded its own border. 0.30 over a 0.20
    // resting border is the same ~1.5x step every other built-in theme keeps.
    "border-interactive": "rgba(140,200,180,0.30)",
    "border-strong": "rgba(140,200,180,0.20)",
    "border-subtle": "rgba(140,200,180,0.08)",
    "focus-ring": "rgba(74,158,127,0.50)",
    // Boldest authored grain in the catalog; stays under the 0.05 ceiling.
    "grain-opacity": "0.04",
    "scrim-blur": "4px",
    "scrim-blur-palette": "2px",
    "scrim-medium": "rgba(6,12,10,0.50)",
    "scrim-soft": "rgba(6,12,10,0.25)",
    "scrim-strong": "rgba(6,12,10,0.70)",
    "scrollbar-thumb": "#536660",
    "scrollbar-thumb-hover": "color-mix(in oklab, #536660 85%, #DCE6E3)",
    "search-highlight-background": "rgba(91,181,217,0.18)",
    "search-highlight-text": "#5BB5D9",
    "search-match-badge-background": "rgba(91,181,217,0.16)",
    "search-match-badge-text": "#5BB5D9",
    "search-selected-result-border": "#5BB5D9",
    "search-selected-result-icon": "#5BB5D9",
    // Tight contact shadows, high alpha, no spread — matches the crisp strategy.
    "shadow-ambient": "0 1px 2px rgba(6,12,10,0.50), 0 1px 1px rgba(6,12,10,0.35)",
    "shadow-color": "rgba(6,12,10,0.60)",
    "shadow-dialog": "inset 0 1px 0 rgba(140,200,180,0.06), 0 18px 48px rgba(6,12,10,0.62)",
    "shadow-floating": "0 2px 6px rgba(6,12,10,0.45), 0 8px 20px rgba(6,12,10,0.50)",
    "surface-toolbar": "#111615",
  },
  extensions: {
    "dock-bg": "#111615",
    // Active dock pill shares the panel-focus ink, keeping accent green scarce
    // in chrome.
    "dock-item-bg-active": "rgba(140,200,180,0.10)",
    // Membership marker, not a second focus anchor — keep it below
    // panel-focus-border brightness.
    "dock-item-border-active": "rgba(176,216,202,0.38)",
    // Focus chrome inked from the overlayTint water-light; no other
    // accent-family fill may appear in the panel region, and selected/focused
    // share this one ink. Outer-only (inset rings read as a defect on panes).
    "panel-focus-border": "rgba(176,216,202,0.38)",
    "panel-focus-shadow": "0 0 0 1px rgba(140,200,180,0.16)",
    "pulse-before-bg": "#0E1211",
    "pulse-card-bg": "#1A2421",
    "pulse-card-shadow": "0 1px 2px rgba(6,12,10,0.50), 0 1px 1px rgba(6,12,10,0.35)",
    "pulse-control-hover-bg": "rgba(255,255,255,0.05)",
    "pulse-empty-bg": "#1F2D29",
    // Sea-green heat ramp climbing to the accent at heat-4.
    "pulse-heat-1": "#1F332B",
    "pulse-heat-2": "#2D5747",
    "pulse-heat-3": "#377B62",
    "pulse-heat-4": "#4A9E7F",
    "pulse-heat-color": "#4A9E7F",
    "pulse-range-bg": "#161D1B",
    "pulse-ring-offset": "#1A2421",
    "pulse-skeleton-gradient": "linear-gradient(90deg, #23322E 25%, #2C3D38 50%, #23322E 75%)",
    "settings-dialog-bg": "#23322E",
    "settings-kbd-bg": "#21302C",
    "settings-nav-active-bg": "rgba(74,158,127,0.15)",
    "settings-nav-hover-bg": "rgba(255,255,255,0.04)",
    "settings-search-bg": "#21302C",
    "settings-sidebar-bg": "rgba(17,22,21,0.70)",
    // Composited settings-sidebar-bg over the shell.
    "settings-sidebar-scroll-fade": "#161E1C",
    "sidebar-action-hover-bg": "rgba(255,255,255,0.05)",
    "sidebar-active-bg": "rgba(255,255,255,0.05)",
    "sidebar-hover-bg": "rgba(255,255,255,0.03)",
    "toolbar-agent-hover-bg": "rgba(255,255,255,0.06)",
    // Hover/armed are neutral light, never accent — the accent keeps one
    // membership fill per region (settings-nav-active-bg). Armed/active hold
    // the +0.04 alpha step over hover.
    "toolbar-control-active-bg": "rgba(255,255,255,0.12)",
    "toolbar-control-armed-bg": "rgba(255,255,255,0.12)",
    "toolbar-control-armed-shadow": "inset 0 0 0 1px rgba(255,255,255,0.12)",
    "toolbar-control-hover-bg": "rgba(255,255,255,0.05)",
    "toolbar-divider": "rgba(42,58,53,0.5)",
    "toolbar-project-bg":
      "linear-gradient(180deg, rgba(140,200,180,0.06), rgba(6,12,10,0.02)), rgba(255,255,255,0.04)",
    "toolbar-project-border": "rgba(42,58,53,0.5)",
    "toolbar-project-chip-bg": "rgba(255,255,255,0.04)",
    "toolbar-project-chip-border": "rgba(42,58,53,0.5)",
    "toolbar-project-shadow": "none",
    "toolbar-stats-bg": "rgba(255,255,255,0.04)",
    "toolbar-stats-border": "rgba(42,58,53,0.5)",
    "toolbar-stats-divider": "rgba(42,58,53,0.5)",
    "toolbar-stats-hover-bg": "rgba(255,255,255,0.08)",
    "welcome-mark-color": "#F4683C",
    "worktree-section-hover-bg": "rgba(255,255,255,0.03)",
  },
};
