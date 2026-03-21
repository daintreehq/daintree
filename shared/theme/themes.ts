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
  const accentSoft =
    tokens["accent-soft"] ?? withAlpha(tokens["accent-primary"], dark ? 0.18 : 0.12);
  const accentMuted =
    tokens["accent-muted"] ?? withAlpha(tokens["accent-primary"], dark ? 0.3 : 0.2);
  const accentRgb = tokens["accent-primary"].startsWith("#")
    ? hexToRgbTriplet(tokens["accent-primary"])
    : "0, 0, 0";
  const tint = dark ? "#ffffff" : "#000000";

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
    "overlay-subtle": tokens["overlay-subtle"] ?? withAlpha(overlayTone, dark ? 0.02 : 0.02),
    "overlay-soft": tokens["overlay-soft"] ?? withAlpha(overlayTone, dark ? 0.03 : 0.03),
    "overlay-medium": tokens["overlay-medium"] ?? withAlpha(overlayTone, dark ? 0.04 : 0.05),
    "overlay-strong": tokens["overlay-strong"] ?? withAlpha(overlayTone, dark ? 0.06 : 0.08),
    "overlay-emphasis": tokens["overlay-emphasis"] ?? withAlpha(overlayTone, dark ? 0.1 : 0.12),
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
    "surface-input":
      tokens["surface-input"] ??
      (dark ? tokens["surface-panel-elevated"] : tokens["surface-panel"]),
    "surface-inset": tokens["surface-inset"] ?? withAlpha(overlayTone, dark ? 0.03 : 0.04),
    "surface-hover": tokens["surface-hover"] ?? withAlpha(overlayTone, dark ? 0.05 : 0.03),
    "surface-active": tokens["surface-active"] ?? withAlpha(overlayTone, dark ? 0.08 : 0.06),
    "text-link": tokens["text-link"] ?? tokens["accent-primary"],
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
    tokens: createCanopyTokens("dark", {
      "surface-canvas": "#19191a",
      "surface-sidebar": "#131312",
      "surface-panel": "#1d1d1e",
      "surface-panel-elevated": "#2b2b2c",
      "surface-grid": "#0e0e0d",
      "text-primary": "#e4e4e7",
      "text-secondary": "color-mix(in oklab, #e4e4e7 65%, #19191a)",
      "text-muted": "#a1a1aa",
      "text-inverse": "#19191a",
      "border-default": "#282828",
      "accent-primary": "#3F9366",
      "status-success": "#5F8B6D",
      "status-warning": "#C59A4E",
      "status-danger": "#C8746C",
      "status-info": "#7B8C96",
      "activity-active": "#22c55e",
      "activity-idle": "#52525b",
      "activity-working": "#22c55e",
      "activity-waiting": "#fbbf24",
      "search-highlight-background": "rgba(63, 147, 102, 0.2)",
      "search-highlight-text": "#5F8B6D",
      "terminal-background": "#19191a",
      "terminal-foreground": "#e4e4e7",
      "terminal-muted": "#a1a1aa",
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
      "focus-ring": "rgba(255, 255, 255, 0.18)",
    }),
  },
  {
    id: "bondi",
    name: "Bondi Beach",
    type: "light",
    builtin: true,
    tokens: createCanopyTokens("light", {
      "surface-grid": "#CDD3DB",
      "surface-sidebar": "#D8DEE6",
      "surface-canvas": "#ECF0F5",
      "surface-panel": "#F5F8FB",
      "surface-panel-elevated": "#FCFDFE",
      "surface-input": "#F5F8FB",
      "surface-inset": "#E6EBF0",
      "surface-hover": "rgba(0, 0, 0, 0.05)",
      "surface-active": "rgba(0, 0, 0, 0.10)",
      "text-primary": "#1E252E",
      "text-secondary": "#4A5562",
      "text-muted": "#7D8896",
      "text-inverse": "#FCFDFE",
      "text-link": "#1A7258",
      "border-default": "#C0C8D1",
      "border-subtle": "rgba(0, 0, 0, 0.05)",
      "border-strong": "rgba(0, 0, 0, 0.14)",
      "border-divider": "rgba(0, 0, 0, 0.04)",
      "border-interactive": "rgba(0, 0, 0, 0.10)",
      "accent-primary": "#1A7258",
      "accent-foreground": "#FCFDFE",
      "overlay-subtle": "rgba(0, 0, 0, 0.02)",
      "overlay-soft": "rgba(0, 0, 0, 0.03)",
      "overlay-medium": "rgba(0, 0, 0, 0.06)",
      "overlay-strong": "rgba(0, 0, 0, 0.10)",
      "overlay-emphasis": "rgba(0, 0, 0, 0.14)",
      "status-success": "#31684B",
      "status-warning": "#9E5D1B",
      "status-danger": "#AD4035",
      "status-info": "#1C5478",
      "activity-active": "#2D7A4A",
      "activity-idle": "#7D8896",
      "activity-working": "#2D7A4A",
      "activity-waiting": "#9E7A15",
      "activity-approval": "#C56210",
      "github-open": "#1A7F37",
      "github-merged": "#8250DF",
      "github-closed": "#CF222E",
      "github-draft": "#8B949E",
      "search-highlight-background": "rgba(43, 108, 168, 0.12)",
      "search-highlight-text": "#2B6CA8",
      "search-selected-result-border": "#2B6CA8",
      "search-selected-result-icon": "#2B6CA8",
      "search-match-badge-background": "rgba(43, 108, 168, 0.1)",
      "search-match-badge-text": "#2B6CA8",
      "terminal-background": "#1E252E",
      "terminal-foreground": "#D8DDE3",
      "terminal-muted": "#8A929C",
      "terminal-selection": "#2A3A4A",
      "terminal-black": "#1E252E",
      "terminal-white": "#D8DDE3",
      "terminal-red": "#f87171",
      "terminal-green": "#10b981",
      "terminal-yellow": "#fbbf24",
      "terminal-blue": "#38bdf8",
      "terminal-magenta": "#a855f7",
      "terminal-cyan": "#22d3ee",
      "terminal-bright-black": "#52525b",
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
      "focus-ring": "rgba(0, 0, 0, 0.18)",
      "scrim-soft": "rgba(0, 0, 0, 0.3)",
      "scrim-medium": "rgba(0, 0, 0, 0.5)",
      "scrim-strong": "rgba(0, 0, 0, 0.7)",
      "shadow-color": "rgba(0, 0, 0, 0.12)",
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
      "recipe-state-chip-bg-opacity": "0.12",
      "recipe-state-chip-border-opacity": "0.35",
      "recipe-label-pill-bg-opacity": "0.08",
      "recipe-label-pill-border-opacity": "0.15",
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
  return {
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
}
