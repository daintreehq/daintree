import type {
  AppColorScheme,
  AppColorSchemeTokens,
  AppThemeTokenKey,
  AppThemeValidationWarning,
} from "./types.js";

export const DEFAULT_APP_SCHEME_ID = "daintree";

const GITHUB_DARK_TOKENS: Pick<
  AppColorSchemeTokens,
  "github-open" | "github-merged" | "github-closed" | "github-draft"
> = {
  "github-open": "#3fb950",
  "github-merged": "#a371f7",
  "github-closed": "#f85149",
  "github-draft": "#8b949e",
};

const GITHUB_LIGHT_TOKENS: Pick<
  AppColorSchemeTokens,
  "github-open" | "github-merged" | "github-closed" | "github-draft"
> = {
  "github-open": "#1A7F37",
  "github-merged": "#8250DF",
  "github-closed": "#CF222E",
  "github-draft": "#8B949E",
};

export function createCanopyTokens(
  type: "dark" | "light",
  tokens: Partial<AppColorSchemeTokens> &
    Pick<
      AppColorSchemeTokens,
      | "surface-canvas"
      | "surface-sidebar"
      | "surface-panel"
      | "surface-panel-elevated"
      | "surface-grid"
      | "text-primary"
      | "text-secondary"
      | "text-muted"
      | "text-inverse"
      | "border-default"
      | "accent-primary"
      | "status-success"
      | "status-warning"
      | "status-danger"
      | "status-info"
      | "activity-active"
      | "activity-idle"
      | "activity-working"
      | "activity-waiting"
      | "terminal-selection"
      | "terminal-red"
      | "terminal-green"
      | "terminal-yellow"
      | "terminal-blue"
      | "terminal-magenta"
      | "terminal-cyan"
      | "terminal-bright-red"
      | "terminal-bright-green"
      | "terminal-bright-yellow"
      | "terminal-bright-blue"
      | "terminal-bright-magenta"
      | "terminal-bright-cyan"
      | "terminal-bright-white"
      | "syntax-comment"
      | "syntax-punctuation"
      | "syntax-number"
      | "syntax-string"
      | "syntax-operator"
      | "syntax-keyword"
      | "syntax-function"
      | "syntax-link"
      | "syntax-quote"
      | "syntax-chip"
    >
): AppColorSchemeTokens {
  const dark = type === "dark";
  const overlayTone = dark ? "#ffffff" : "#000000";
  // overlay-base tints the entire hover/fill ladder. Defaults to overlayTone (pure
  // white/black). Set to a hued color for themed overlays (icy blue, warm cream, etc.).
  const overlayBase = tokens["overlay-base"] ?? overlayTone;
  const accentSoft =
    tokens["accent-soft"] ?? withAlpha(tokens["accent-primary"], dark ? 0.18 : 0.12);
  const accentMuted =
    tokens["accent-muted"] ?? withAlpha(tokens["accent-primary"], dark ? 0.3 : 0.2);
  const accentRgb = tokens["accent-primary"].startsWith("#")
    ? hexToRgbTriplet(tokens["accent-primary"])
    : "0, 0, 0";
  const tint = dark ? "#ffffff" : "#000000";
  const accentSecondary = tokens["accent-secondary"] ?? tokens["status-success"];
  const accentSecondarySoft =
    tokens["accent-secondary-soft"] ?? withAlpha(accentSecondary, dark ? 0.15 : 0.1);
  const accentSecondaryMuted =
    tokens["accent-secondary-muted"] ?? withAlpha(accentSecondary, dark ? 0.25 : 0.18);

  const githubDefaults = dark ? GITHUB_DARK_TOKENS : GITHUB_LIGHT_TOKENS;

  const searchHighlightBg =
    tokens["search-highlight-background"] ?? withAlpha(tokens["accent-primary"], dark ? 0.2 : 0.12);
  const searchHighlightText = tokens["search-highlight-text"] ?? tokens["status-success"];

  const categoryDefaults = dark
    ? {
        "category-blue": "oklch(0.7 0.13 250)",
        "category-purple": "oklch(0.7 0.13 310)",
        "category-cyan": "oklch(0.72 0.11 215)",
        "category-green": "oklch(0.7 0.13 145)",
        "category-amber": "oklch(0.73 0.14 75)",
        "category-orange": "oklch(0.7 0.14 45)",
        "category-teal": "oklch(0.7 0.11 185)",
        "category-indigo": "oklch(0.7 0.13 275)",
        "category-rose": "oklch(0.7 0.14 5)",
        "category-pink": "oklch(0.72 0.13 340)",
        "category-violet": "oklch(0.7 0.13 295)",
        "category-slate": "oklch(0.65 0.04 240)",
      }
    : {
        "category-blue": "oklch(0.55 0.14 242)",
        "category-purple": "oklch(0.55 0.14 318)",
        "category-cyan": "oklch(0.56 0.11 198)",
        "category-green": "oklch(0.55 0.14 155)",
        "category-amber": "oklch(0.58 0.15 65)",
        "category-orange": "oklch(0.56 0.16 38)",
        "category-teal": "oklch(0.55 0.12 178)",
        "category-indigo": "oklch(0.54 0.14 264)",
        "category-rose": "oklch(0.56 0.15 14)",
        "category-pink": "oklch(0.55 0.14 340)",
        "category-violet": "oklch(0.54 0.14 295)",
        "category-slate": "oklch(0.50 0.03 228)",
      };

  return {
    ...githubDefaults,
    ...categoryDefaults,
    "border-subtle": tokens["border-subtle"] ?? withAlpha(overlayTone, dark ? 0.08 : 0.05),
    "border-strong": tokens["border-strong"] ?? withAlpha(overlayTone, dark ? 0.14 : 0.14),
    "border-divider": tokens["border-divider"] ?? withAlpha(overlayTone, dark ? 0.05 : 0.04),
    "border-interactive": tokens["border-interactive"] ?? withAlpha(overlayTone, dark ? 0.2 : 0.1),
    "accent-foreground": tokens["accent-foreground"] ?? tokens["text-inverse"],
    "accent-hover":
      tokens["accent-hover"] ??
      `color-mix(in oklab, ${tokens["accent-primary"]} 90%, ${dark ? "#ffffff" : "#000000"})`,
    "accent-soft": accentSoft,
    "accent-muted": accentMuted,
    "accent-rgb": tokens["accent-rgb"] ?? accentRgb,
    "focus-ring": tokens["focus-ring"] ?? withAlpha(overlayTone, dark ? 0.18 : 0.18),
    "overlay-base": tokens["overlay-base"] ?? overlayTone,
    "overlay-subtle": tokens["overlay-subtle"] ?? withAlpha(overlayBase, dark ? 0.02 : 0.02),
    "overlay-soft": tokens["overlay-soft"] ?? withAlpha(overlayBase, dark ? 0.03 : 0.03),
    "overlay-medium": tokens["overlay-medium"] ?? withAlpha(overlayBase, dark ? 0.04 : 0.05),
    "overlay-strong": tokens["overlay-strong"] ?? withAlpha(overlayBase, dark ? 0.06 : 0.08),
    "overlay-emphasis": tokens["overlay-emphasis"] ?? withAlpha(overlayBase, dark ? 0.1 : 0.12),
    "scrim-soft": tokens["scrim-soft"] ?? (dark ? "rgba(0, 0, 0, 0.2)" : "rgba(0, 0, 0, 0.3)"),
    "scrim-medium": tokens["scrim-medium"] ?? (dark ? "rgba(0, 0, 0, 0.45)" : "rgba(0, 0, 0, 0.5)"),
    "scrim-strong": tokens["scrim-strong"] ?? (dark ? "rgba(0, 0, 0, 0.62)" : "rgba(0, 0, 0, 0.7)"),
    "shadow-color": tokens["shadow-color"] ?? (dark ? "rgba(0, 0, 0, 0.5)" : "rgba(0, 0, 0, 0.12)"),
    tint: tokens["tint"] ?? tint,
    "activity-approval": tokens["activity-approval"] ?? (dark ? "#f97316" : "#C56210"),
    "activity-completed": tokens["activity-completed"] ?? tokens["status-success"],
    "activity-failed": tokens["activity-failed"] ?? tokens["status-danger"],
    "terminal-background": tokens["terminal-background"] ?? tokens["surface-canvas"],
    "terminal-foreground": tokens["terminal-foreground"] ?? tokens["text-primary"],
    "terminal-muted": tokens["terminal-muted"] ?? tokens["text-muted"],
    "terminal-cursor": tokens["terminal-cursor"] ?? tokens["accent-primary"],
    "terminal-cursor-accent":
      tokens["terminal-cursor-accent"] ?? tokens["terminal-background"] ?? tokens["surface-canvas"],
    "terminal-black":
      tokens["terminal-black"] ?? (dark ? tokens["surface-canvas"] : tokens["text-primary"]),
    "terminal-white":
      tokens["terminal-white"] ?? (dark ? tokens["text-primary"] : tokens["surface-canvas"]),
    "terminal-bright-black": tokens["terminal-bright-black"] ?? tokens["activity-idle"],
    "surface-toolbar":
      tokens["surface-toolbar"] ??
      `color-mix(in oklab, ${tokens["surface-sidebar"]} ${dark ? "67%" : "40%"}, ${tokens["surface-canvas"]})`,
    "surface-input":
      tokens["surface-input"] ??
      (dark ? tokens["surface-panel-elevated"] : tokens["surface-panel"]),
    "surface-inset": tokens["surface-inset"] ?? withAlpha(overlayTone, dark ? 0.03 : 0.04),
    "surface-hover": tokens["surface-hover"] ?? withAlpha(overlayTone, dark ? 0.05 : 0.03),
    "surface-active": tokens["surface-active"] ?? withAlpha(overlayTone, dark ? 0.08 : 0.06),
    "text-placeholder":
      tokens["text-placeholder"] ?? withAlpha(tokens["text-primary"], dark ? 0.35 : 0.32),
    "text-link": tokens["text-link"] ?? tokens["accent-primary"],
    "accent-secondary": accentSecondary,
    "accent-secondary-soft": accentSecondarySoft,
    "accent-secondary-muted": accentSecondaryMuted,
    "search-highlight-background": searchHighlightBg,
    "search-highlight-text": tokens["search-highlight-text"] ?? searchHighlightText,
    "search-selected-result-border":
      tokens["search-selected-result-border"] ?? tokens["accent-primary"],
    "search-selected-result-icon":
      tokens["search-selected-result-icon"] ?? tokens["accent-primary"],
    "search-match-badge-background": tokens["search-match-badge-background"] ?? accentSoft,
    "search-match-badge-text": tokens["search-match-badge-text"] ?? tokens["accent-primary"],
    "recipe-state-chip-bg-opacity":
      tokens["recipe-state-chip-bg-opacity"] ?? (dark ? "0.15" : "0.12"),
    "recipe-state-chip-border-opacity":
      tokens["recipe-state-chip-border-opacity"] ?? (dark ? "0.40" : "0.35"),
    "recipe-label-pill-bg-opacity":
      tokens["recipe-label-pill-bg-opacity"] ?? (dark ? "0.10" : "0.08"),
    "recipe-label-pill-border-opacity":
      tokens["recipe-label-pill-border-opacity"] ?? (dark ? "0.20" : "0.15"),
    "recipe-button-inset-shadow":
      tokens["recipe-button-inset-shadow"] ??
      (dark
        ? "inset 0 1px 0 rgba(255, 255, 255, 0.06)"
        : "inset 0 1px 0 rgba(255, 255, 255, 0.15)"),
    "recipe-scrollbar-width": tokens["recipe-scrollbar-width"] ?? "6px",
    "recipe-scrollbar-thumb":
      tokens["recipe-scrollbar-thumb"] ?? withAlpha(overlayTone, dark ? 0.2 : 0.18),
    "recipe-scrollbar-thumb-hover":
      tokens["recipe-scrollbar-thumb-hover"] ?? withAlpha(overlayTone, dark ? 0.35 : 0.28),
    "recipe-scrollbar-track": tokens["recipe-scrollbar-track"] ?? "transparent",
    "recipe-panel-state-edge-width":
      tokens["recipe-panel-state-edge-width"] ?? (dark ? "0px" : "2px"),
    "recipe-panel-state-edge-inset-block": tokens["recipe-panel-state-edge-inset-block"] ?? "4px",
    "recipe-panel-state-edge-radius": tokens["recipe-panel-state-edge-radius"] ?? "2px",
    "recipe-control-chrome-raised-shadow":
      tokens["recipe-control-chrome-raised-shadow"] ??
      (dark
        ? "0 4px 12px rgba(0, 0, 0, 0.5), 0 1px 3px rgba(0, 0, 0, 0.3)"
        : "0 4px 12px rgba(0, 0, 0, 0.12), 0 1px 3px rgba(0, 0, 0, 0.08)"),
    "recipe-control-chrome-pressed-shadow":
      tokens["recipe-control-chrome-pressed-shadow"] ??
      (dark ? "inset 0 1px 2px rgba(0, 0, 0, 0.3)" : "inset 0 1px 2px rgba(0, 0, 0, 0.08)"),
    "recipe-surface-elevated-inset-shadow":
      tokens["recipe-surface-elevated-inset-shadow"] ??
      (dark
        ? "inset 0 1px 0 0 rgba(255, 255, 255, 0.03)"
        : "inset 0 1px 0 rgba(255, 255, 255, 0.60)"),
    "recipe-shadow-ambient":
      tokens["recipe-shadow-ambient"] ??
      (dark
        ? "0 1px 3px rgba(0, 0, 0, 0.3), 0 1px 2px rgba(0, 0, 0, 0.2)"
        : "0 2px 8px rgba(0, 0, 0, 0.06)"),
    "recipe-shadow-floating":
      tokens["recipe-shadow-floating"] ??
      (dark
        ? "0 4px 12px rgba(0, 0, 0, 0.5), 0 1px 3px rgba(0, 0, 0, 0.3)"
        : "0 4px 12px rgba(0, 0, 0, 0.12), 0 1px 3px rgba(0, 0, 0, 0.08)"),
    "recipe-dialog-shadow":
      tokens["recipe-dialog-shadow"] ??
      tokens["recipe-shadow-floating"] ??
      (dark
        ? "0 4px 12px rgba(0, 0, 0, 0.5), 0 1px 3px rgba(0, 0, 0, 0.3)"
        : "0 4px 12px rgba(0, 0, 0, 0.12), 0 1px 3px rgba(0, 0, 0, 0.08)"),
    "recipe-toolbar-shadow": tokens["recipe-toolbar-shadow"] ?? "none",
    "recipe-toolbar-control-hover-bg":
      tokens["recipe-toolbar-control-hover-bg"] ??
      (dark
        ? (tokens["overlay-strong"] ?? withAlpha(overlayBase, 0.08))
        : (tokens["surface-hover"] ?? withAlpha(overlayBase, 0.03))),
    "recipe-toolbar-control-hover-fg":
      tokens["recipe-toolbar-control-hover-fg"] ?? tokens["accent-primary"],
    "recipe-toolbar-control-hover-shadow": tokens["recipe-toolbar-control-hover-shadow"] ?? "none",
    "recipe-toolbar-agent-hover-bg":
      tokens["recipe-toolbar-agent-hover-bg"] ??
      tokens["recipe-toolbar-control-hover-bg"] ??
      (dark
        ? (tokens["overlay-strong"] ?? withAlpha(overlayBase, 0.08))
        : (tokens["surface-hover"] ?? withAlpha(overlayBase, 0.03))),
    "recipe-toolbar-divider":
      tokens["recipe-toolbar-divider"] ??
      tokens["border-divider"] ??
      withAlpha(tokens["border-default"], 0.5),
    "recipe-toolbar-pill-radius": tokens["recipe-toolbar-pill-radius"] ?? "0.5rem",
    "recipe-toolbar-project-bg":
      tokens["recipe-toolbar-project-bg"] ??
      `linear-gradient(180deg, ${withAlpha(overlayBase, dark ? 0.04 : 0.02)}, ${withAlpha(
        overlayBase,
        dark ? 0.06 : 0.05
      )}), linear-gradient(135deg, ${tokens["surface-canvas"]}, ${tokens["surface-sidebar"]})`,
    "recipe-toolbar-project-border":
      tokens["recipe-toolbar-project-border"] ?? withAlpha(tokens["border-default"], 0.6),
    "recipe-toolbar-project-shadow":
      tokens["recipe-toolbar-project-shadow"] ?? tokens["recipe-button-inset-shadow"] ?? "none",
    "recipe-toolbar-project-chip-bg":
      tokens["recipe-toolbar-project-chip-bg"] ??
      tokens["overlay-soft"] ??
      withAlpha(overlayBase, dark ? 0.05 : 0.04),
    "recipe-toolbar-project-chip-border":
      tokens["recipe-toolbar-project-chip-border"] ??
      tokens["recipe-toolbar-project-border"] ??
      withAlpha(tokens["border-default"], 0.6),
    "recipe-toolbar-project-meta-fg":
      tokens["recipe-toolbar-project-meta-fg"] ?? tokens["text-secondary"],
    "recipe-toolbar-project-chip-size":
      tokens["recipe-toolbar-project-chip-size"] ?? (dark ? "10px" : "11px"),
    "recipe-toolbar-stats-bg":
      tokens["recipe-toolbar-stats-bg"] ??
      tokens["overlay-soft"] ??
      withAlpha(overlayBase, dark ? 0.05 : 0.04),
    "recipe-toolbar-stats-border":
      tokens["recipe-toolbar-stats-border"] ?? withAlpha(tokens["border-default"], 0.5),
    "recipe-toolbar-stats-divider":
      tokens["recipe-toolbar-stats-divider"] ??
      tokens["recipe-toolbar-stats-border"] ??
      withAlpha(tokens["border-default"], 0.5),
    "recipe-toolbar-stats-shadow": tokens["recipe-toolbar-stats-shadow"] ?? "none",
    "recipe-toolbar-stats-hover-bg":
      tokens["recipe-toolbar-stats-hover-bg"] ??
      tokens["recipe-toolbar-control-hover-bg"] ??
      (dark
        ? (tokens["overlay-strong"] ?? withAlpha(overlayBase, 0.08))
        : (tokens["surface-hover"] ?? withAlpha(overlayBase, 0.03))),
    "recipe-focus-ring-offset": tokens["recipe-focus-ring-offset"] ?? "2px",
    "recipe-sidebar-active-bg":
      tokens["recipe-sidebar-active-bg"] ??
      (dark ? withAlpha(overlayBase, 0.04) : tokens["surface-panel-elevated"]),
    "recipe-sidebar-active-shadow":
      tokens["recipe-sidebar-active-shadow"] ??
      (dark
        ? (tokens["recipe-surface-elevated-inset-shadow"] ??
          "inset 0 1px 0 0 rgba(255, 255, 255, 0.03)")
        : (tokens["recipe-shadow-ambient"] ?? "0 2px 8px rgba(0, 0, 0, 0.06)")),
    "recipe-sidebar-hover-bg":
      tokens["recipe-sidebar-hover-bg"] ??
      tokens["overlay-subtle"] ??
      withAlpha(overlayBase, dark ? 0.02 : 0.02),
    "recipe-sidebar-action-hover-bg":
      tokens["recipe-sidebar-action-hover-bg"] ??
      tokens["recipe-sidebar-hover-bg"] ??
      tokens["overlay-soft"] ??
      withAlpha(overlayBase, dark ? 0.03 : 0.03),
    "recipe-pulse-card-bg":
      tokens["recipe-pulse-card-bg"] ??
      (dark ? tokens["surface-sidebar"] : tokens["surface-panel-elevated"]),
    "recipe-pulse-card-shadow":
      tokens["recipe-pulse-card-shadow"] ?? (dark ? "none" : "0 1px 3px rgba(0, 0, 0, 0.08)"),
    "recipe-pulse-range-bg":
      tokens["recipe-pulse-range-bg"] ??
      (dark ? tokens["surface-panel-elevated"] : tokens["surface-canvas"]),
    "recipe-pulse-control-hover-bg":
      tokens["recipe-pulse-control-hover-bg"] ??
      tokens["overlay-subtle"] ??
      withAlpha(overlayBase, dark ? 0.04 : 0.05),
    "recipe-pulse-before-bg":
      tokens["recipe-pulse-before-bg"] ??
      (dark ? tokens["surface-canvas"] : (tokens["surface-sidebar"] ?? tokens["surface-canvas"])),
    "recipe-pulse-empty-bg":
      tokens["recipe-pulse-empty-bg"] ??
      (dark ? tokens["surface-panel-elevated"] : tokens["surface-panel"]),
    "recipe-pulse-missed-bg":
      tokens["recipe-pulse-missed-bg"] ?? withAlpha(tokens["status-danger"], dark ? 0.18 : 0.1),
    "recipe-pulse-heat-low-opacity":
      tokens["recipe-pulse-heat-low-opacity"] ?? (dark ? "0.25" : "0.18"),
    "recipe-pulse-heat-medium-opacity":
      tokens["recipe-pulse-heat-medium-opacity"] ?? (dark ? "0.45" : "0.35"),
    "recipe-pulse-heat-high-opacity":
      tokens["recipe-pulse-heat-high-opacity"] ?? (dark ? "0.70" : "0.55"),
    "recipe-pulse-ring-offset":
      tokens["recipe-pulse-ring-offset"] ??
      tokens["recipe-pulse-card-bg"] ??
      (dark ? tokens["surface-sidebar"] : tokens["surface-panel-elevated"]),
    "recipe-pulse-skeleton-gradient":
      tokens["recipe-pulse-skeleton-gradient"] ??
      `linear-gradient(90deg, ${tokens["recipe-pulse-empty-bg"] ?? (dark ? tokens["surface-panel-elevated"] : tokens["surface-panel"])} 25%, ${tokens["surface-panel"]} 50%, ${tokens["recipe-pulse-empty-bg"] ?? (dark ? tokens["surface-panel-elevated"] : tokens["surface-panel"])} 75%)`,
    "recipe-settings-dialog-bg":
      tokens["recipe-settings-dialog-bg"] ??
      (dark ? tokens["surface-panel"] : tokens["surface-panel"]),
    "recipe-settings-search-bg":
      tokens["recipe-settings-search-bg"] ??
      tokens["surface-input"] ??
      (dark ? tokens["surface-panel-elevated"] : tokens["surface-panel"]),
    "recipe-settings-search-muted":
      tokens["recipe-settings-search-muted"] ??
      (dark ? tokens["text-secondary"] : tokens["text-muted"]),
    "recipe-settings-meta-fg":
      tokens["recipe-settings-meta-fg"] ??
      (dark ? withAlpha(tokens["text-primary"], 0.3) : tokens["text-muted"]),
    "recipe-settings-meta-size": tokens["recipe-settings-meta-size"] ?? (dark ? "10px" : "11px"),
    "recipe-settings-card-bg":
      tokens["recipe-settings-card-bg"] ??
      (dark ? withAlpha(tokens["surface-canvas"], 0.5) : tokens["surface-panel"]),
    "recipe-settings-list-item-bg":
      tokens["recipe-settings-list-item-bg"] ??
      (dark ? withAlpha(tokens["surface-canvas"], 0.3) : tokens["surface-panel"]),
    "recipe-settings-sidebar-bg":
      tokens["recipe-settings-sidebar-bg"] ?? withAlpha(tokens["surface-canvas"], 0.5),
    "recipe-settings-header-bg":
      tokens["recipe-settings-header-bg"] ?? withAlpha(tokens["surface-sidebar"], 0.5),
    "recipe-settings-nav-active-bg":
      tokens["recipe-settings-nav-active-bg"] ?? (dark ? withAlpha(overlayTone, 0.05) : accentSoft),
    "recipe-settings-nav-active-shadow": tokens["recipe-settings-nav-active-shadow"] ?? "none",
    "recipe-settings-nav-hover-bg":
      tokens["recipe-settings-nav-hover-bg"] ??
      (dark ? withAlpha(overlayTone, 0.05) : withAlpha(overlayBase, 0.02)),
    "recipe-settings-subtab-active-border-width":
      tokens["recipe-settings-subtab-active-border-width"] ?? (dark ? "2px" : "3px"),
    "recipe-settings-kbd-bg":
      tokens["recipe-settings-kbd-bg"] ??
      (dark ? tokens["surface-canvas"] : (tokens["surface-input"] ?? tokens["surface-panel"])),
    "recipe-settings-kbd-border": tokens["recipe-settings-kbd-border"] ?? tokens["border-default"],
    "recipe-worktree-section-hover-bg":
      tokens["recipe-worktree-section-hover-bg"] ??
      tokens["overlay-soft"] ??
      withAlpha(overlayBase, dark ? 0.03 : 0.03),
    "recipe-chrome-noise-texture": tokens["recipe-chrome-noise-texture"] ?? "none",
    "diff-insert-background":
      tokens["diff-insert-background"] ?? withAlpha(tokens["status-success"], dark ? 0.18 : 0.1),
    "diff-insert-edit-background":
      tokens["diff-insert-edit-background"] ??
      withAlpha(tokens["status-success"], dark ? 0.28 : 0.2),
    "diff-delete-background":
      tokens["diff-delete-background"] ?? withAlpha(tokens["status-danger"], dark ? 0.18 : 0.1),
    "diff-delete-edit-background":
      tokens["diff-delete-edit-background"] ??
      withAlpha(tokens["status-danger"], dark ? 0.28 : 0.2),
    "diff-gutter-insert": tokens["diff-gutter-insert"] ?? tokens["status-success"],
    "diff-gutter-delete": tokens["diff-gutter-delete"] ?? tokens["status-danger"],
    "diff-selected-background":
      tokens["diff-selected-background"] ?? withAlpha(overlayTone, dark ? 0.06 : 0.06),
    "diff-omit-gutter-line": tokens["diff-omit-gutter-line"] ?? tokens["activity-idle"],
    ...tokens,
  };
}

function withAlpha(color: string, alpha: number): string {
  if (color.startsWith("#")) {
    return `rgba(${hexToRgbTriplet(color)}, ${alpha})`;
  }
  return `color-mix(in oklab, ${color} ${(alpha * 100).toFixed(1)}%, transparent)`;
}

const INTERNAL_LIGHT_FALLBACK_SCHEME: AppColorScheme = {
  id: "canopy-light-base",
  name: "Canopy Light Base",
  type: "light",
  builtin: true,
  tokens: createCanopyTokens("light", {
    "surface-canvas": "#ECF0F5",
    "surface-sidebar": "#D8DEE6",
    "surface-panel": "#F5F8FB",
    "surface-panel-elevated": "#FCFDFE",
    "surface-grid": "#CDD3DB",
    "text-primary": "#1E252E",
    "text-secondary": "#4A5562",
    "text-muted": "#7D8896",
    "text-inverse": "#FCFDFE",
    "border-default": "#C0C8D1",
    "accent-primary": "#1A7258",
    "accent-foreground": "#FCFDFE",
    "status-success": "#31684B",
    "status-warning": "#9E5D1B",
    "status-danger": "#AD4035",
    "status-info": "#1C5478",
    "activity-active": "#2D7A4A",
    "activity-idle": "#7D8896",
    "activity-working": "#2D7A4A",
    "activity-waiting": "#9E7A15",
    "terminal-selection": "#2A3A4A",
    "terminal-red": "#f87171",
    "terminal-green": "#10b981",
    "terminal-yellow": "#fbbf24",
    "terminal-blue": "#38bdf8",
    "terminal-magenta": "#a855f7",
    "terminal-cyan": "#22d3ee",
    "terminal-bright-red": "#fca5a5",
    "terminal-bright-green": "#34d399",
    "terminal-bright-yellow": "#fcd34d",
    "terminal-bright-blue": "#7dd3fc",
    "terminal-bright-magenta": "#c084fc",
    "terminal-bright-cyan": "#67e8f9",
    "terminal-bright-white": "#fafafa",
    "syntax-comment": "#707b90",
    "syntax-punctuation": "#c5d0f5",
    "syntax-number": "#efb36b",
    "syntax-string": "#95c879",
    "syntax-operator": "#8acfe1",
    "syntax-keyword": "#bc9cef",
    "syntax-function": "#84adf8",
    "syntax-link": "#72c1ea",
    "syntax-quote": "#adb5bb",
    "syntax-chip": "#7fd4cf",
  }),
};

export const BUILT_IN_APP_SCHEMES: AppColorScheme[] = [
  {
    id: "daintree",
    name: "Daintree",
    type: "dark",
    builtin: true,
    location: "Daintree Rainforest, Queensland, Australia",
    heroImage: "/themes/daintree.webp",
    tokens: createCanopyTokens("dark", {
      // Surfaces — 5-level depth hierarchy with microscopic green bias in chrome
      "surface-grid": "#0e0e0d",
      "surface-sidebar": "#131413",
      "surface-toolbar": "#151615",
      "surface-canvas": "#19191a",
      "surface-panel": "#202121",
      "surface-panel-elevated": "#2D302F",
      // Text — cool-shifted from pure zinc to carry canopy botanical undertone
      "text-primary": "#E1E5E2",
      "text-secondary": "#B5BCB8",
      "text-muted": "#9AA29E",
      "text-inverse": "#19191a",
      // Border — green-biased default, alpha overlays for structural lines
      "border-default": "#2A2D2B",
      // Accent — emerald "chosen path": selection, focus, toggles, buttons
      "accent-primary": "#3E9066",
      "accent-foreground": "#19191a",
      // Status — muted semantic outcomes that don't compete with accent or activity
      "status-success": "#4F756A",
      "status-warning": "#C59A4E",
      "status-danger": "#C8746C",
      "status-info": "#7B8C96",
      // Activity — vivid teal (#22B8A0) for live metabolism; idle unified with disabled text
      "activity-active": "#22B8A0",
      "activity-idle": "#555C58",
      "activity-working": "#22B8A0",
      "activity-waiting": "#fbbf24",
      // Focus ring — accent-tinted, carries botanical feel into the interaction layer
      "focus-ring": "rgba(104, 166, 126, 0.24)",
      // Shadow — neutral black, slightly heavier than the generic dark default
      "shadow-color": "rgba(0, 0, 0, 0.55)",
      // Search — independent teal lane, distinct from accent/success/working greens
      "search-highlight-background": "rgba(92, 137, 128, 0.2)",
      "search-highlight-text": "#5C8980",
      "search-selected-result-border": "rgba(92, 137, 128, 0.30)",
      "search-selected-result-icon": "#5C8980",
      "search-match-badge-background": "rgba(92, 137, 128, 0.20)",
      "search-match-badge-text": "#5C8980",
      // Terminal — inherits canvas; cursor derived from accent-primary
      "terminal-background": "#19191a",
      "terminal-foreground": "#E1E5E2",
      "terminal-muted": "#9AA29E",
      "terminal-selection": "#1a2c22",
      "terminal-red": "#f87171",
      "terminal-green": "#10b981",
      "terminal-yellow": "#fbbf24",
      "terminal-blue": "#38bdf8",
      "terminal-magenta": "#a855f7",
      "terminal-cyan": "#22d3ee",
      "terminal-bright-red": "#fca5a5",
      "terminal-bright-green": "#34d399",
      "terminal-bright-yellow": "#fcd34d",
      "terminal-bright-blue": "#7dd3fc",
      "terminal-bright-magenta": "#c084fc",
      "terminal-bright-cyan": "#67e8f9",
      "terminal-bright-white": "#fafafa",
      // Syntax
      "syntax-comment": "#707b90",
      "syntax-punctuation": "#c5d0f5",
      "syntax-number": "#efb36b",
      "syntax-string": "#95c879",
      "syntax-operator": "#8acfe1",
      "syntax-keyword": "#bc9cef",
      "syntax-function": "#84adf8",
      "syntax-link": "#72c1ea",
      "syntax-quote": "#adb5bb",
      "syntax-chip": "#7fd4cf",
      // Scrollbar — thumb uses activity-idle color; hover lightens toward text-primary
      "recipe-scrollbar-thumb": "#555C58",
      "recipe-scrollbar-thumb-hover": "color-mix(in oklab, #555C58 85%, #E1E5E2)",
      // Button inset highlight — brighter than generic dark default (matches kitchen sink)
      "recipe-button-inset-shadow": "inset 0 1px 0 rgba(255, 255, 255, 0.15)",
      "recipe-dialog-shadow": "0 20px 56px rgba(0,0,0,0.40)",
      "recipe-toolbar-control-hover-bg": "rgba(255,255,255,0.10)",
      "recipe-toolbar-control-hover-fg": "#3E9066",
      "recipe-toolbar-agent-hover-bg": "rgba(255,255,255,0.06)",
      "recipe-toolbar-divider": "rgba(42,45,43,0.5)",
      "recipe-toolbar-project-bg":
        "linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.05)), linear-gradient(135deg, #1a3a2a, #0a2a1a)",
      "recipe-toolbar-project-border": "rgba(42,45,43,0.6)",
      "recipe-toolbar-project-shadow": "inset 0 1px 0 rgba(255,255,255,0.06)",
      "recipe-toolbar-project-chip-bg": "rgba(255,255,255,0.05)",
      "recipe-toolbar-project-chip-border": "rgba(42,45,43,0.6)",
      "recipe-toolbar-project-meta-fg": "#9AA29E",
      "recipe-toolbar-stats-bg": "rgba(255,255,255,0.05)",
      "recipe-toolbar-stats-border": "rgba(42,45,43,0.5)",
      "recipe-toolbar-stats-divider": "rgba(42,45,43,0.5)",
      "recipe-toolbar-stats-hover-bg": "rgba(255,255,255,0.10)",
      "recipe-pulse-card-bg": "#131413",
      "recipe-pulse-range-bg": "#2D302F",
      "recipe-pulse-before-bg": "#1A1B1A",
      "recipe-pulse-empty-bg": "#2D302F",
      "recipe-pulse-missed-bg": "rgba(200,116,108,0.18)",
      "recipe-pulse-skeleton-gradient":
        "linear-gradient(90deg, #2D302F 25%, #363A38 50%, #2D302F 75%)",
      "recipe-settings-dialog-bg": "#202121",
      "recipe-sidebar-active-bg": "rgba(255,255,255,0.04)",
      "recipe-sidebar-action-hover-bg": "rgba(255,255,255,0.05)",
      "recipe-settings-search-bg": "#19191A",
      "recipe-settings-search-muted": "#9AA29E",
      "recipe-settings-kbd-bg": "#19191A",
      "recipe-settings-kbd-border": "#2A2D2B",
    }),
  },
  {
    id: "bondi",
    name: "Bondi Beach",
    type: "light",
    builtin: true,
    location: "Bondi Beach, Sydney, Australia",
    heroImage: "/themes/bondi.webp",
    tokens: createCanopyTokens("light", {
      // Surfaces — blue-white ladder: Grid deepest, Elevated brightest white
      "surface-grid": "#D3E5F3",
      "surface-sidebar": "#DDECF8",
      "surface-toolbar": "#E7F3FB",
      "surface-canvas": "#EEF5FC",
      "surface-panel": "#F5FAFE",
      "surface-panel-elevated": "#FFFFFF",
      "surface-input": "#F5FAFE",
      "surface-inset": "#E3F1FA",
      // Hover/active overlays — cool blue-navy tint from #0D1621
      "surface-hover": "rgba(13, 22, 33, 0.05)",
      "surface-active": "rgba(13, 22, 33, 0.10)",
      // Text — navy primary for maximum crispness
      "text-primary": "#0D1621",
      "text-secondary": "#445468",
      "text-muted": "#758A9E",
      "text-inverse": "#FFFFFF",
      "text-link": "#007F98",
      // Borders — firm blue-tinted separators
      "border-default": "#B0CBE0",
      "border-subtle": "rgba(13, 22, 33, 0.06)",
      "border-divider": "rgba(13, 22, 33, 0.05)",
      "border-interactive": "rgba(13, 22, 33, 0.10)",
      "border-strong": "rgba(13, 22, 33, 0.14)",
      // Accent — bold teal #007F98: sporty, energetic, surf-water
      "accent-primary": "#007F98",
      "accent-foreground": "#FFFFFF",
      "accent-soft": "rgba(0,127,152,0.15)",
      "accent-muted": "rgba(0,127,152,0.30)",
      // Status
      "status-success": "#187D41",
      "status-warning": "#B85900",
      "status-danger": "#D6352E",
      "status-info": "#005699",
      // Activity outcomes — vivid teal-green active, warm amber/orange waiting/approval
      "activity-active": "#118545",
      "activity-idle": "#758A9E",
      "activity-working": "#118545",
      "activity-waiting": "#B38600",
      "activity-approval": "#DB6100",
      "activity-completed": "#187D41",
      "activity-failed": "#D6352E",
      // Overlay base — deep navy instead of pure black for cool blue-tinted hover feel
      "overlay-base": "#0D1621",
      "overlay-subtle": "rgba(13, 22, 33, 0.03)",
      "overlay-soft": "rgba(13, 22, 33, 0.05)",
      "overlay-medium": "rgba(13, 22, 33, 0.07)",
      "overlay-strong": "rgba(13, 22, 33, 0.10)",
      "overlay-emphasis": "rgba(13, 22, 33, 0.14)",
      // Focus ring — cool teal, energetic, matches accent
      "focus-ring": "rgba(0, 127, 152, 0.30)",
      // Scrims — cool blue-black, not pure black
      "scrim-soft": "rgba(13, 22, 33, 0.30)",
      "scrim-medium": "rgba(13, 22, 33, 0.50)",
      "scrim-strong": "rgba(13, 22, 33, 0.70)",
      // Shadows — blue-tinted, crisp/firm (small blur), brightest sheen
      "shadow-color": "rgba(13, 22, 33, 0.12)",
      "recipe-shadow-ambient": "0 1px 2px rgba(13, 22, 33, 0.08)",
      "recipe-shadow-floating":
        "0 4px 12px rgba(13, 22, 33, 0.12), 0 2px 4px rgba(13, 22, 33, 0.08)",
      // Button sheen — glossiest among light themes: 80% white inset highlight
      "recipe-button-inset-shadow": "inset 0 1px 0 rgba(255, 255, 255, 0.80)",
      // Elevated surface inset — bright top-edge gloss
      "recipe-surface-elevated-inset-shadow": "inset 0 1px 0 rgba(255, 255, 255, 0.80)",
      // Sidebar active — no shadow on active card (cleanest theme, pure white pops by contrast)
      "recipe-sidebar-active-shadow": "none",
      "recipe-sidebar-hover-bg": "rgba(13,22,33,0.03)",
      "recipe-sidebar-action-hover-bg": "rgba(13,22,33,0.05)",
      "recipe-toolbar-shadow": "inset 0 -1px 0 rgba(255,255,255,0.65)",
      "recipe-toolbar-control-hover-bg": "#FFFFFF",
      "recipe-toolbar-control-hover-fg": "#0087A1",
      "recipe-toolbar-control-hover-shadow": "0 1px 2px rgba(68,84,104,0.10)",
      "recipe-toolbar-divider": "rgba(176,203,224,0.4)",
      "recipe-toolbar-pill-radius": "0.75rem",
      "recipe-toolbar-project-bg": "linear-gradient(180deg, #FFFFFF, #EEF5FC)",
      "recipe-toolbar-project-border": "#C5DDF2",
      "recipe-toolbar-project-shadow":
        "0 1px 2px rgba(68,84,104,0.08), inset 0 1px 0 rgba(255,255,255,0.75)",
      "recipe-toolbar-project-chip-bg": "#F5FAFE",
      "recipe-toolbar-project-chip-border": "#C5DDF2",
      "recipe-toolbar-project-meta-fg": "#445468",
      "recipe-toolbar-stats-bg": "#FFFFFF",
      "recipe-toolbar-stats-border": "#C5DDF2",
      "recipe-toolbar-stats-divider": "#C5DDF2",
      "recipe-toolbar-stats-shadow": "0 1px 2px rgba(68,84,104,0.06)",
      "recipe-toolbar-stats-hover-bg": "#F5FAFE",
      "recipe-pulse-card-bg": "#FFFFFF",
      "recipe-pulse-card-shadow": "0 1px 3px rgba(13,22,33,0.08)",
      "recipe-pulse-range-bg": "#EEF5FC",
      "recipe-pulse-before-bg": "#E3EEF6",
      "recipe-pulse-empty-bg": "#F0F6FC",
      "recipe-pulse-missed-bg": "rgba(214,53,46,0.10)",
      "recipe-pulse-skeleton-gradient":
        "linear-gradient(90deg, #E8F1F9 25%, #F0F6FC 50%, #E8F1F9 75%)",
      "recipe-settings-dialog-bg": "#F5FAFE",
      "recipe-settings-card-bg": "#F5FAFE",
      "recipe-settings-list-item-bg": "#F5FAFE",
      "recipe-settings-nav-active-bg": "rgba(0,135,161,0.10)",
      "recipe-settings-nav-active-shadow":
        "0 1px 2px rgba(13,22,33,0.08), inset 0 0 0 1px rgba(0,135,161,0.20)",
      // Scrollbar — thumb uses muted text color; hover deepens toward primary
      "recipe-scrollbar-thumb": "#758A9E",
      "recipe-scrollbar-thumb-hover": "color-mix(in oklab, #758A9E 85%, #0D1621)",
      // Search — surf-blue lane, distinct from teal accent
      "search-highlight-background": "rgba(0, 102, 224, 0.20)",
      "search-highlight-text": "#0052B3",
      "search-selected-result-border": "rgba(0, 102, 224, 0.30)",
      "search-selected-result-icon": "#0066E0",
      "search-match-badge-background": "rgba(0, 102, 224, 0.20)",
      "search-match-badge-text": "#0052B3",
      // GitHub — Bondi-specific vibrant palette
      "github-open": "#138A36",
      "github-merged": "#8948E8",
      "github-closed": "#D62431",
      "github-draft": "#8593A1",
      // Terminal — dark navy interior inside light workbench
      "terminal-background": "#0D1621",
      "terminal-foreground": "#ADC8E0",
      "terminal-muted": "#445468",
      "terminal-cursor": "#F5B814",
      "terminal-selection": "#1E3248",
      "terminal-black": "#0D1621",
      "terminal-white": "#ADC8E0",
      // ANSI — optimized for dark navy background, coastal palette
      "terminal-red": "#E05C5C",
      "terminal-green": "#2EBD88",
      "terminal-yellow": "#F5B814",
      "terminal-blue": "#4D9FD6",
      "terminal-magenta": "#9D45F0",
      "terminal-cyan": "#0FA8C0",
      "terminal-bright-black": "#445468",
      "terminal-bright-red": "#F87171",
      "terminal-bright-green": "#34D399",
      "terminal-bright-yellow": "#FCD34D",
      "terminal-bright-blue": "#7DD3FC",
      "terminal-bright-magenta": "#C084FC",
      "terminal-bright-cyan": "#67E8F9",
      "terminal-bright-white": "#E8F4FD",
      // Syntax — tuned for dark navy terminal background
      "syntax-comment": "#5C7A9B",
      "syntax-punctuation": "#ADC8E0",
      "syntax-number": "#F5B814",
      "syntax-string": "#2EBD88",
      "syntax-operator": "#0FA8C0",
      "syntax-keyword": "#9D45F0",
      "syntax-function": "#4D9FD6",
      "syntax-link": "#007F98",
      "syntax-quote": "#758A9E",
      "syntax-chip": "#0FA8C0",
    }),
  },
  {
    id: "table-mountain",
    name: "Table Mountain",
    type: "light",
    builtin: true,
    location: "Table Mountain, Cape Town, South Africa",
    heroImage: "/themes/table-mountain.webp",
    tokens: createCanopyTokens("light", {
      // Surfaces — warm sandstone depth hierarchy
      "surface-grid": "#D8D1C8",
      "surface-sidebar": "#E2DCD4",
      "surface-toolbar": "#E8E3DB",
      "surface-canvas": "#EDE8E1",
      "surface-panel": "#F7F4EF",
      "surface-panel-elevated": "#FDFBF8",
      "surface-input": "#F4F1EC",
      "surface-inset": "#E4DED6",
      "surface-hover": "rgba(60,48,38,0.04)",
      "surface-active": "rgba(60,48,38,0.06)",
      // Text
      "text-primary": "#2C2622",
      "text-secondary": "#635952",
      "text-muted": "#968C84",
      "text-inverse": "#FDFBF8",
      "text-placeholder": "#A69E96",
      "text-link": "#A8456E",
      // Borders
      "border-default": "#C8C0B5",
      "border-subtle": "rgba(60,48,38,0.06)",
      "border-strong": "rgba(60,48,38,0.14)",
      "border-divider": "rgba(60,48,38,0.05)",
      "border-interactive": "rgba(60,48,38,0.10)",
      // Overlay base — warm brown tints the hover ladder with sandstone warmth
      "overlay-base": "#3C3026",
      "overlay-subtle": "rgba(60,48,38,0.02)",
      "overlay-soft": "rgba(60,48,38,0.04)",
      "overlay-medium": "rgba(60,48,38,0.06)",
      "overlay-strong": "rgba(60,48,38,0.08)",
      "overlay-emphasis": "rgba(60,48,38,0.12)",
      // Accent — protea magenta (interaction only: focus, selection, toggles, buttons)
      "accent-primary": "#A8456E",
      "accent-foreground": "#FDFBF8",
      "accent-soft": "rgba(168,69,110,0.12)",
      "accent-muted": "rgba(168,69,110,0.25)",
      "accent-hover": "color-mix(in oklab, #A8456E 90%, #000000)",
      // Secondary — silver-tree sage (botanical lane: metadata, secondary chips)
      "accent-secondary": "#6B8F71",
      "accent-secondary-soft": "rgba(107,143,113,0.12)",
      "accent-secondary-muted": "rgba(107,143,113,0.25)",
      // Status
      "status-success": "#4A7356",
      "status-warning": "#9A6525",
      "status-danger": "#A84840",
      "status-info": "#556B7D",
      // Activity
      "activity-active": "#3D8253",
      "activity-idle": "#948B83",
      "activity-working": "#3D8253",
      "activity-waiting": "#A47B20",
      "activity-approval": "#C06418",
      "activity-completed": "#4A7356",
      "activity-failed": "#A84840",
      // Focus ring — protea accent at 25% (interaction lane)
      "focus-ring": "rgba(168,69,110,0.25)",
      // Shadow — warm taupe
      "shadow-color": "rgba(60,48,38,0.11)",
      // Scrims — warm sandstone-black base
      "scrim-soft": "rgba(60,48,38,0.30)",
      "scrim-medium": "rgba(60,48,38,0.50)",
      "scrim-strong": "rgba(60,48,38,0.65)",
      // Search — blue-slate lane (wayfinding only, independent from protea accent)
      "search-highlight-background": "rgba(74,106,130,0.14)",
      "search-highlight-text": "#4A6A82",
      "search-selected-result-border": "rgba(74, 106, 130, 0.30)",
      "search-selected-result-icon": "#4A6A82",
      "search-match-badge-background": "rgba(74,106,130,0.10)",
      "search-match-badge-text": "#4A6A82",
      // Terminal — dark fynbos-floor
      "terminal-background": "#261F1B",
      "terminal-foreground": "#E0D8D0",
      "terminal-muted": "#968C84",
      "terminal-cursor": "#fbbf24",
      "terminal-black": "#261F1B",
      "terminal-white": "#E0D8D0",
      "terminal-bright-black": "#968C84",
      "terminal-selection": "rgba(168,69,110,0.30)",
      "terminal-red": "#f87171",
      "terminal-green": "#7DA88A",
      "terminal-yellow": "#fbbf24",
      "terminal-blue": "#7ab3c8",
      "terminal-magenta": "#c084fc",
      "terminal-cyan": "#5bbdbd",
      "terminal-bright-red": "#fca5a5",
      "terminal-bright-green": "#9dc9a6",
      "terminal-bright-yellow": "#fcd34d",
      "terminal-bright-blue": "#9dcde0",
      "terminal-bright-magenta": "#d8b4fe",
      "terminal-bright-cyan": "#7dd4d4",
      "terminal-bright-white": "#fdfbf8",
      // Syntax (against dark terminal #261F1B — warm botanical palette)
      "syntax-comment": "#7A8E82",
      "syntax-punctuation": "#b8c4d0",
      "syntax-number": "#e8b06a",
      "syntax-string": "#8fc78a",
      "syntax-operator": "#7abfce",
      "syntax-keyword": "#c48fd8",
      "syntax-function": "#85b4e8",
      "syntax-link": "#6dbac4",
      "syntax-quote": "#a8b4a2",
      "syntax-chip": "#7ecfca",
      // Scrollbar — uses activity-idle color
      "recipe-scrollbar-thumb": "#948B83",
      "recipe-scrollbar-thumb-hover": "color-mix(in oklab, #948B83 85%, #2C2622)",
      // Button inset highlight — warm white catch light
      "recipe-button-inset-shadow": "inset 0 1px 0 rgba(255,253,248,0.70)",
      // Shadow profiles — deep/lush fynbos canopy shadows
      "recipe-shadow-ambient": "0 12px 40px rgba(60,48,38,0.11)",
      "recipe-shadow-floating": "0 20px 56px rgba(60,48,38,0.15)",
      // Elevated surface inset shadow
      "recipe-surface-elevated-inset-shadow": "inset 0 1px 0 rgba(255,253,248,0.70)",
      "recipe-dialog-shadow": "0 24px 48px rgba(60,48,38,0.11), 0 8px 20px rgba(60,48,38,0.07)",
      "recipe-toolbar-control-hover-bg": "rgba(60,48,38,0.06)",
      "recipe-toolbar-control-hover-fg": "#2C2622",
      "recipe-toolbar-divider": "rgba(200,192,181,0.5)",
      "recipe-toolbar-project-bg":
        "linear-gradient(180deg, rgba(60,48,38,0.02), rgba(60,48,38,0.05)), linear-gradient(135deg, #EDE8E1, #E2DCD4)",
      "recipe-toolbar-project-border": "rgba(200,192,181,0.6)",
      "recipe-toolbar-project-shadow": "inset 0 1px 0 rgba(60,48,38,0.06)",
      "recipe-toolbar-project-chip-bg": "rgba(60,48,38,0.04)",
      "recipe-toolbar-project-chip-border": "rgba(200,192,181,0.6)",
      "recipe-toolbar-project-meta-fg": "#635952",
      "recipe-toolbar-stats-bg": "rgba(60,48,38,0.04)",
      "recipe-toolbar-stats-border": "rgba(200,192,181,0.5)",
      "recipe-toolbar-stats-divider": "rgba(200,192,181,0.5)",
      "recipe-toolbar-stats-hover-bg": "rgba(60,48,38,0.06)",
      "recipe-pulse-card-bg": "#FDFBF8",
      "recipe-pulse-card-shadow": "0 1px 3px rgba(60,48,38,0.11)",
      "recipe-pulse-range-bg": "#F3F0EB",
      "recipe-pulse-before-bg": "#E6E0D8",
      "recipe-pulse-empty-bg": "#F3F0EB",
      "recipe-pulse-missed-bg": "rgba(168,72,64,0.10)",
      "recipe-pulse-skeleton-gradient":
        "linear-gradient(90deg, #E4DED6 25%, #EDE9E2 50%, #E4DED6 75%)",
      "recipe-settings-dialog-bg": "#F7F4EF",
      "recipe-sidebar-active-bg":
        "linear-gradient(180deg, rgba(168,69,110,0.05), rgba(168,69,110,0.02)), #FDFBF8",
      "recipe-sidebar-active-shadow":
        "0 18px 36px rgba(60,48,38,0.11), 0 6px 14px rgba(60,48,38,0.07)",
      "recipe-sidebar-hover-bg": "rgba(60,48,38,0.06)",
      "recipe-sidebar-action-hover-bg": "rgba(60,48,38,0.06)",
      "recipe-settings-search-bg": "#F4F1EC",
      "recipe-settings-card-bg": "#F7F4EF",
      "recipe-settings-list-item-bg": "#F7F4EF",
      "recipe-settings-sidebar-bg": "rgba(226,220,212,0.50)",
      "recipe-settings-header-bg": "rgba(228,222,214,0.50)",
      "recipe-settings-nav-active-bg": "rgba(60,48,38,0.05)",
      "recipe-settings-nav-active-shadow":
        "0 1px 2px rgba(60,48,38,0.08), inset 0 0 0 1px rgba(60,48,38,0.08)",
      "recipe-settings-nav-hover-bg": "rgba(60,48,38,0.04)",
    }),
  },
  // ── Dark themes ──────────────────────────────────────────────────────────
  {
    id: "arashiyama",
    name: "Arashiyama",
    type: "dark",
    builtin: true,
    location: "Arashiyama Bamboo Grove, Kyoto, Japan",
    heroImage: "/themes/arashiyama.webp",
    tokens: createCanopyTokens("dark", {
      // Surfaces — warm umber depth hierarchy; each step is lacquered chestnut, not zinc
      "surface-grid": "#0C0806",
      "surface-sidebar": "#120C0A",
      "surface-toolbar": "#140E0B",
      "surface-canvas": "#1A1310",
      "surface-panel": "#241B17",
      "surface-panel-elevated": "#342620",
      // Text — parchment-warm: primary is aged linen, muted is aged paper
      "text-primary": "#E3D4C5",
      "text-secondary": "#B5A493",
      "text-muted": "#9A8B7C",
      "text-inverse": "#1A1310",
      // Border — aged wood grain; warm umber default, alpha variants for structural lines
      "border-default": "#483A2E",
      "border-subtle": "rgba(255,236,214,0.07)",
      "border-strong": "rgba(255,236,214,0.14)",
      // Accent — warm vermilion for selection, toggles, badges; gold is reserved for search
      "accent-primary": "#C46240",
      "accent-foreground": "#1A1310",
      // Status
      "status-success": "#6A8253",
      "status-warning": "#B88E43",
      "status-danger": "#B85F56",
      "status-info": "#7B8591",
      // Activity — bamboo green for live metabolism; warm parchment for idle/dormant
      "activity-active": "#76A25D",
      "activity-idle": "#8A7A6A",
      "activity-working": "#76A25D",
      "activity-waiting": "#C49A50",
      "activity-approval": "#C27636",
      // Overlay — warm lamplight cream base; tints all hover/fill ladder
      "overlay-base": "#FFECD6",
      "overlay-strong": "rgba(255,236,214,0.08)",
      // Focus — warm parchment halo instead of cold white ring
      "focus-ring": "rgba(255,236,214,0.20)",
      // Shadow — warm umber; cold black shadows clash with lacquer
      "shadow-color": "rgba(12,8,4,0.45)",
      "recipe-shadow-ambient": "0 1px 3px rgba(12,8,4,0.35), 0 1px 2px rgba(12,8,4,0.25)",
      "recipe-shadow-floating": "0 14px 42px rgba(12,8,4,0.45)",
      "scrim-soft": "rgba(12,8,4,0.20)",
      "scrim-medium": "rgba(12,8,4,0.45)",
      "scrim-strong": "rgba(12,8,4,0.62)",
      // Search — old-gold wayfinding lane, strictly separate from vermilion
      "search-highlight-background": "rgba(200,150,75,0.18)",
      "search-highlight-text": "#C8964B",
      "search-selected-result-border": "rgba(200,150,75,0.35)",
      "search-selected-result-icon": "#C8964B",
      "search-match-badge-background": "rgba(200,150,75,0.18)",
      "search-match-badge-text": "#C8964B",
      // Terminal — canvas background; amber cursor echoes the gold identity
      "terminal-background": "#1A1310",
      "terminal-foreground": "#E3D4C5",
      "terminal-muted": "#B5A493",
      "terminal-cursor": "#C49A50",
      "terminal-selection": "#2C1A0F",
      "terminal-red": "#e07060",
      "terminal-green": "#9EBC72",
      "terminal-yellow": "#C49A50",
      "terminal-blue": "#7ea8c4",
      "terminal-magenta": "#b08090",
      "terminal-cyan": "#7abcb0",
      "terminal-bright-red": "#f0907a",
      "terminal-bright-green": "#b8d48a",
      "terminal-bright-yellow": "#e0b870",
      "terminal-bright-blue": "#9ec0d8",
      "terminal-bright-magenta": "#c899a8",
      "terminal-bright-cyan": "#90d0c4",
      "terminal-bright-white": "#f0e8de",
      // Syntax — bamboo-and-parchment: warm-shifted analogues of Daintree's cool palette
      "syntax-comment": "#7a6a56",
      "syntax-punctuation": "#c8baa8",
      "syntax-number": "#c49a50",
      "syntax-string": "#9ebc72",
      "syntax-operator": "#8abcb0",
      "syntax-keyword": "#c49080",
      "syntax-function": "#a0a8d8",
      "syntax-link": "#88b8c8",
      "syntax-quote": "#b0a090",
      "syntax-chip": "#b8c890",
      // Scrollbar — warm charcoal thumb; hover lightens toward primary
      "recipe-scrollbar-thumb": "#8A7A6A",
      "recipe-scrollbar-thumb-hover": "color-mix(in oklab, #8A7A6A 85%, #E3D4C5)",
      "recipe-button-inset-shadow": "inset 0 1px 0 rgba(255,240,220,0.15)",
      "recipe-dialog-shadow": "0 20px 48px rgba(12,8,4,0.40)",
      "recipe-surface-elevated-inset-shadow": "inset 0 1px 0 0 rgba(255,240,220,0.08)",
      "recipe-toolbar-control-hover-bg": "rgba(255,236,214,0.08)",
      "recipe-toolbar-control-hover-fg": "#B85733",
      "recipe-toolbar-divider": "rgba(72,58,46,0.5)",
      "recipe-toolbar-project-bg":
        "linear-gradient(180deg, rgba(255,240,220,0.08), rgba(255,236,214,0.03)), linear-gradient(135deg, #3A2B22, #241814)",
      "recipe-toolbar-project-border": "rgba(72,58,46,0.6)",
      "recipe-toolbar-project-shadow": "inset 0 1px 0 rgba(255,240,220,0.15)",
      "recipe-toolbar-project-chip-bg": "rgba(255,236,214,0.05)",
      "recipe-toolbar-project-chip-border": "rgba(72,58,46,0.6)",
      "recipe-toolbar-project-meta-fg": "#B5A493",
      "recipe-toolbar-stats-bg": "rgba(255,236,214,0.05)",
      "recipe-toolbar-stats-border": "rgba(72,58,46,0.5)",
      "recipe-toolbar-stats-divider": "rgba(255,236,214,0.05)",
      "recipe-toolbar-stats-hover-bg": "rgba(255,236,214,0.08)",
      "recipe-pulse-card-bg": "#120C0A",
      "recipe-pulse-range-bg": "#342620",
      "recipe-pulse-before-bg": "#0F0908",
      "recipe-pulse-empty-bg": "#342620",
      "recipe-pulse-missed-bg": "rgba(184,95,86,0.18)",
      "recipe-pulse-skeleton-gradient":
        "linear-gradient(90deg, #342620 25%, #3E3028 50%, #342620 75%)",
      "recipe-settings-dialog-bg": "#241B17",
      // Sidebar active — warmer lamplight tint at 5% (slightly stronger than default 4%)
      "recipe-sidebar-active-bg": "rgba(255,236,214,0.05)",
      "recipe-sidebar-active-shadow": "inset 0 1px 0 0 rgba(255,240,220,0.08)",
      "recipe-sidebar-hover-bg": "rgba(255,244,230,0.035)",
      "recipe-sidebar-action-hover-bg": "rgba(255,236,214,0.05)",
      "recipe-settings-search-bg": "#342620",
      "recipe-settings-nav-active-bg": "rgba(255,236,214,0.05)",
      "recipe-settings-nav-hover-bg": "rgba(255,236,214,0.05)",
      "recipe-settings-kbd-bg": "#1A1310",
      "recipe-settings-kbd-border": "#483A2E",
      "recipe-worktree-section-hover-bg": "rgba(255,236,214,0.05)",
    }),
  },
  {
    id: "fiordland",
    name: "Fiordland",
    type: "dark",
    builtin: true,
    location: "Fiordland, South Island, New Zealand",
    heroImage: "/themes/fiordland.webp",
    tokens: createCanopyTokens("dark", {
      // Surfaces — navy-black wet slate; pressure-heavy, not verdant
      "surface-grid": "#04070B",
      "surface-sidebar": "#080D14",
      "surface-toolbar": "#091017",
      "surface-canvas": "#0C141D",
      "surface-panel": "#111C29",
      "surface-panel-elevated": "#1A2C3E",
      // Text — glacial cool
      "text-primary": "#DDE7F0",
      "text-secondary": "#9AB3C5",
      "text-muted": "#7D97A8",
      "text-inverse": "#050D14",
      // Border — mineral sharp
      "border-default": "#1C2E40",
      "border-subtle": "rgba(180,220,240,0.09)",
      "border-strong": "rgba(180,220,240,0.16)",
      // Accent — glacial teal/cyan
      "accent-primary": "#3AB7C5",
      "accent-foreground": "#050D14",
      // Status
      "status-success": "#5BA38E",
      "status-warning": "#B88F52",
      "status-danger": "#BF6565",
      "status-info": "#668CA6",
      // Activity
      "activity-active": "#1AB582",
      "activity-idle": "#6B8296",
      "activity-working": "#1AB582",
      "activity-waiting": "#D4A346",
      "activity-approval": "#D6742B",
      // Overlay — icy blue base; tints hover/fill ladder with glacial hue
      "overlay-base": "#B4DCF0",
      "focus-ring": "rgba(58,183,197,0.45)",
      "recipe-focus-ring-offset": "1px",
      "shadow-color": "rgba(4,7,15,0.5)",
      "scrim-soft": "rgba(4,7,15,0.2)",
      "scrim-medium": "rgba(4,7,15,0.55)",
      "scrim-strong": "rgba(2,5,12,0.62)",
      // Search — icy wayfinding lane (#7DD4DF), separate from glacial accent
      "search-highlight-background": "rgba(125,212,223,0.15)",
      "search-highlight-text": "#7DD4DF",
      "search-selected-result-border": "rgba(125, 212, 223, 0.30)",
      "search-selected-result-icon": "#7DD4DF",
      "search-match-badge-background": "rgba(125,212,223,0.12)",
      "search-match-badge-text": "#7DD4DF",
      // GitHub
      "github-open": "#23B06D",
      "github-merged": "#8B82DE",
      "github-closed": "#DF5B56",
      // Terminal
      "terminal-background": "#0C141D",
      "terminal-foreground": "#DDE7F0",
      "terminal-muted": "#9AB3C5",
      "terminal-selection": "#0D2233",
      // ANSI — tuned for navy-black #0C141D background, glacial palette
      "terminal-red": "#E06C75",
      "terminal-green": "#2DB896",
      "terminal-yellow": "#E5C07B",
      "terminal-blue": "#5B8DB8",
      "terminal-magenta": "#C678DD",
      "terminal-cyan": "#56B6C2",
      "terminal-bright-red": "#F47B7B",
      "terminal-bright-green": "#56C99A",
      "terminal-bright-yellow": "#EFCA83",
      "terminal-bright-blue": "#82AEDB",
      "terminal-bright-magenta": "#D8A0E8",
      "terminal-bright-cyan": "#7FD4DF",
      "terminal-bright-white": "#F0F4F8",
      // Syntax — cooled toward blue-slate
      "syntax-comment": "#607590",
      "syntax-punctuation": "#aec6e8",
      "syntax-number": "#efb36b",
      "syntax-string": "#7ec8a0",
      "syntax-operator": "#7dd4df",
      "syntax-keyword": "#a899e8",
      "syntax-function": "#6eb4f5",
      "syntax-link": "#63c4e0",
      "syntax-quote": "#8aa5bb",
      "syntax-chip": "#5ec8d8",
      "recipe-scrollbar-thumb": "#6B8296",
      "recipe-scrollbar-thumb-hover": "color-mix(in oklab, #6B8296 85%, #DDE7F0)",
      "recipe-button-inset-shadow": "inset 0 1px 0 rgba(180,220,240,0.15)",
      "recipe-surface-elevated-inset-shadow": "inset 0 1px 0 rgba(180,220,240,0.04)",
      "recipe-dialog-shadow":
        "inset 0 1px 0 rgba(180,220,240,0.04), 0 25px 50px -12px rgba(4,7,15,0.55)",
      "recipe-toolbar-control-hover-bg": "rgba(180,220,240,0.10)",
      "recipe-toolbar-control-hover-fg": "#3AB7C5",
      "recipe-toolbar-agent-hover-bg": "rgba(180,220,240,0.06)",
      "recipe-toolbar-divider": "rgba(28,46,64,0.5)",
      "recipe-toolbar-project-bg":
        "linear-gradient(180deg, rgba(180,220,240,0.03), rgba(180,220,240,0.05)), linear-gradient(135deg, #103142, #061621)",
      "recipe-toolbar-project-border": "rgba(28,46,64,0.6)",
      "recipe-toolbar-project-shadow": "inset 0 1px 0 rgba(180,220,240,0.06)",
      "recipe-toolbar-project-chip-bg": "rgba(180,220,240,0.05)",
      "recipe-toolbar-project-chip-border": "rgba(28,46,64,0.6)",
      "recipe-toolbar-project-meta-fg": "#9AB3C5",
      "recipe-toolbar-stats-bg": "rgba(180,220,240,0.05)",
      "recipe-toolbar-stats-border": "rgba(28,46,64,0.5)",
      "recipe-toolbar-stats-divider": "rgba(28,46,64,0.5)",
      "recipe-toolbar-stats-hover-bg": "rgba(180,220,240,0.10)",
      "recipe-pulse-card-bg": "#080D14",
      "recipe-pulse-range-bg": "#1A2C3E",
      "recipe-pulse-before-bg": "#060A10",
      "recipe-pulse-empty-bg": "#1A2C3E",
      "recipe-pulse-missed-bg": "rgba(191,101,101,0.18)",
      "recipe-pulse-skeleton-gradient":
        "linear-gradient(90deg, #1A2C3E 25%, #223A4F 50%, #1A2C3E 75%)",
      "recipe-settings-dialog-bg": "#111C29",
      "recipe-sidebar-active-bg": "rgba(180,220,240,0.04)",
      "recipe-sidebar-active-shadow": "inset 0 1px 0 0 rgba(180,220,240,0.03)",
      "recipe-sidebar-action-hover-bg": "rgba(180,220,240,0.05)",
      "recipe-settings-search-bg": "#0C141D",
      "recipe-settings-nav-active-bg": "rgba(58,183,197,0.10)",
      "recipe-settings-nav-active-shadow": "inset 0 0 0 1px rgba(58,183,197,0.20)",
      "recipe-settings-nav-hover-bg": "rgba(180,220,240,0.05)",
      "recipe-settings-kbd-bg": "#1A2C3E",
      "recipe-settings-kbd-border": "#1C2E40",
    }),
  },
  {
    id: "galapagos",
    name: "Galápagos",
    type: "dark",
    builtin: true,
    location: "Galápagos Islands, Ecuador",
    heroImage: "/themes/galapagos.webp",
    tokens: createCanopyTokens("dark", {
      // Surfaces — wet volcanic black with mangrove humidity
      "surface-grid": "#0A0D0C",
      "surface-sidebar": "#111615",
      "surface-toolbar": "#131917",
      "surface-canvas": "#161D1B",
      "surface-panel": "#1A2421",
      "surface-panel-elevated": "#23322E",
      // Text
      "text-primary": "#DCE6E3",
      "text-secondary": "#9AB0A9",
      "text-muted": "#7A8C87",
      "text-inverse": "#161D1B",
      // Border — slightly wetter/glossier than Daintree; teal-mist tinted
      "border-default": "#2A3A35",
      "border-subtle": "rgba(140,200,180,0.08)",
      "border-divider": "rgba(140,200,180,0.05)",
      "border-interactive": "rgba(140,200,180,0.12)",
      "border-strong": "rgba(140,200,180,0.20)",
      // Accent — sea-glass mangrove teal
      "accent-primary": "#4A9E7F",
      "accent-foreground": "#161D1B",
      // Overlay — desaturated teal mist; drives the wet biotic hover feel at the right intensity
      "overlay-base": "#8CC8B4",
      // Status
      "status-success": "#458567",
      "status-warning": "#C99F59",
      "status-danger": "#D17B72",
      "status-info": "#759DB0",
      // Activity
      "activity-active": "#32C781",
      "activity-idle": "#536660",
      "activity-working": "#32C781",
      "activity-waiting": "#F2B850",
      "activity-approval": "#E8853D",
      "focus-ring": "rgba(140,200,180,0.22)",
      "shadow-color": "rgba(6,12,10,0.55)",
      "scrim-soft": "rgba(6,12,10,0.25)",
      "scrim-medium": "rgba(6,12,10,0.50)",
      "scrim-strong": "rgba(6,12,10,0.70)",
      // Search — saline cyan, independent from teal accent
      "search-highlight-background": "rgba(91,181,217,0.18)",
      "search-highlight-text": "#5BB5D9",
      "search-selected-result-border": "#5BB5D9",
      "search-selected-result-icon": "#5BB5D9",
      "search-match-badge-background": "rgba(91,181,217,0.16)",
      "search-match-badge-text": "#5BB5D9",
      // Terminal
      "terminal-background": "#161D1B",
      "terminal-foreground": "#DCE6E3",
      "terminal-muted": "#7A8C87",
      "terminal-cursor": "#F2B850",
      "terminal-selection": "rgba(74,158,127,0.18)",
      // ANSI — tuned for wet volcanic black #161D1B background
      "terminal-red": "#D17B72",
      "terminal-green": "#4A9E7F",
      "terminal-yellow": "#C99F59",
      "terminal-blue": "#5BB5D9",
      "terminal-magenta": "#9B7FBF",
      "terminal-cyan": "#4A9E7F",
      "terminal-bright-red": "#E8907F",
      "terminal-bright-green": "#32C781",
      "terminal-bright-yellow": "#F2B850",
      "terminal-bright-blue": "#8DCDE8",
      "terminal-bright-magenta": "#B89FD4",
      "terminal-bright-cyan": "#6BBFA8",
      "terminal-bright-white": "#DCE6E3",
      // Syntax — mangrove-tinted for volcanic background
      "syntax-comment": "#5A7268",
      "syntax-punctuation": "#A8BDB8",
      "syntax-number": "#C99F59",
      "syntax-string": "#6AAF8A",
      "syntax-operator": "#5BB5D9",
      "syntax-keyword": "#9B7FBF",
      "syntax-function": "#5BB5D9",
      "syntax-link": "#5BB5D9",
      "syntax-quote": "#9AB0A9",
      "syntax-chip": "#4A9E7F",
      "recipe-scrollbar-thumb": "#536660",
      "recipe-scrollbar-thumb-hover": "color-mix(in oklab, #536660 85%, #DCE6E3)",
      "recipe-button-inset-shadow": "inset 0 1px 0 rgba(180,230,210,0.15)",
      "recipe-surface-elevated-inset-shadow": "inset 0 1px 0 0 rgba(140,200,180,0.06)",
      "recipe-toolbar-control-hover-bg": "rgba(74,158,127,0.10)",
      "recipe-toolbar-control-hover-fg": "#4A9E7F",
      "recipe-toolbar-agent-hover-bg": "rgba(74,158,127,0.06)",
      "recipe-toolbar-divider": "rgba(42,58,53,0.5)",
      "recipe-toolbar-project-bg":
        "linear-gradient(180deg, rgba(140,200,180,0.05) 0%, transparent 100%), linear-gradient(135deg, #233830 0%, #1A2421 100%)",
      "recipe-toolbar-project-border": "rgba(140,200,180,0.12)",
      "recipe-toolbar-project-shadow": "inset 0 1px 0 rgba(140,200,180,0.06)",
      "recipe-toolbar-project-chip-bg": "#21302C",
      "recipe-toolbar-project-chip-border": "rgba(42,58,53,0.6)",
      "recipe-toolbar-project-meta-fg": "#9AB0A9",
      "recipe-toolbar-stats-bg": "rgba(140,200,180,0.05)",
      "recipe-toolbar-stats-border": "rgba(42,58,53,0.5)",
      "recipe-toolbar-stats-divider": "rgba(42,58,53,0.5)",
      "recipe-toolbar-stats-hover-bg": "rgba(74,158,127,0.10)",
      "recipe-pulse-card-bg": "#111615",
      "recipe-pulse-range-bg": "#23322E",
      "recipe-pulse-before-bg": "#0E1211",
      "recipe-pulse-empty-bg": "#23322E",
      "recipe-pulse-missed-bg": "rgba(209,123,114,0.18)",
      "recipe-pulse-skeleton-gradient":
        "linear-gradient(90deg, #23322E 25%, #2C3D38 50%, #23322E 75%)",
      "recipe-settings-dialog-bg": "#23322E",
      // Sidebar active — accent-tinted selection (wetter/glossier than overlay-base)
      "recipe-sidebar-active-bg": "rgba(74,158,127,0.08)",
      "recipe-sidebar-hover-bg": "rgba(74,158,127,0.04)",
      "recipe-sidebar-action-hover-bg": "rgba(74,158,127,0.08)",
      "recipe-dialog-shadow":
        "inset 0 1px 0 rgba(140,200,180,0.06), 0 24px 64px rgba(6,12,10,0.55)",
      "recipe-settings-search-bg": "#21302C",
      "recipe-settings-sidebar-bg": "rgba(17,22,21,0.70)",
      "recipe-settings-nav-active-bg": "rgba(74,158,127,0.15)",
      "recipe-settings-nav-hover-bg": "rgba(74,158,127,0.08)",
      "recipe-settings-kbd-bg": "#21302C",
      "recipe-settings-kbd-border": "#2A3A35",
      // Shadow — teal-black volcanic depth
      "recipe-shadow-ambient": "0 1px 3px rgba(6,12,10,0.40), 0 1px 2px rgba(6,12,10,0.30)",
      "recipe-shadow-floating": "0 12px 40px rgba(6,12,10,0.55), 0 4px 12px rgba(6,12,10,0.35)",
      "recipe-worktree-section-hover-bg": "rgba(74,158,127,0.04)",
    }),
  },
  {
    id: "highlands",
    name: "Highlands",
    type: "dark",
    builtin: true,
    location: "Scottish Highlands, Scotland",
    heroImage: "/themes/highlands.webp",
    tokens: createCanopyTokens("dark", {
      // Surfaces — brown-charcoal with gray-violet cast; matte, exposed
      "surface-grid": "#131114",
      "surface-sidebar": "#171519",
      "surface-toolbar": "#1A181C",
      "surface-canvas": "#201D24",
      "surface-panel": "#2C2831",
      "surface-panel-elevated": "#3E3845",
      // Text — heather-cool neutrals
      "text-primary": "#E2DCE6",
      "text-secondary": "#B2ABB8",
      "text-muted": "#948E9A",
      "text-inverse": "#201D24",
      "text-placeholder": "#605866",
      // Border
      "border-default": "#3C3742",
      "border-subtle": "rgba(195,185,210,0.06)",
      "border-strong": "rgba(195,185,210,0.12)",
      // Accent — heather purple; keeps Highlands away from Arashiyama's gold warmth
      "accent-primary": "#9B86AE",
      "accent-foreground": "#201D24",
      // Overlay — muted violet base; tints all hover/fill with heathered quality
      "overlay-base": "#C3B9D2",
      // Status
      "status-success": "#758C73",
      "status-warning": "#A88554",
      "status-danger": "#AB6B63",
      "status-info": "#848C96",
      // Activity
      "activity-active": "#64A36B",
      "activity-idle": "#605866",
      "activity-working": "#64A36B",
      "activity-waiting": "#BA9241",
      "activity-approval": "#BD6B38",
      "focus-ring": "rgba(175,160,195,0.22)",
      "shadow-color": "rgba(15,12,18,0.45)",
      "scrim-soft": "rgba(10,8,14,0.22)",
      "scrim-medium": "rgba(10,8,14,0.48)",
      "scrim-strong": "rgba(10,8,14,0.62)",
      // Search — paler heather lane, not full-strength interactive accent
      "search-highlight-background": "rgba(155,134,174,0.18)",
      "search-highlight-text": "#BAB0CC",
      "search-selected-result-border": "rgba(155,134,174,0.30)",
      "search-selected-result-icon": "#9B86AE",
      "search-match-badge-background": "rgba(155,134,174,0.20)",
      "search-match-badge-text": "#9B86AE",
      // Terminal — heather-tinted selection; warm amber cursor contrasts cool palette
      "terminal-background": "#201D24",
      "terminal-foreground": "#E2DCE6",
      "terminal-muted": "#948E9A",
      "terminal-cursor": "#BA9241",
      "terminal-selection": "#2a2235",
      "terminal-red": "#f87171",
      "terminal-green": "#64A36B",
      "terminal-yellow": "#A88554",
      "terminal-blue": "#7B9FCC",
      "terminal-magenta": "#9B86AE",
      "terminal-cyan": "#6BADB8",
      "terminal-bright-red": "#fca5a5",
      "terminal-bright-green": "#86C28B",
      "terminal-bright-yellow": "#C9A870",
      "terminal-bright-blue": "#9BBFE0",
      "terminal-bright-magenta": "#B8A6C8",
      "terminal-bright-cyan": "#8FCAD3",
      "terminal-bright-white": "#F0EBF4",
      // Syntax — warm-muted with heather/peat cast
      "syntax-comment": "#746E7A",
      "syntax-punctuation": "#C3BCCC",
      "syntax-number": "#C9A870",
      "syntax-string": "#86C28B",
      "syntax-operator": "#8ABDC8",
      "syntax-keyword": "#B8A0CC",
      "syntax-function": "#8AABDC",
      "syntax-link": "#7AB8CC",
      "syntax-quote": "#A8A0B0",
      "syntax-chip": "#9BC4C8",
      "recipe-scrollbar-thumb": "#605866",
      "recipe-scrollbar-thumb-hover": "color-mix(in oklab, #605866 85%, #E2DCE6)",
      "recipe-button-inset-shadow": "inset 0 1px 0 rgba(220,215,230,0.10)",
      "recipe-dialog-shadow": "0 20px 52px rgba(10,8,14,0.40)",
      "recipe-toolbar-control-hover-bg": "rgba(195,185,210,0.10)",
      "recipe-toolbar-control-hover-fg": "#9B86AE",
      "recipe-toolbar-agent-hover-bg": "rgba(195,185,210,0.06)",
      "recipe-toolbar-divider": "rgba(60,55,66,0.5)",
      "recipe-toolbar-project-bg":
        "linear-gradient(180deg, rgba(220,215,230,0.05) 0%, transparent 100%), linear-gradient(135deg, #2A2430 0%, #1C1820 100%)",
      "recipe-toolbar-project-border": "rgba(60,55,66,0.6)",
      "recipe-toolbar-project-shadow":
        "inset 0 1px 0 rgba(220,215,230,0.07), 0 1px 3px rgba(15,12,18,0.3)",
      "recipe-toolbar-project-chip-bg": "rgba(195,185,210,0.05)",
      "recipe-toolbar-project-chip-border": "rgba(60,55,66,0.6)",
      "recipe-toolbar-project-meta-fg": "#B2ABB8",
      "recipe-toolbar-stats-bg": "rgba(195,185,210,0.05)",
      "recipe-toolbar-stats-border": "rgba(60,55,66,0.5)",
      "recipe-toolbar-stats-divider": "rgba(60,55,66,0.5)",
      "recipe-toolbar-stats-hover-bg": "rgba(195,185,210,0.10)",
      "recipe-pulse-card-bg": "#171519",
      "recipe-pulse-range-bg": "#3E3845",
      "recipe-pulse-before-bg": "#151316",
      "recipe-pulse-empty-bg": "#3E3845",
      "recipe-pulse-missed-bg": "rgba(171,107,99,0.18)",
      "recipe-pulse-skeleton-gradient":
        "linear-gradient(90deg, #3E3845 25%, #4A4552 50%, #3E3845 75%)",
      "recipe-settings-dialog-bg": "#2C2831",
      "recipe-sidebar-active-bg": "rgba(195,185,210,0.04)",
      // Top sheen — heather-tinted, not generic white
      "recipe-surface-elevated-inset-shadow": "inset 0 1px 0 0 rgba(220,215,230,0.04)",
      // Sidebar active — double inset: top hairline + full-border glow
      "recipe-sidebar-active-shadow":
        "inset 0 1px 0 rgba(220,215,230,0.05), inset 0 0 0 1px rgba(195,185,210,0.06)",
      "recipe-sidebar-action-hover-bg": "rgba(195,185,210,0.05)",
      "recipe-settings-search-bg": "rgba(19,17,20,0.60)",
      "recipe-settings-sidebar-bg": "rgba(23,21,25,0.60)",
      "recipe-settings-nav-active-bg": "rgba(195,185,210,0.05)",
      "recipe-settings-nav-hover-bg": "rgba(195,185,210,0.05)",
      "recipe-settings-kbd-bg": "#201D24",
      "recipe-settings-kbd-border": "#3C3742",
      // Shadow — warm-violet moorland shadows
      "recipe-shadow-ambient": "0 1px 3px rgba(15,12,18,0.40)",
      "recipe-shadow-floating": "0 14px 40px rgba(15,12,18,0.45)",
      // Chrome noise texture — subtle 1–2% smoke/grain on chrome areas only
      "recipe-chrome-noise-texture":
        "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.75' numOctaves='4' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='200' height='200' filter='url(%23noise)' opacity='0.015'/%3E%3C/svg%3E\")",
    }),
  },
  {
    id: "namib",
    name: "Namib",
    type: "dark",
    builtin: true,
    location: "Namib Desert, Namibia",
    heroImage: "/themes/namib.webp",
    tokens: createCanopyTokens("dark", {
      // Surfaces — moonlit dune shadow; warm taupe/sand shell
      "surface-grid": "#110E0C",
      "surface-sidebar": "#171411",
      "surface-toolbar": "#1A1613",
      "surface-canvas": "#1F1B16",
      "surface-panel": "#25201A",
      "surface-panel-elevated": "#2F2922",
      // Text — warm sand hierarchy
      "text-primary": "#E8E2D9",
      "text-secondary": "#AEA497",
      "text-muted": "#665D50",
      "text-inverse": "#1F1B16",
      // Border — dry mineral edges
      "border-default": "#332D25",
      "border-subtle": "rgba(200,180,150,0.05)",
      "border-strong": "rgba(200,180,150,0.09)",
      // Accent — starlight edge signal; used for edges/focus/borders, not surface fills
      "accent-primary": "#86ABC3",
      "accent-foreground": "#1F1B16",
      // Overlay — warm sand tone; drives the sparse crisp hover ladder
      "overlay-base": "#C8B496",
      "overlay-subtle": "rgba(200,180,150,0.02)",
      "overlay-soft": "rgba(200,180,150,0.035)",
      "overlay-medium": "rgba(200,180,150,0.05)",
      "overlay-strong": "rgba(200,180,150,0.06)",
      "overlay-emphasis": "rgba(200,180,150,0.08)",
      // Status
      "status-success": "#8D9E8D",
      "status-warning": "#C59F54",
      "status-danger": "#C47A6B",
      "status-info": "#94968C",
      // Activity
      "activity-active": "#22c55e",
      "activity-idle": "#665D50",
      "activity-working": "#22c55e",
      "activity-waiting": "#fbbf24",
      "activity-approval": "#f97316",
      "focus-ring": "rgba(180,195,210,0.18)",
      "shadow-color": "rgba(14,11,8,0.40)",
      "scrim-soft": "rgba(14,11,8,0.18)",
      "scrim-medium": "rgba(14,11,8,0.40)",
      "scrim-strong": "rgba(14,11,8,0.55)",
      // Search — cooler night-sky blue lane; strictly separate from accent and success
      "search-highlight-background": "rgba(117,157,182,0.20)",
      "search-highlight-text": "#759DB6",
      "search-selected-result-border": "#759DB6",
      "search-selected-result-icon": "#759DB6",
      "search-match-badge-background": "rgba(117,157,182,0.15)",
      "search-match-badge-text": "#86ABC3",
      // Terminal
      "terminal-cursor": "#fbbf24",
      "terminal-background": "#1F1B16",
      "terminal-foreground": "#E8E2D9",
      "terminal-muted": "#665D50",
      "terminal-selection": "rgba(200,180,150,0.12)",
      // ANSI — tuned for warm taupe #1F1B16 background, dry desert palette
      "terminal-red": "#C87060",
      "terminal-green": "#10b981",
      "terminal-yellow": "#fbbf24",
      "terminal-blue": "#7BAFC8",
      "terminal-magenta": "#A07EC0",
      "terminal-cyan": "#5BB8C0",
      "terminal-bright-red": "#E09080",
      "terminal-bright-green": "#5CC48A",
      "terminal-bright-yellow": "#D8BC60",
      "terminal-bright-blue": "#90C4DC",
      "terminal-bright-magenta": "#B89CD4",
      "terminal-bright-cyan": "#80D0D8",
      "terminal-bright-white": "#E8E2D9",
      // Syntax — warm sand-biased for desert night
      "syntax-comment": "#726A5C",
      "syntax-punctuation": "#B8B0A0",
      "syntax-number": "#C8964A",
      "syntax-string": "#8AAE78",
      "syntax-operator": "#7AAEC0",
      "syntax-keyword": "#A088CC",
      "syntax-function": "#7AACCB",
      "syntax-link": "#6AACC4",
      "syntax-quote": "#9A9080",
      "syntax-chip": "#70B8B4",
      "recipe-scrollbar-thumb": "#665D50",
      "recipe-scrollbar-thumb-hover": "color-mix(in oklab, #665D50 85%, #E8E2D9)",
      "recipe-button-inset-shadow": "inset 0 1px 0 rgba(220,200,180,0.08)",
      "recipe-dialog-shadow": "0 10px 32px rgba(14,11,8,0.40)",
      "recipe-toolbar-control-hover-bg": "rgba(200,180,150,0.06)",
      "recipe-toolbar-control-hover-fg": "#86ABC3",
      "recipe-toolbar-agent-hover-bg": "rgba(200,180,150,0.05)",
      "recipe-toolbar-divider": "rgba(51,45,37,0.5)",
      "recipe-toolbar-project-bg":
        "linear-gradient(180deg, rgba(220,200,180,0.02), rgba(220,200,180,0.04)), linear-gradient(135deg, #211D18, #171411)",
      "recipe-toolbar-project-border": "rgba(51,45,37,0.6)",
      "recipe-toolbar-project-shadow": "inset 0 1px 0 rgba(220,200,180,0.04)",
      "recipe-toolbar-project-chip-bg": "rgba(200,180,150,0.035)",
      "recipe-toolbar-project-chip-border": "rgba(51,45,37,0.6)",
      "recipe-toolbar-project-meta-fg": "#AEA497",
      "recipe-toolbar-stats-bg": "rgba(200,180,150,0.035)",
      "recipe-toolbar-stats-border": "rgba(51,45,37,0.5)",
      "recipe-toolbar-stats-divider": "rgba(51,45,37,0.5)",
      "recipe-toolbar-stats-hover-bg": "rgba(200,180,150,0.06)",
      "recipe-pulse-card-bg": "#161310",
      "recipe-pulse-range-bg": "#2F2922",
      "recipe-pulse-before-bg": "#141110",
      "recipe-pulse-empty-bg": "#2F2922",
      "recipe-pulse-missed-bg": "rgba(196,122,107,0.18)",
      "recipe-pulse-skeleton-gradient":
        "linear-gradient(90deg, #2F2922 25%, #3A332B 50%, #2F2922 75%)",
      "recipe-settings-dialog-bg": "#25201A",
      "recipe-sidebar-active-bg": "rgba(200,180,150,0.04)",
      "recipe-sidebar-action-hover-bg": "rgba(200,180,150,0.04)",
      "recipe-settings-search-bg": "#1F1B16",
      "recipe-settings-nav-active-bg": "rgba(200,180,150,0.035)",
      "recipe-settings-nav-active-shadow": "inset 0 0 0 1px rgba(134,171,195,0.28)",
      "recipe-settings-nav-hover-bg": "rgba(200,180,150,0.04)",
      "recipe-settings-kbd-bg": "#1F1B16",
      "recipe-settings-kbd-border": "#332D25",
      // Top sheen — barely visible on dry desert theme
      "recipe-surface-elevated-inset-shadow": "inset 0 1px 0 0 rgba(220,200,180,0.02)",
      // Shadow — dry crisp desert shadows with warm sand-dark base
      "recipe-shadow-ambient": "0 1px 3px rgba(14,11,8,0.28), 0 1px 2px rgba(14,11,8,0.18)",
      "recipe-shadow-floating": "0 10px 32px rgba(14,11,8,0.40), 0 2px 8px rgba(14,11,8,0.22)",
      "recipe-worktree-section-hover-bg": "rgba(200,180,150,0.02)",
    }),
  },
  {
    id: "redwoods",
    name: "Redwoods",
    type: "dark",
    builtin: true,
    location: "Redwood National Park, California, USA",
    heroImage: "/themes/redwoods.webp",
    tokens: createCanopyTokens("dark", {
      // Surfaces — ancient forest-floor enclosure; bark-warm, dense, protective
      "surface-grid": "#090705",
      "surface-sidebar": "#110B08",
      "surface-toolbar": "#130D09",
      "surface-canvas": "#16110D",
      "surface-panel": "#1E1612",
      "surface-panel-elevated": "#2A1E18",
      "surface-inset": "#0E0A08",
      // Text — parchment-warm on forest floor
      "text-primary": "#E8DCC8",
      "text-secondary": "#9E8B78",
      "text-muted": "#6B5B4F",
      "text-inverse": "#16110D",
      // Border — warm bark grain
      "border-default": "#36241A",
      "border-subtle": "rgba(180,140,120,0.08)",
      "border-strong": "rgba(180,140,120,0.14)",
      // Accent — moss fern green; selection/focus, not for filling surfaces
      "accent-primary": "#4E9A53",
      "accent-foreground": "#16110D",
      // Overlay — terracotta base; humid forest-floor tint on hovers
      "overlay-base": "#B48C78",
      // Status
      "status-success": "#457B4D",
      "status-warning": "#BA8A42",
      "status-danger": "#B85C52",
      "status-info": "#6B8287",
      // Activity
      "activity-active": "#3CAE54",
      "activity-idle": "#5A4E42",
      "activity-working": "#3CAE54",
      "activity-waiting": "#CFA043",
      "activity-approval": "#C9682C",
      "focus-ring": "rgba(180,150,130,0.20)",
      "shadow-color": "rgba(9,5,3,0.55)",
      "scrim-soft": "rgba(9,5,3,0.35)",
      "scrim-medium": "rgba(9,5,3,0.65)",
      "scrim-strong": "rgba(9,5,3,0.78)",
      // Search — warmer/yellower moss lane, distinct from main accent green
      "search-highlight-background": "rgba(78,154,83,0.18)",
      "search-highlight-text": "#5CAF62",
      "search-selected-result-border": "rgba(78,154,83,0.45)",
      "search-selected-result-icon": "#4E9A53",
      "search-match-badge-background": "rgba(78,154,83,0.20)",
      "search-match-badge-text": "#4E9A53",
      // Terminal — forest floor; larger fog-diffused shadow blur
      "terminal-background": "#16110D",
      "terminal-foreground": "#E8DCC8",
      "terminal-muted": "#6B5B4F",
      "terminal-cursor": "#CFA043",
      "terminal-selection": "rgba(78,154,83,0.20)",
      // ANSI — tuned for bark-warm #16110D background, forest-floor palette
      "terminal-red": "#D4746C",
      "terminal-green": "#5EAE6C",
      "terminal-yellow": "#CFA043",
      "terminal-blue": "#6BA8C4",
      "terminal-magenta": "#B07AAE",
      "terminal-cyan": "#5ABCB0",
      "terminal-bright-red": "#E8988E",
      "terminal-bright-green": "#7DC88A",
      "terminal-bright-yellow": "#DDB866",
      "terminal-bright-blue": "#8DC4DC",
      "terminal-bright-magenta": "#C89AC4",
      "terminal-bright-cyan": "#7ACEC8",
      "terminal-bright-white": "#E8DCC8",
      // Syntax — warm bark/amber bias
      "syntax-comment": "#7a6e5e",
      "syntax-punctuation": "#B8A898",
      "syntax-number": "#d4956a",
      "syntax-string": "#8abf6e",
      "syntax-operator": "#7ec0b8",
      "syntax-keyword": "#B08098",
      "syntax-function": "#8AABCC",
      "syntax-link": "#6aadcc",
      "syntax-quote": "#9e8b78",
      "syntax-chip": "#72c0a8",
      "recipe-scrollbar-thumb": "#5A4E42",
      "recipe-scrollbar-thumb-hover": "color-mix(in oklab, #5A4E42 85%, #E8DCC8)",
      "recipe-button-inset-shadow": "inset 0 1px 0 rgba(220,190,170,0.12)",
      "recipe-toolbar-control-hover-bg": "rgba(180,140,120,0.10)",
      "recipe-toolbar-control-hover-fg": "#4E9A53",
      "recipe-toolbar-agent-hover-bg": "rgba(180,140,120,0.08)",
      "recipe-toolbar-divider": "rgba(54,36,26,0.5)",
      "recipe-toolbar-project-bg":
        "linear-gradient(180deg, rgba(220,190,170,0.06), rgba(220,190,170,0.05)), linear-gradient(135deg, #19110B, #0E0906)",
      "recipe-toolbar-project-border": "rgba(54,36,26,0.6)",
      "recipe-toolbar-project-shadow": "inset 0 1px 0 rgba(220,190,170,0.06)",
      "recipe-toolbar-project-chip-bg": "rgba(180,140,120,0.06)",
      "recipe-toolbar-project-chip-border": "rgba(54,36,26,0.6)",
      "recipe-toolbar-project-meta-fg": "#9E8B78",
      "recipe-toolbar-stats-bg": "rgba(180,140,120,0.06)",
      "recipe-toolbar-stats-border": "rgba(54,36,26,0.5)",
      "recipe-toolbar-stats-divider": "rgba(54,36,26,0.5)",
      "recipe-toolbar-stats-hover-bg": "rgba(180,140,120,0.10)",
      "recipe-pulse-card-bg": "#110B08",
      "recipe-pulse-range-bg": "#2A1E18",
      "recipe-pulse-before-bg": "#0D0907",
      "recipe-pulse-empty-bg": "#2A1E18",
      "recipe-pulse-missed-bg": "rgba(184,92,82,0.18)",
      "recipe-pulse-skeleton-gradient":
        "linear-gradient(90deg, #2A1E18 25%, #342820 50%, #2A1E18 75%)",
      "recipe-settings-dialog-bg": "#1E1612",
      // Sidebar active — accent-green selection (deep forest canopy glow)
      "recipe-sidebar-active-bg": "rgba(78,154,83,0.14)",
      "recipe-sidebar-hover-bg": "rgba(180,140,120,0.02)",
      "recipe-sidebar-action-hover-bg": "rgba(78,154,83,0.08)",
      "recipe-sidebar-active-shadow": "inset 0 1px 0 0 rgba(220,190,170,0.06)",
      "recipe-dialog-shadow": "0 20px 56px rgba(6,3,2,0.50)",
      "recipe-settings-search-bg": "#0E0A08",
      "recipe-settings-nav-active-bg": "rgba(78,154,83,0.14)",
      "recipe-settings-nav-hover-bg": "rgba(78,154,83,0.08)",
      "recipe-settings-kbd-bg": "#16110D",
      "recipe-settings-kbd-border": "#36241A",
      // Fog-diffused larger shadow radius for enclosed forest atmosphere
      "recipe-shadow-ambient": "0 4px 14px rgba(9,5,3,0.45), 0 1px 3px rgba(9,5,3,0.30)",
      "recipe-shadow-floating": "0 14px 42px rgba(9,5,3,0.55), 0 4px 12px rgba(9,5,3,0.35)",
      "recipe-worktree-section-hover-bg": "rgba(180,140,120,0.04)",
    }),
  },
  // ── Light themes ─────────────────────────────────────────────────────────
  {
    id: "atacama",
    name: "Atacama",
    type: "light",
    builtin: true,
    location: "Atacama Desert, Chile",
    heroImage: "/themes/atacama.webp",
    tokens: createCanopyTokens("light", {
      // Surfaces — warm-neutral mineral ladder; bleached stone from grid to elevated
      "surface-grid": "#D1CDC4",
      "surface-sidebar": "#D8D4CC",
      "surface-toolbar": "#E1DCD3",
      "surface-canvas": "#E8E4DD",
      "surface-panel": "#F2F0EB",
      "surface-panel-elevated": "#F9F7F4",
      "surface-input": "#F2F0EB",
      "surface-inset": "#DFDBD3",
      "surface-hover": "rgba(51,43,35,0.03)",
      "surface-active": "rgba(51,43,35,0.10)",
      // Text — warm earth tones
      "text-primary": "#332B27",
      "text-secondary": "#5C524B",
      "text-muted": "#8F877E",
      "text-inverse": "#F9F7F4",
      "text-link": "#117B8A",
      // Border — dry chalky warm-mineral edges
      "border-default": "rgba(51,43,35,0.08)",
      "border-subtle": "rgba(51,43,35,0.05)",
      "border-strong": "rgba(51,43,35,0.14)",
      "border-divider": "rgba(51,43,35,0.05)",
      "border-interactive": "rgba(51,43,35,0.10)",
      // Overlay — warm earth tints all hovers with mineral quality
      "overlay-base": "#332B23",
      "overlay-subtle": "rgba(51,43,35,0.02)",
      "overlay-soft": "rgba(51,43,35,0.03)",
      "overlay-medium": "rgba(51,43,35,0.05)",
      "overlay-strong": "rgba(51,43,35,0.07)",
      "overlay-emphasis": "rgba(51,43,35,0.10)",
      // Accent — restrained lagoon turquoise; translucent washes, not punchy fills
      "accent-primary": "#117B8A",
      "accent-foreground": "#F9F7F4",
      "accent-soft": "rgba(17,123,138,0.10)",
      "accent-muted": "rgba(17,123,138,0.18)",
      // Status — muted, dusted semantic outcomes
      "status-success": "#506D56",
      "status-warning": "#8F6936",
      "status-danger": "#A3544A",
      "status-info": "#677882",
      // Activity
      "activity-active": "#407A54",
      "activity-idle": "#8F877E",
      "activity-working": "#407A54",
      "activity-waiting": "#9C771C",
      "activity-approval": "#B36522",
      "github-open": "#1C823B",
      "github-merged": "#8254DB",
      "github-closed": "#C72B36",
      "github-draft": "#8E96A1",
      // Search — desaturated slate-blue, distinct from lagoon accent
      "search-highlight-background": "rgba(74,108,123,0.12)",
      "search-highlight-text": "#4A6C7B",
      "search-selected-result-border": "#4A6C7B",
      "search-selected-result-icon": "#4A6C7B",
      "search-match-badge-background": "rgba(74,108,123,0.20)",
      "search-match-badge-text": "#4A6C7B",
      "focus-ring": "rgba(17,123,138,0.25)",
      "scrim-soft": "rgba(40,34,28,0.30)",
      "scrim-medium": "rgba(40,34,28,0.44)",
      "scrim-strong": "rgba(40,34,28,0.58)",
      // Shadows — tighter and flatter than default; built for long reading comfort
      "shadow-color": "rgba(51,43,35,0.10)",
      "recipe-shadow-ambient": "0 2px 8px rgba(51,43,35,0.06)",
      "recipe-shadow-floating": "0 4px 12px rgba(51,43,35,0.10)",
      "recipe-dialog-shadow":
        "inset 0 1px 0 rgba(255,252,248,0.25), 0 6px 16px rgba(51,43,35,0.14)",
      "recipe-toolbar-control-hover-bg": "rgba(51,43,35,0.04)",
      "recipe-toolbar-control-hover-fg": "#117B8A",
      "recipe-toolbar-divider": "rgba(204,197,187,0.5)",
      "recipe-toolbar-project-bg":
        "linear-gradient(180deg, rgba(255,252,248,0.16), rgba(51,43,35,0.03)), linear-gradient(135deg, #F4EEE4, #E5DFD4)",
      "recipe-toolbar-project-border": "rgba(204,197,187,0.5)",
      "recipe-toolbar-project-shadow":
        "inset 0 1px 0 rgba(255,252,248,0.40), 0 1px 3px rgba(51,43,35,0.06)",
      "recipe-toolbar-project-chip-bg": "#F9F7F4",
      "recipe-toolbar-project-chip-border": "rgba(204,197,187,0.6)",
      "recipe-toolbar-project-meta-fg": "#5C524B",
      "recipe-toolbar-stats-bg": "rgba(51,43,35,0.03)",
      "recipe-toolbar-stats-border": "rgba(204,197,187,0.5)",
      "recipe-toolbar-stats-divider": "rgba(204,197,187,0.5)",
      "recipe-toolbar-stats-hover-bg": "rgba(51,43,35,0.04)",
      "recipe-pulse-card-bg": "#F9F7F4",
      "recipe-pulse-card-shadow": "0 1px 3px rgba(51,43,35,0.06)",
      "recipe-pulse-range-bg": "#EFECEA",
      "recipe-pulse-before-bg": "#DDD9D1",
      "recipe-pulse-empty-bg": "#EFECEA",
      "recipe-pulse-missed-bg": "rgba(163,84,74,0.10)",
      "recipe-pulse-skeleton-gradient":
        "linear-gradient(90deg, #E2DED6 25%, #ECE9E3 50%, #E2DED6 75%)",
      "recipe-settings-dialog-bg": "#F2F0EB",
      "recipe-sidebar-hover-bg": "rgba(51,43,35,0.03)",
      "recipe-sidebar-action-hover-bg": "rgba(51,43,35,0.03)",
      "recipe-settings-card-bg": "#F2F0EB",
      "recipe-settings-list-item-bg": "#F2F0EB",
      "recipe-settings-nav-active-bg": "rgba(17,123,138,0.06)",
      "recipe-settings-nav-hover-bg": "rgba(51,43,35,0.04)",
      "recipe-settings-subtab-active-border-width": "2px",
      "recipe-settings-kbd-border": "#CCC5BB",
      "recipe-scrollbar-thumb": "#8F877E",
      "recipe-scrollbar-thumb-hover": "color-mix(in oklab, #8F877E 85%, #332B27)",
      "recipe-button-inset-shadow": "inset 0 1px 0 rgba(255,252,248,0.65)",
      "recipe-surface-elevated-inset-shadow": "inset 0 1px 0 rgba(255,252,248,0.65)",
      // Terminal — volcanic dark bg with warm mineral foreground palette
      "terminal-background": "#24201D",
      "terminal-foreground": "#DFD7CD",
      "terminal-muted": "#918980",
      "terminal-cursor": "#C99F5E",
      "terminal-black": "#24201D",
      "terminal-white": "#DFD7CD",
      "terminal-bright-black": "#6B6560",
      "terminal-selection": "rgba(199,159,94,0.25)",
      "terminal-red": "#C97B72",
      "terminal-green": "#68A672",
      "terminal-yellow": "#B89155",
      "terminal-blue": "#6A8FAD",
      "terminal-magenta": "#9B7BAD",
      "terminal-cyan": "#5A9AA0",
      "terminal-bright-red": "#D99088",
      "terminal-bright-green": "#85BA8F",
      "terminal-bright-yellow": "#CAAA72",
      "terminal-bright-blue": "#88A8C4",
      "terminal-bright-magenta": "#B598C2",
      "terminal-bright-cyan": "#7AB5BB",
      "terminal-bright-white": "#F2EDE5",
      // Syntax — warm-earth tones harmonising with the mineral terminal palette
      "syntax-comment": "#7A7268",
      "syntax-punctuation": "#A8A09A",
      "syntax-number": "#B89155",
      "syntax-string": "#68A672",
      "syntax-operator": "#5A9AA0",
      "syntax-keyword": "#9B7BAD",
      "syntax-function": "#6A8FAD",
      "syntax-link": "#4A6C7B",
      "syntax-quote": "#918980",
      "syntax-chip": "#5A9AA0",
      // Category colors — dusted down, mineral palette
      "category-blue": "oklch(0.55 0.11 242)",
      "category-purple": "oklch(0.55 0.11 318)",
      "category-cyan": "oklch(0.56 0.09 198)",
      "category-green": "oklch(0.55 0.11 155)",
      "category-amber": "oklch(0.58 0.12 65)",
      "category-orange": "oklch(0.56 0.13 38)",
      "category-teal": "oklch(0.55 0.10 178)",
      "category-indigo": "oklch(0.54 0.11 264)",
      "category-rose": "oklch(0.56 0.12 14)",
      "category-pink": "oklch(0.55 0.11 340)",
      "category-violet": "oklch(0.54 0.11 295)",
      "category-slate": "oklch(0.50 0.03 228)",
    }),
  },
  {
    id: "bali",
    name: "Bali",
    type: "light",
    builtin: true,
    location: "Bali, Indonesia",
    heroImage: "/themes/bali.webp",
    tokens: createCanopyTokens("light", {
      // Surfaces — green-tinted paras stone ladder; tropical and dappled
      "surface-grid": "#CCD6BF",
      "surface-sidebar": "#DBE5CF",
      "surface-toolbar": "#E3EBD9",
      "surface-canvas": "#E8EFE0",
      "surface-panel": "#F2F7E9",
      "surface-panel-elevated": "#FAFCF5",
      "surface-input": "#F0F6E8",
      "surface-inset": "#DFEAD4",
      "surface-hover": "rgba(20,40,25,0.035)",
      "surface-active": "rgba(20,40,25,0.06)",
      // Text
      "text-primary": "#1D2B1E",
      "text-secondary": "#4F614C",
      "text-muted": "#788C76",
      "text-inverse": "#FAFCF5",
      "text-link": "#228243",
      // Border — soft and mossy
      "border-default": "rgba(20,40,25,0.07)",
      "border-subtle": "rgba(20,40,25,0.04)",
      "border-strong": "rgba(25,45,28,0.12)",
      "border-divider": "rgba(20,40,25,0.05)",
      "border-interactive": "rgba(34,130,67,0.22)",
      // Accent — warm jade
      "accent-primary": "#228243",
      "accent-foreground": "#FAFCF5",
      "accent-soft": "rgba(34,130,67,0.14)",
      "accent-muted": "rgba(34,130,67,0.26)",
      // Secondary — silver-tree sage botanical lane
      "accent-secondary": "#6B8F71",
      // Overlay — deep forest green; filtered-tropical-light hover feel
      "overlay-base": "#142819",
      "overlay-subtle": "rgba(20,40,25,0.02)",
      "overlay-soft": "rgba(20,40,25,0.035)",
      "overlay-medium": "rgba(20,40,25,0.06)",
      "overlay-strong": "rgba(20,40,25,0.08)",
      "overlay-emphasis": "rgba(20,40,25,0.12)",
      // Status
      "status-success": "#288758",
      "status-warning": "#A36D1F",
      "status-danger": "#B04B40",
      "status-info": "#3E737A",
      // Activity
      "activity-active": "#229452",
      "activity-idle": "#829180",
      "activity-working": "#229452",
      "activity-waiting": "#BA7D1F",
      "activity-approval": "#CC6E14",
      "github-open": "#188537",
      "github-merged": "#864BE8",
      "github-closed": "#D41E2B",
      "github-draft": "#85909C",
      // Search — independent green lane
      "search-highlight-background": "rgba(27,133,97,0.20)",
      "search-highlight-text": "#1B8561",
      "search-selected-result-border": "#1B8561",
      "search-selected-result-icon": "#1B8561",
      "search-match-badge-background": "rgba(27,133,97,0.20)",
      "search-match-badge-text": "#1B8561",
      // Focus ring — jade tinted, generous offset for humid breathing room
      "focus-ring": "rgba(34,130,67,0.28)",
      "recipe-focus-ring-offset": "3px",
      "scrim-soft": "rgba(20,40,25,0.28)",
      "scrim-medium": "rgba(20,40,25,0.46)",
      "scrim-strong": "rgba(20,40,25,0.64)",
      // Shadows — deep tropical canopy shade; larger blur for humidity
      "shadow-color": "rgba(20,40,25,0.10)",
      "recipe-shadow-ambient": "0 14px 48px rgba(20,40,25,0.06)",
      "recipe-shadow-floating": "0 24px 64px rgba(20,40,25,0.10), 0 8px 18px rgba(20,40,25,0.06)",
      "recipe-dialog-shadow": "0 28px 56px rgba(20,40,25,0.06), 0 10px 24px rgba(20,40,25,0.10)",
      "recipe-toolbar-control-hover-bg": "rgba(20,40,25,0.035)",
      "recipe-toolbar-control-hover-fg": "#228243",
      "recipe-toolbar-divider": "rgba(20,40,25,0.04)",
      "recipe-toolbar-project-bg":
        "linear-gradient(180deg, rgba(30,48,30,0.02), rgba(25,45,28,0.05)), linear-gradient(135deg, #EEF1E8, #E4E8DE)",
      "recipe-toolbar-project-border": "rgba(20,40,25,0.042)",
      "recipe-toolbar-project-shadow": "inset 0 1px 0 rgba(25,45,28,0.06)",
      "recipe-toolbar-project-chip-bg": "rgba(0,0,0,0.04)",
      "recipe-toolbar-project-chip-border": "rgba(20,40,25,0.042)",
      "recipe-toolbar-project-meta-fg": "#4F614C",
      "recipe-toolbar-stats-bg": "rgba(0,0,0,0.04)",
      "recipe-toolbar-stats-border": "rgba(20,40,25,0.035)",
      "recipe-toolbar-stats-divider": "rgba(20,40,25,0.04)",
      "recipe-toolbar-stats-hover-bg": "rgba(20,40,25,0.035)",
      "recipe-pulse-card-bg": "#FAFCF5",
      "recipe-pulse-card-shadow": "0 1px 3px rgba(20,40,25,0.06)",
      "recipe-pulse-range-bg": "#EFF4E7",
      "recipe-pulse-before-bg": "#E0EAD3",
      "recipe-pulse-empty-bg": "#EFF4E7",
      "recipe-pulse-missed-bg": "rgba(176,75,64,0.10)",
      "recipe-pulse-skeleton-gradient":
        "linear-gradient(90deg, #DFEAD4 25%, #EAF2DE 50%, #DFEAD4 75%)",
      "recipe-settings-dialog-bg": "#F2F7E9",
      "recipe-sidebar-active-bg":
        "linear-gradient(180deg, rgba(34,130,67,0.05), rgba(34,130,67,0.02)), #FAFCF5",
      "recipe-sidebar-active-shadow":
        "0 20px 44px rgba(20,40,25,0.06), 0 8px 18px rgba(20,40,25,0.10)",
      "recipe-sidebar-hover-bg": "rgba(20,40,25,0.035)",
      "recipe-sidebar-action-hover-bg": "rgba(20,40,25,0.035)",
      "recipe-settings-search-bg": "#F0F6E8",
      "recipe-settings-card-bg": "#F2F7E9",
      "recipe-settings-list-item-bg": "#F2F7E9",
      "recipe-settings-nav-active-bg": "rgba(34,130,67,0.08)",
      "recipe-settings-nav-active-shadow":
        "inset 0 0 0 1px rgba(34,130,67,0.20), inset 0 1px 0 rgba(255,250,236,0.42), inset 0 1px 2px rgba(20,40,25,0.02)",
      "recipe-settings-nav-hover-bg": "rgba(20,40,25,0.035)",
      "recipe-scrollbar-thumb": "#788C76",
      "recipe-scrollbar-thumb-hover": "color-mix(in oklab, #788C76 85%, #1D2B1E)",
      "recipe-button-inset-shadow": "inset 0 1px 0 rgba(255,252,240,0.70)",
      "recipe-surface-elevated-inset-shadow": "inset 0 1px 0 rgba(255,252,240,0.70)",
      // Terminal — deep volcanic green environment
      "terminal-background": "#182B1B",
      "terminal-foreground": "#DCE6D9",
      "terminal-muted": "#5C8A65",
      "terminal-cursor": "#DDAA33",
      "terminal-black": "#182B1B",
      "terminal-white": "#DCE6D9",
      "terminal-bright-black": "#829180",
      "terminal-selection": "rgba(34,130,67,0.30)",
      // ANSI — tuned for dark volcanic green background #182B1B
      "terminal-red": "#E07870",
      "terminal-green": "#64B884",
      "terminal-yellow": "#D4A840",
      "terminal-blue": "#60AACC",
      "terminal-magenta": "#C080C0",
      "terminal-cyan": "#44C4AA",
      "terminal-bright-red": "#F09888",
      "terminal-bright-green": "#80D49C",
      "terminal-bright-yellow": "#F0C060",
      "terminal-bright-blue": "#84C8E4",
      "terminal-bright-magenta": "#D4A4D8",
      "terminal-bright-cyan": "#68D4BC",
      "terminal-bright-white": "#FAFCF5",
      // Syntax — against dark terminal #182B1B; warm botanical palette
      "syntax-comment": "#5A7865",
      "syntax-punctuation": "#A4C4AC",
      "syntax-number": "#D4A840",
      "syntax-string": "#78C090",
      "syntax-operator": "#50C4A8",
      "syntax-keyword": "#C090CC",
      "syntax-function": "#78B8E0",
      "syntax-link": "#52BCAC",
      "syntax-quote": "#8EA88E",
      "syntax-chip": "#6CC8B0",
      // Category colors — coastal-weighted, reduced chroma for Bali
      "category-blue": "oklch(0.55 0.11 242)",
      "category-purple": "oklch(0.55 0.11 318)",
      "category-cyan": "oklch(0.56 0.09 198)",
      "category-green": "oklch(0.55 0.11 155)",
      "category-amber": "oklch(0.58 0.12 65)",
      "category-orange": "oklch(0.56 0.13 38)",
      "category-teal": "oklch(0.55 0.09 178)",
      "category-indigo": "oklch(0.54 0.11 264)",
      "category-rose": "oklch(0.56 0.12 14)",
      "category-pink": "oklch(0.55 0.11 340)",
      "category-violet": "oklch(0.54 0.11 295)",
      "category-slate": "oklch(0.50 0.03 228)",
    }),
  },
  {
    id: "hokkaido",
    name: "Hokkaido",
    type: "light",
    builtin: true,
    location: "Hokkaido, Japan",
    heroImage: "/themes/hokkaido.webp",
    tokens: createCanopyTokens("light", {
      // Surfaces — frosted lavender snow ladder; no pure white anywhere
      "surface-grid": "#D9DEEE",
      "surface-sidebar": "#E7ECF7",
      "surface-toolbar": "#EEF2F9",
      "surface-canvas": "#F2F1FA",
      "surface-panel": "#FBFAFE",
      "surface-panel-elevated": "#FDFCFF",
      "surface-input": "#FAF8FD",
      "surface-inset": "#EEF1F9",
      "surface-hover": "rgba(82,88,118,0.03)",
      "surface-active": "rgba(82,88,118,0.05)",
      // Text — lavender-slate; ink under snow
      "text-primary": "#2B2F42",
      "text-secondary": "#6A708C",
      "text-muted": "#9BA3BE",
      "text-inverse": "#FDFCFF",
      "text-link": "#586CD6",
      // Borders — wider ladder so subtle/default/strong feel distinct
      "border-default": "#CED4E5",
      "border-subtle": "rgba(82,88,118,0.035)",
      "border-divider": "rgba(82,88,118,0.03)",
      "border-interactive": "rgba(82,88,118,0.08)",
      "border-strong": "rgba(82,88,118,0.11)",
      // Overlay — muted indigo base; tints hovers with lavender quality
      "overlay-base": "#525276",
      "overlay-subtle": "rgba(82,88,118,0.02)",
      "overlay-soft": "rgba(82,88,118,0.03)",
      "overlay-medium": "rgba(82,88,118,0.045)",
      "overlay-strong": "rgba(82,88,118,0.06)",
      "overlay-emphasis": "rgba(82,88,118,0.09)",
      // Accent — indigo: ink under snow; quiet in fills, sharp at edges
      "accent-primary": "#586CD6",
      "accent-foreground": "#FDFCFF",
      "accent-soft": "rgba(88,108,214,0.08)",
      "accent-muted": "rgba(88,108,214,0.17)",
      // Status
      "status-success": "#447761",
      "status-warning": "#A0661E",
      "status-danger": "#A95058",
      "status-info": "#5A77A6",
      // Activity
      "activity-active": "#55856C",
      "activity-idle": "#9BA3BE",
      "activity-working": "#55856C",
      "activity-waiting": "#A9812A",
      "activity-approval": "#C2752B",
      "github-open": "#23863C",
      "github-merged": "#895CDA",
      "github-closed": "#D4323E",
      "github-draft": "#929BA5",
      "focus-ring": "rgba(88,108,214,0.19)",
      "shadow-color": "rgba(86,81,118,0.07)",
      "scrim-soft": "rgba(82,88,118,0.28)",
      "scrim-medium": "rgba(82,88,118,0.40)",
      "scrim-strong": "rgba(82,88,118,0.62)",
      // Search — cooler slate-blue wayfinding lane, distinct from indigo accent
      "search-highlight-background": "rgba(80,117,165,0.20)",
      "search-highlight-text": "#5075A5",
      "search-selected-result-border": "#5075A5",
      "search-selected-result-icon": "#5075A5",
      "search-match-badge-background": "rgba(80,117,165,0.20)",
      "search-match-badge-text": "#5075A5",
      // Terminal — darker indigo evening-light layer inside the light workbench
      "terminal-background": "#2D334A",
      "terminal-foreground": "#E2E8F4",
      "terminal-muted": "#80A0D6",
      "terminal-selection": "#343C66",
      "terminal-cursor": "#C2A170",
      "terminal-black": "#2D334A",
      "terminal-white": "#E2E8F4",
      "terminal-bright-black": "#6A708C",
      "terminal-red": "#C87070",
      "terminal-green": "#7AA889",
      "terminal-yellow": "#C2A170",
      "terminal-blue": "#80A0D6",
      "terminal-magenta": "#A28AD6",
      "terminal-cyan": "#7FB9C2",
      "terminal-bright-red": "#D4909A",
      "terminal-bright-green": "#91BEA8",
      "terminal-bright-yellow": "#D4B88A",
      "terminal-bright-blue": "#9BBAE0",
      "terminal-bright-magenta": "#B8A4E0",
      "terminal-bright-cyan": "#99CCD4",
      "terminal-bright-white": "#F2F4FA",
      // Syntax — muted lavender-slate workbench palette
      "syntax-comment": "#98A0B4",
      "syntax-punctuation": "#7E879E",
      "syntax-number": "#A67E92",
      "syntax-string": "#6C8B87",
      "syntax-operator": "#6F81A0",
      "syntax-keyword": "#776BB8",
      "syntax-function": "#556FBC",
      "syntax-link": "#5E7DB8",
      "syntax-quote": "#7E8494",
      "syntax-chip": "#6F96AA",
      // Elevation — frosted snow-lit sheen + diffuse lilac shadow
      "recipe-surface-elevated-inset-shadow": "inset 0 1px 0 rgba(255,255,255,0.45)",
      "recipe-shadow-ambient": "0 14px 48px rgba(86,81,118,0.07)",
      "recipe-shadow-floating": "0 22px 64px rgba(86,81,118,0.07)",
      "recipe-button-inset-shadow": "inset 0 1px 0 rgba(255,255,255,0.45)",
      "recipe-dialog-shadow":
        "inset 0 1px 0 rgba(255,255,255,0.45), 0 22px 64px rgba(86,81,118,0.07)",
      "recipe-toolbar-control-hover-bg": "rgba(82,88,118,0.03)",
      "recipe-toolbar-control-hover-fg": "#5F72DE",
      "recipe-toolbar-divider": "rgba(206,212,229,0.5)",
      "recipe-toolbar-project-bg":
        "linear-gradient(135deg, rgba(255,255,255,0.88), rgba(236,240,250,0.92))",
      "recipe-toolbar-project-border": "rgba(206,212,229,0.6)",
      "recipe-toolbar-project-shadow":
        "inset 0 1px 0 rgba(255,255,255,0.35), 0 10px 22px rgba(82,88,118,0.04)",
      "recipe-toolbar-project-chip-bg": "rgba(82,88,118,0.04)",
      "recipe-toolbar-project-chip-border": "rgba(206,212,229,0.6)",
      "recipe-toolbar-project-meta-fg": "#6A708C",
      "recipe-toolbar-stats-bg": "rgba(82,88,118,0.04)",
      "recipe-toolbar-stats-border": "rgba(206,212,229,0.5)",
      "recipe-toolbar-stats-divider": "rgba(206,212,229,0.5)",
      "recipe-toolbar-stats-hover-bg": "rgba(82,88,118,0.03)",
      "recipe-pulse-card-bg": "#FDFCFF",
      "recipe-pulse-card-shadow": "0 1px 3px rgba(86,81,118,0.07)",
      "recipe-pulse-range-bg": "#F3F2FA",
      "recipe-pulse-before-bg": "#E0E4F0",
      "recipe-pulse-empty-bg": "#F3F2FA",
      "recipe-pulse-missed-bg": "rgba(169,80,88,0.10)",
      "recipe-pulse-skeleton-gradient":
        "linear-gradient(90deg, #E5E8F4 25%, #F0F0FA 50%, #E5E8F4 75%)",
      "recipe-settings-dialog-bg": "#FDFCFF",
      // Sidebar active — compound inset sheen + diffuse lilac drop
      "recipe-sidebar-active-shadow":
        "inset 0 1px 0 rgba(255,255,255,0.45), 0 8px 24px rgba(86,81,118,0.06)",
      "recipe-sidebar-hover-bg": "rgba(82,88,118,0.03)",
      "recipe-sidebar-action-hover-bg": "rgba(82,88,118,0.03)",
      "recipe-settings-search-bg": "#FAF8FD",
      "recipe-settings-card-bg": "#FBFAFE",
      "recipe-settings-list-item-bg": "#FBFAFE",
      "recipe-settings-sidebar-bg": "rgba(231,236,247,0.75)",
      "recipe-settings-header-bg": "rgba(238,242,249,0.50)",
      "recipe-settings-nav-active-bg": "rgba(95,114,222,0.08)",
      "recipe-settings-nav-hover-bg": "rgba(82,88,118,0.03)",
      "recipe-settings-kbd-bg": "#EEF1F9",
      "recipe-settings-kbd-border": "#CED4E5",
      // Recipe opacities — slightly quieter than light defaults for snow-filtered feel
      "recipe-state-chip-bg-opacity": "0.10",
      "recipe-state-chip-border-opacity": "0.30",
      "recipe-label-pill-bg-opacity": "0.07",
      "recipe-label-pill-border-opacity": "0.14",
      "recipe-scrollbar-thumb": "#9BA3BE",
      "recipe-scrollbar-thumb-hover": "color-mix(in oklab, #9BA3BE 85%, #2B2F42)",
      // Category colors — Hokkaido-tuned: cooler, quieter for lavender-slate shell
      "category-blue": "oklch(0.55 0.12 246)",
      "category-purple": "oklch(0.56 0.11 314)",
      "category-cyan": "oklch(0.58 0.08 214)",
      "category-green": "oklch(0.56 0.10 154)",
      "category-amber": "oklch(0.60 0.11 72)",
      "category-orange": "oklch(0.58 0.12 42)",
      "category-teal": "oklch(0.57 0.09 186)",
      "category-indigo": "oklch(0.54 0.12 270)",
      "category-rose": "oklch(0.57 0.11 12)",
      "category-slate": "oklch(0.53 0.025 248)",
      "category-pink": "oklch(0.58 0.10 338)",
      "category-violet": "oklch(0.55 0.11 292)",
    }),
  },
  {
    id: "serengeti",
    name: "Serengeti",
    type: "light",
    builtin: true,
    location: "Serengeti National Park, Tanzania",
    heroImage: "/themes/serengeti.webp",
    tokens: createCanopyTokens("light", {
      // Surfaces — warm parchment; drygrass grid, acacia sidebar, horizon-light elevated
      "surface-canvas": "#FDF5E2",
      "surface-sidebar": "#EADCB8",
      "surface-toolbar": "#F6ECD5",
      "surface-panel": "#FEFAF0",
      "surface-panel-elevated": "#FFFCF5",
      "surface-grid": "#E2D1A9",
      "surface-input": "#FEFAF0",
      "surface-inset": "#F2E4C9",
      "surface-hover": "rgba(44,33,15,0.04)",
      "surface-active": "rgba(44,33,15,0.06)",
      // Text — umber hierarchy on parchment
      "text-primary": "#3D2D19",
      "text-secondary": "#68573D",
      "text-muted": "#8A7A5C",
      "text-inverse": "#1E160C",
      "text-placeholder": "#B0A080",
      "text-link": "#586932",
      // Border — warm ochre default; alpha ladder on deep-amber overlay base
      "border-default": "#D4C499",
      "border-subtle": "rgba(44,33,15,0.05)",
      "border-divider": "rgba(44,33,15,0.09)",
      "border-interactive": "rgba(44,33,15,0.12)",
      "border-strong": "rgba(44,33,15,0.16)",
      // Overlay — deep amber base; tints all interactive fills with golden warmth
      "overlay-base": "#2C210F",
      "overlay-subtle": "rgba(44,33,15,0.03)",
      "overlay-soft": "rgba(44,33,15,0.04)",
      "overlay-medium": "rgba(44,33,15,0.06)",
      "overlay-strong": "rgba(44,33,15,0.08)",
      "overlay-emphasis": "rgba(44,33,15,0.12)",
      // Accent — ochre/acacia amber; secondary gold for dual-accent wayfinding
      "accent-primary": "#A28224",
      "accent-foreground": "#1E160C",
      "accent-soft": "rgba(162,130,36,0.14)",
      "accent-muted": "rgba(162,130,36,0.28)",
      "accent-secondary": "#A28224",
      // Status
      "status-success": "#5E7A45",
      "status-warning": "#A0601E",
      "status-danger": "#AD483A",
      "status-info": "#56718A",
      // Activity
      "activity-active": "#557F43",
      "activity-idle": "#968666",
      "activity-working": "#557F43",
      "activity-waiting": "#A87A20",
      "activity-approval": "#C96A18",
      "github-open": "#1D853A",
      "github-merged": "#8753E4",
      "github-closed": "#D42531",
      "github-draft": "#8E97A1",
      "focus-ring": "rgba(162,130,36,0.38)",
      "shadow-color": "rgba(44,33,15,0.12)",
      "scrim-soft": "rgba(44,33,21,0.32)",
      "scrim-medium": "rgba(44,33,21,0.54)",
      "scrim-strong": "rgba(44,33,21,0.72)",
      // Search — acacia green lane, fully independent from ochre accent
      "search-highlight-background": "rgba(90,107,53,0.14)",
      "search-highlight-text": "#5A6B35",
      "search-selected-result-border": "#5A6B35",
      "search-selected-result-icon": "#5A6B35",
      "search-match-badge-background": "rgba(90,107,53,0.16)",
      "search-match-badge-text": "#5A6B35",
      // Terminal — dark umber shell, warm parchment foreground, amber cursor
      "terminal-background": "#2C2115",
      "terminal-foreground": "#E8DDC5",
      "terminal-muted": "#6B7B3A",
      "terminal-cursor": "#A87A20",
      "terminal-black": "#2C2115",
      "terminal-white": "#E8DDC5",
      "terminal-bright-black": "#968666",
      "terminal-selection": "rgba(162,130,36,0.28)",
      // ANSI — tuned for warm dark umber background #2C2115
      "terminal-red": "#D47060",
      "terminal-green": "#6BAA55",
      "terminal-yellow": "#C49840",
      "terminal-blue": "#6A98B8",
      "terminal-magenta": "#A87898",
      "terminal-cyan": "#5AACA0",
      "terminal-bright-red": "#E89080",
      "terminal-bright-green": "#88C070",
      "terminal-bright-yellow": "#DDB860",
      "terminal-bright-blue": "#88B8D4",
      "terminal-bright-magenta": "#C098B0",
      "terminal-bright-cyan": "#78C8BA",
      "terminal-bright-white": "#F8F0DD",
      // Syntax — warm savanna tones for umber terminal
      "syntax-comment": "#6B6050",
      "syntax-punctuation": "#B8A890",
      "syntax-number": "#C49840",
      "syntax-string": "#6BAA55",
      "syntax-operator": "#5AACA0",
      "syntax-keyword": "#B08898",
      "syntax-function": "#6A98B8",
      "syntax-link": "#588AA0",
      "syntax-quote": "#8A7A5C",
      "syntax-chip": "#78B898",
      "recipe-scrollbar-thumb": "#968666",
      "recipe-scrollbar-thumb-hover": "color-mix(in oklab, #968666 85%, #3D2D19)",
      "recipe-shadow-ambient": "0 4px 12px rgba(44,33,15,0.07)",
      "recipe-shadow-floating": "0 8px 24px rgba(44,33,15,0.11)",
      "recipe-button-inset-shadow": "inset 0 1px 0 rgba(255,252,240,0.75)",
      "recipe-surface-elevated-inset-shadow": "inset 0 1px 0 rgba(255,252,240,0.75)",
      "recipe-dialog-shadow": "0 8px 24px rgba(44,33,15,0.11)",
      "recipe-toolbar-control-hover-bg": "rgba(162,130,36,0.06)",
      "recipe-toolbar-control-hover-fg": "#A28224",
      "recipe-toolbar-agent-hover-bg": "rgba(162,130,36,0.05)",
      "recipe-toolbar-divider": "rgba(212,196,153,0.5)",
      "recipe-toolbar-project-bg":
        "linear-gradient(180deg, rgba(44,33,15,0.02), rgba(44,33,15,0.04)), linear-gradient(135deg, #F2E8D2, #E6D8B8)",
      "recipe-toolbar-project-border": "rgba(212,196,153,0.6)",
      "recipe-toolbar-project-shadow": "inset 0 1px 0 rgba(44,33,15,0.04)",
      "recipe-toolbar-project-chip-bg": "rgba(44,33,15,0.04)",
      "recipe-toolbar-project-chip-border": "rgba(212,196,153,0.6)",
      "recipe-toolbar-project-meta-fg": "#68573D",
      "recipe-toolbar-stats-bg": "rgba(162,130,36,0.05)",
      "recipe-toolbar-stats-border": "rgba(212,196,153,0.5)",
      "recipe-toolbar-stats-divider": "rgba(212,196,153,0.5)",
      "recipe-toolbar-stats-hover-bg": "rgba(162,130,36,0.06)",
      "recipe-pulse-card-bg": "#FFFCF5",
      "recipe-pulse-card-shadow": "0 1px 3px rgba(44,33,15,0.07)",
      "recipe-pulse-range-bg": "#FBF6EA",
      "recipe-pulse-before-bg": "#EFE2C5",
      "recipe-pulse-empty-bg": "#FBF6EA",
      "recipe-pulse-missed-bg": "rgba(173,72,58,0.10)",
      "recipe-pulse-skeleton-gradient":
        "linear-gradient(90deg, #F0E6CE 25%, #F8F1DC 50%, #F0E6CE 75%)",
      "recipe-settings-dialog-bg": "#FEFAF0",
      "recipe-sidebar-hover-bg": "rgba(162,130,36,0.06)",
      "recipe-sidebar-action-hover-bg": "rgba(162,130,36,0.06)",
      "recipe-settings-search-bg": "#F2E4C9",
      "recipe-settings-card-bg": "#FEFAF0",
      "recipe-settings-list-item-bg": "#FEFAF0",
      "recipe-settings-sidebar-bg": "#EADCB8",
      "recipe-settings-nav-active-bg": "rgba(162,130,36,0.10)",
      "recipe-settings-nav-active-shadow":
        "0 1px 3px rgba(44,33,15,0.07), inset 0 0 0 1px rgba(162,130,36,0.20)",
      "recipe-settings-nav-hover-bg": "rgba(162,130,36,0.06)",
      "recipe-worktree-section-hover-bg": "rgba(162,130,36,0.06)",
      // Category colors — grassland-weighted palette
      "category-blue": "oklch(0.54 0.11 235)",
      "category-purple": "oklch(0.54 0.12 320)",
      "category-cyan": "oklch(0.56 0.09 190)",
      "category-green": "oklch(0.55 0.12 145)",
      "category-amber": "oklch(0.60 0.15 75)",
      "category-orange": "oklch(0.58 0.16 50)",
      "category-teal": "oklch(0.55 0.09 180)",
      "category-indigo": "oklch(0.52 0.11 270)",
      "category-rose": "oklch(0.57 0.13 25)",
      "category-slate": "oklch(0.50 0.03 230)",
      "category-pink": "oklch(0.57 0.11 10)",
      "category-violet": "oklch(0.53 0.11 295)",
    }),
  },
  {
    id: "svalbard",
    name: "Svalbard",
    type: "light",
    builtin: true,
    location: "Svalbard Archipelago, Norway",
    heroImage: "/themes/svalbard.webp",
    tokens: createCanopyTokens("light", {
      // Surfaces — cool blue-gray paper under diffused Arctic cloud light
      "surface-grid": "#C4D0D9",
      "surface-sidebar": "#D1DBE4",
      "surface-toolbar": "#DBE4EB",
      "surface-canvas": "#E5EBF0",
      "surface-panel": "#F0F4F7",
      "surface-panel-elevated": "#FBFCFD",
      "surface-input": "#F2F6F9",
      "surface-inset": "#CED7E0",
      "surface-hover": "rgba(20,35,50,0.025)",
      "surface-active": "rgba(20,35,50,0.04)",
      // Text — deep Arctic ink, cool secondary and muted
      "text-primary": "#1E2B38",
      "text-secondary": "#4E5F70",
      "text-muted": "#7D8F9F",
      "text-inverse": "#FFFFFF",
      "text-link": "#36738F",
      // Border — frosted glass layering
      "border-default": "#AAB7C2",
      "border-subtle": "rgba(20,35,50,0.04)",
      "border-divider": "rgba(20,35,50,0.04)",
      "border-strong": "rgba(20,35,50,0.12)",
      "border-interactive": "rgba(20,35,50,0.09)",
      // Overlay — deep arctic base; quieter than other light themes
      "overlay-base": "#142332",
      "overlay-subtle": "rgba(20,35,50,0.02)",
      "overlay-soft": "rgba(20,35,50,0.025)",
      "overlay-medium": "rgba(20,35,50,0.04)",
      "overlay-strong": "rgba(20,35,50,0.06)",
      "overlay-emphasis": "rgba(20,35,50,0.08)",
      // Accent — restrained steel-blue (grayer/cooler than Bondi's energetic teal)
      "accent-primary": "#36738F",
      "accent-foreground": "#FFFFFF",
      "accent-hover": "#2F627C",
      // Status — muted for Arctic mood
      "status-success": "#36635A",
      "status-warning": "#826A38",
      "status-danger": "#9E5553",
      "status-info": "#4B6D82",
      // Activity
      "activity-active": "#346B5C",
      "activity-idle": "#7D8F9F",
      "activity-working": "#346B5C",
      "activity-waiting": "#8F7335",
      "activity-approval": "#AA6F3A",
      "github-open": "#2C704C",
      "github-merged": "#6C5CA8",
      "github-closed": "#AF5450",
      "github-draft": "#7D8A96",
      // Search — dedicated darker steel-navy lane, distinct from interaction accent
      "search-highlight-background": "rgba(31,81,101,0.12)",
      "search-highlight-text": "#1F5165",
      "search-selected-result-border": "#1F5165",
      "search-selected-result-icon": "#1F5165",
      "search-match-badge-background": "rgba(31,81,101,0.10)",
      "search-match-badge-text": "#1F5165",
      "focus-ring": "rgba(54,115,143,0.18)",
      "scrim-soft": "rgba(20,35,50,0.22)",
      "scrim-medium": "rgba(20,35,50,0.40)",
      "scrim-strong": "rgba(20,35,50,0.56)",
      // Shadow — overcast Arctic diffusion: softest in the system
      "shadow-color": "rgba(20,35,50,0.10)",
      // Terminal — mineral dark palette with cool blue-gray base
      "terminal-background": "#1C2630",
      "terminal-foreground": "#D2D9E0",
      "terminal-muted": "#8C9E94",
      "terminal-cursor": "#8F7335",
      "terminal-selection": "#2A3A4A",
      "terminal-black": "#1C2630",
      "terminal-white": "#D2D9E0",
      "terminal-bright-black": "#52606B",
      // ANSI — tuned for cool dark Arctic background #1C2630
      "terminal-red": "#C87878",
      "terminal-green": "#5DA88A",
      "terminal-yellow": "#B89858",
      "terminal-blue": "#6898C0",
      "terminal-magenta": "#9880B0",
      "terminal-cyan": "#5AA8B8",
      "terminal-bright-red": "#D89898",
      "terminal-bright-green": "#78C0A0",
      "terminal-bright-yellow": "#D0B878",
      "terminal-bright-blue": "#88B8D8",
      "terminal-bright-magenta": "#B0A0C8",
      "terminal-bright-cyan": "#78C0CC",
      "terminal-bright-white": "#E8EEF2",
      // Syntax — frosted cool palette for Arctic terminal
      "syntax-comment": "#6B7888",
      "syntax-punctuation": "#A0B0C0",
      "syntax-number": "#B89858",
      "syntax-string": "#5DA88A",
      "syntax-operator": "#6898C0",
      "syntax-keyword": "#9880B0",
      "syntax-function": "#7090C0",
      "syntax-link": "#5A98B0",
      "syntax-quote": "#808890",
      "syntax-chip": "#68B0B8",
      // Flat aesthetic — no sheen on elevated surfaces; softest shadows in the system
      "recipe-surface-elevated-inset-shadow": "none",
      "recipe-shadow-ambient": "0 8px 24px rgba(20,35,50,0.04)",
      "recipe-shadow-floating": "0 18px 44px rgba(20,35,50,0.05)",
      "recipe-dialog-shadow": "0 24px 56px rgba(20,35,50,0.08)",
      "recipe-toolbar-control-hover-bg": "rgba(20,35,50,0.025)",
      "recipe-toolbar-control-hover-fg": "#36738F",
      "recipe-toolbar-divider": "rgba(170,183,194,0.5)",
      "recipe-toolbar-project-bg":
        "linear-gradient(180deg, rgba(20,35,50,0.02), rgba(20,35,50,0.07)), linear-gradient(135deg, #E5EBF0, #CED7E0)",
      "recipe-toolbar-project-border": "rgba(170,183,194,0.6)",
      "recipe-toolbar-project-shadow": "inset 0 1px 0 rgba(20,35,50,0.07)",
      "recipe-toolbar-project-chip-bg": "rgba(20,35,50,0.025)",
      "recipe-toolbar-project-chip-border": "rgba(170,183,194,0.6)",
      "recipe-toolbar-project-meta-fg": "#4E5F70",
      "recipe-toolbar-stats-bg": "rgba(20,35,50,0.025)",
      "recipe-toolbar-stats-border": "rgba(170,183,194,0.5)",
      "recipe-toolbar-stats-divider": "rgba(170,183,194,0.5)",
      "recipe-toolbar-stats-hover-bg": "rgba(20,35,50,0.025)",
      "recipe-pulse-card-bg": "#FBFCFD",
      "recipe-pulse-card-shadow": "0 8px 24px rgba(20,35,50,0.04)",
      "recipe-pulse-range-bg": "#EDF1F5",
      "recipe-pulse-before-bg": "#D8E0E8",
      "recipe-pulse-empty-bg": "#EDF1F5",
      "recipe-pulse-missed-bg": "rgba(158,85,83,0.12)",
      "recipe-pulse-skeleton-gradient":
        "linear-gradient(90deg, #DDE4EB 25%, #E8EDF2 50%, #DDE4EB 75%)",
      "recipe-settings-dialog-bg": "#F0F4F7",
      "recipe-sidebar-hover-bg": "rgba(20,35,50,0.025)",
      "recipe-sidebar-action-hover-bg": "rgba(20,35,50,0.025)",
      "recipe-sidebar-active-shadow": "0 18px 44px rgba(20,35,50,0.05)",
      "recipe-settings-card-bg": "#FBFCFD",
      "recipe-settings-list-item-bg": "#FBFCFD",
      "recipe-settings-sidebar-bg": "#D1DBE4",
      "recipe-settings-nav-active-bg": "rgba(54,115,143,0.06)",
      "recipe-settings-nav-hover-bg": "rgba(20,35,50,0.025)",
      "recipe-settings-kbd-bg": "#CED7E0",
      "recipe-settings-kbd-border": "rgba(20,35,50,0.07)",
      "recipe-scrollbar-thumb": "#7D8F9F",
      "recipe-scrollbar-thumb-hover": "color-mix(in oklab, #7D8F9F 85%, #1E2B38)",
      "recipe-button-inset-shadow": "none",
      "recipe-state-chip-bg-opacity": "0.10",
      "recipe-state-chip-border-opacity": "0.30",
      "recipe-label-pill-bg-opacity": "0.07",
      "recipe-label-pill-border-opacity": "0.12",
      // Category colors — reduced chroma (0.05–0.09) for dusted Arctic feel
      "category-blue": "oklch(0.55 0.080 242)",
      "category-purple": "oklch(0.55 0.070 318)",
      "category-cyan": "oklch(0.56 0.050 198)",
      "category-green": "oklch(0.55 0.070 155)",
      "category-amber": "oklch(0.58 0.080 65)",
      "category-orange": "oklch(0.56 0.090 38)",
      "category-teal": "oklch(0.55 0.060 178)",
      "category-indigo": "oklch(0.54 0.070 264)",
      "category-rose": "oklch(0.56 0.080 14)",
      "category-pink": "oklch(0.55 0.070 340)",
      "category-violet": "oklch(0.54 0.070 295)",
      "category-slate": "oklch(0.50 0.010 228)",
    }),
  },
];

export const APP_THEME_PREVIEW_KEYS = {
  background: "surface-canvas",
  sidebar: "surface-sidebar",
  accent: "accent-primary",
  success: "status-success",
  warning: "status-warning",
  danger: "status-danger",
  text: "text-primary",
  border: "border-default",
  panel: "surface-panel",
} as const satisfies Record<string, AppThemeTokenKey>;

export const LEGACY_THEME_TOKEN_ALIASES: Record<string, AppThemeTokenKey> = {
  "canopy-bg": "surface-canvas",
  "canopy-sidebar": "surface-sidebar",
  "canopy-border": "border-default",
  "canopy-text": "text-primary",
  "canopy-accent": "accent-primary",
  surface: "surface-panel",
  "surface-highlight": "surface-panel-elevated",
  "grid-bg": "surface-grid",
  "canopy-focus": "focus-ring",
  "status-success": "status-success",
  "status-warning": "status-warning",
  "status-error": "status-danger",
  "status-info": "status-info",
  "state-active": "activity-active",
  "state-idle": "activity-idle",
  "state-working": "activity-working",
  "state-waiting": "activity-waiting",
  "state-approval": "activity-approval",
  "server-running": "status-success",
  "server-stopped": "activity-idle",
  "server-starting": "status-warning",
  "server-error": "status-danger",
  "terminal-selection": "terminal-selection",
};

export function hexToRgbTriplet(hex: string): string {
  const clean = hex.replace("#", "");
  const expanded =
    clean.length === 3
      ? clean
          .split("")
          .map((char) => `${char}${char}`)
          .join("")
      : clean;
  const red = parseInt(expanded.slice(0, 2), 16);
  const green = parseInt(expanded.slice(2, 4), 16);
  const blue = parseInt(expanded.slice(4, 6), 16);
  if (Number.isNaN(red) || Number.isNaN(green) || Number.isNaN(blue)) {
    return "0, 0, 0";
  }
  return `${red}, ${green}, ${blue}`;
}

export const LEGACY_APP_SCHEME_ID_ALIASES: Record<string, string> = {
  canopy: "daintree",
  "canopy-slate": "daintree",
};

export function getAppThemeById(
  id: string,
  customSchemes: AppColorScheme[] = []
): AppColorScheme | undefined {
  const resolvedId = LEGACY_APP_SCHEME_ID_ALIASES[id] ?? id;
  return [...BUILT_IN_APP_SCHEMES, ...customSchemes].find((scheme) => scheme.id === resolvedId);
}

export function getBuiltInAppSchemeForType(type: "dark" | "light"): AppColorScheme {
  return (
    BUILT_IN_APP_SCHEMES.find((scheme) => scheme.type === type) ??
    (type === "light" ? INTERNAL_LIGHT_FALLBACK_SCHEME : BUILT_IN_APP_SCHEMES[0])
  );
}

export function resolveAppTheme(id: string, customSchemes: AppColorScheme[] = []): AppColorScheme {
  return getAppThemeById(id, customSchemes) ?? BUILT_IN_APP_SCHEMES[0];
}

export function getAppThemeCssVariables(scheme: AppColorScheme): Record<string, string> {
  const entries = Object.entries(scheme.tokens).map(([token, value]) => [
    `--theme-${token}`,
    value,
  ]);
  const variables = Object.fromEntries(entries);
  variables["--theme-color-mode"] = scheme.type;
  for (const [legacyToken, themeToken] of Object.entries(LEGACY_THEME_TOKEN_ALIASES)) {
    variables[`--theme-legacy-${legacyToken}`] = scheme.tokens[themeToken];
  }
  return variables;
}

export function normalizeAppThemeTokens(
  maybeTokens: Record<string, unknown>,
  fallback: AppColorSchemeTokens = BUILT_IN_APP_SCHEMES[0].tokens
): AppColorSchemeTokens {
  const normalized = { ...fallback };
  for (const token of Object.keys(fallback) as AppThemeTokenKey[]) {
    const value = maybeTokens[token];
    if (typeof value === "string" && value.trim()) {
      normalized[token] = value;
    }
  }
  for (const [legacyToken, themeToken] of Object.entries(LEGACY_THEME_TOKEN_ALIASES)) {
    const value = maybeTokens[legacyToken];
    if (typeof value === "string" && value.trim()) {
      normalized[themeToken] = value;
    }
  }
  return normalized;
}

function isHexColor(value: string): boolean {
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value);
}

function inferThemeTypeFromHex(hex: string): "dark" | "light" {
  const clean = hex.replace("#", "");
  const expanded =
    clean.length === 3
      ? clean
          .split("")
          .map((char) => `${char}${char}`)
          .join("")
      : clean;
  const red = parseInt(expanded.slice(0, 2), 16);
  const green = parseInt(expanded.slice(2, 4), 16);
  const blue = parseInt(expanded.slice(4, 6), 16);
  const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
  return luminance < 0.5 ? "dark" : "light";
}

export function inferAppThemeTypeFromTokens(
  maybeTokens: Record<string, unknown>
): "dark" | "light" | undefined {
  const surfaceToken = maybeTokens["surface-canvas"] ?? maybeTokens["canopy-bg"];
  if (typeof surfaceToken === "string" && isHexColor(surfaceToken.trim())) {
    return inferThemeTypeFromHex(surfaceToken.trim());
  }
  return undefined;
}

function hexToLinear(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const clean = hex.replace("#", "");
  const expanded =
    clean.length === 3
      ? clean
          .split("")
          .map((char) => `${char}${char}`)
          .join("")
      : clean;
  const red = hexToLinear(parseInt(expanded.slice(0, 2), 16));
  const green = hexToLinear(parseInt(expanded.slice(2, 4), 16));
  const blue = hexToLinear(parseInt(expanded.slice(4, 6), 16));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string): number {
  const l1 = relativeLuminance(foreground);
  const l2 = relativeLuminance(background);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function pickReadableForeground(background: string, candidates: string[]): string {
  const validCandidates = candidates.filter(isHexColor);
  if (!isHexColor(background) || validCandidates.length === 0) {
    return "#000000";
  }
  let bestCandidate = validCandidates[0];
  let bestContrast = contrastRatio(bestCandidate, background);
  for (const candidate of validCandidates.slice(1)) {
    const candidateContrast = contrastRatio(candidate, background);
    if (candidateContrast > bestContrast) {
      bestCandidate = candidate;
      bestContrast = candidateContrast;
    }
  }
  return bestCandidate;
}

const CRITICAL_CONTRAST_PAIRS: Array<{
  foreground: AppThemeTokenKey;
  background: AppThemeTokenKey;
  minimum: number;
}> = [
  { foreground: "text-primary", background: "surface-canvas", minimum: 4.5 },
  { foreground: "text-primary", background: "surface-panel", minimum: 4.5 },
  { foreground: "text-primary", background: "surface-panel-elevated", minimum: 4.5 },
  { foreground: "text-primary", background: "surface-sidebar", minimum: 4.5 },
  { foreground: "accent-foreground", background: "accent-primary", minimum: 4.5 },
];

export function getAppThemeWarnings(scheme: AppColorScheme): AppThemeValidationWarning[] {
  const warnings: AppThemeValidationWarning[] = [];
  for (const pair of CRITICAL_CONTRAST_PAIRS) {
    const fg = scheme.tokens[pair.foreground];
    const bg = scheme.tokens[pair.background];
    if (!isHexColor(fg) || !isHexColor(bg)) {
      continue;
    }
    const ratio = contrastRatio(fg, bg);
    if (ratio < pair.minimum) {
      warnings.push({
        message: `${pair.foreground} on ${pair.background} is ${ratio.toFixed(2)}:1; target is ${pair.minimum.toFixed(1)}:1`,
      });
    }
  }
  return warnings;
}

export function normalizeAppColorScheme(
  maybeScheme: Partial<Omit<AppColorScheme, "tokens">> & { tokens?: Record<string, unknown> },
  fallback: AppColorScheme = BUILT_IN_APP_SCHEMES[0]
): AppColorScheme {
  const explicitType =
    maybeScheme.type === "light"
      ? "light"
      : maybeScheme.type === "dark"
        ? "dark"
        : inferAppThemeTypeFromTokens(
            (maybeScheme.tokens as Record<string, unknown> | undefined) ?? {}
          );
  const resolvedType = explicitType ?? fallback.type;
  const baseScheme =
    fallback.type === resolvedType ? fallback : getBuiltInAppSchemeForType(resolvedType);
  const rawTokens = (maybeScheme.tokens as Record<string, unknown> | undefined) ?? {};
  const normalizedTokens = normalizeAppThemeTokens(rawTokens, baseScheme.tokens);
  if (
    typeof rawTokens["accent-foreground"] !== "string" &&
    typeof normalizedTokens["accent-primary"] === "string"
  ) {
    normalizedTokens["accent-foreground"] = pickReadableForeground(
      normalizedTokens["accent-primary"],
      [normalizedTokens["text-inverse"], normalizedTokens["text-primary"], "#ffffff", "#000000"]
    );
  }
  const result: AppColorScheme = {
    id:
      typeof maybeScheme.id === "string" && maybeScheme.id.trim() ? maybeScheme.id : baseScheme.id,
    name:
      typeof maybeScheme.name === "string" && maybeScheme.name.trim()
        ? maybeScheme.name
        : baseScheme.name,
    type: resolvedType,
    builtin: false,
    tokens: normalizedTokens,
  };
  if (typeof maybeScheme.location === "string") result.location = maybeScheme.location;
  if (typeof maybeScheme.heroImage === "string") result.heroImage = maybeScheme.heroImage;
  if (typeof maybeScheme.heroVideo === "string") result.heroVideo = maybeScheme.heroVideo;
  return result;
}
