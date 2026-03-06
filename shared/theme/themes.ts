import type { AppColorScheme, AppColorSchemeTokens, AppThemeTokenKey } from "./types.js";

export const DEFAULT_APP_SCHEME_ID = "canopy";

const CATEGORY_TOKENS: Pick<
  AppColorSchemeTokens,
  | "category-blue"
  | "category-purple"
  | "category-cyan"
  | "category-green"
  | "category-amber"
  | "category-orange"
  | "category-teal"
  | "category-indigo"
  | "category-rose"
  | "category-pink"
  | "category-violet"
  | "category-slate"
> = {
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
};

const GITHUB_TOKENS: Pick<
  AppColorSchemeTokens,
  "github-open" | "github-merged" | "github-closed" | "github-draft"
> = {
  "github-open": "#3fb950",
  "github-merged": "#a371f7",
  "github-closed": "#f85149",
  "github-draft": "#8b949e",
};

function createCanopyTokens(
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
  const accentSoft =
    tokens["accent-soft"] ??
    (tokens["accent-primary"].startsWith("#")
      ? `rgba(${hexToRgbTriplet(tokens["accent-primary"])}, 0.18)`
      : `color-mix(in oklab, ${tokens["accent-primary"]} 18%, transparent)`);
  const accentMuted =
    tokens["accent-muted"] ??
    (tokens["accent-primary"].startsWith("#")
      ? `rgba(${hexToRgbTriplet(tokens["accent-primary"])}, 0.3)`
      : `color-mix(in oklab, ${tokens["accent-primary"]} 30%, transparent)`);

  return {
    ...CATEGORY_TOKENS,
    ...GITHUB_TOKENS,
    "border-subtle": tokens["border-subtle"] ?? "rgba(255, 255, 255, 0.08)",
    "border-strong": tokens["border-strong"] ?? "rgba(255, 255, 255, 0.14)",
    "border-divider": tokens["border-divider"] ?? "rgba(255, 255, 255, 0.05)",
    "accent-foreground": tokens["accent-foreground"] ?? tokens["text-inverse"],
    "accent-soft": accentSoft,
    "accent-muted": accentMuted,
    "focus-ring": tokens["focus-ring"] ?? "rgba(255, 255, 255, 0.18)",
    "overlay-subtle": tokens["overlay-subtle"] ?? "rgba(255, 255, 255, 0.02)",
    "overlay-soft": tokens["overlay-soft"] ?? "rgba(255, 255, 255, 0.03)",
    "overlay-medium": tokens["overlay-medium"] ?? "rgba(255, 255, 255, 0.04)",
    "overlay-strong": tokens["overlay-strong"] ?? "rgba(255, 255, 255, 0.06)",
    "overlay-emphasis": tokens["overlay-emphasis"] ?? "rgba(255, 255, 255, 0.1)",
    "scrim-soft": tokens["scrim-soft"] ?? "rgba(0, 0, 0, 0.2)",
    "scrim-medium": tokens["scrim-medium"] ?? "rgba(0, 0, 0, 0.45)",
    "scrim-strong": tokens["scrim-strong"] ?? "rgba(0, 0, 0, 0.62)",
    "terminal-black": tokens["terminal-black"] ?? tokens["surface-canvas"],
    "terminal-white": tokens["terminal-white"] ?? tokens["text-primary"],
    "terminal-bright-black": tokens["terminal-bright-black"] ?? tokens["activity-idle"],
    ...tokens,
  };
}

export const BUILT_IN_APP_SCHEMES: AppColorScheme[] = [
  {
    id: "canopy",
    name: "Canopy",
    type: "dark",
    builtin: true,
    tokens: createCanopyTokens({
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
    id: "canopy-slate",
    name: "Canopy Slate",
    type: "dark",
    builtin: true,
    tokens: createCanopyTokens({
      "surface-canvas": "#0f172a",
      "surface-sidebar": "#0a1120",
      "surface-panel": "#131e32",
      "surface-panel-elevated": "#1e2d45",
      "surface-grid": "#080d1a",
      "text-primary": "#e2e8f0",
      "text-secondary": "color-mix(in oklab, #e2e8f0 65%, #0f172a)",
      "text-muted": "#94a3b8",
      "text-inverse": "#0f172a",
      "border-default": "#1e293b",
      "accent-primary": "#3F9366",
      "status-success": "#5F8B6D",
      "status-warning": "#C59A4E",
      "status-danger": "#C8746C",
      "status-info": "#7B8C96",
      "activity-active": "#22c55e",
      "activity-idle": "#334155",
      "activity-working": "#22c55e",
      "activity-waiting": "#fbbf24",
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
      "syntax-comment": "#7685a2",
      "syntax-punctuation": "#cfd8f2",
      "syntax-number": "#f0b778",
      "syntax-string": "#9dcb86",
      "syntax-operator": "#91d4e6",
      "syntax-keyword": "#c0a3f0",
      "syntax-function": "#8db4fb",
      "syntax-link": "#7dc8f0",
      "syntax-quote": "#b1bac5",
      "syntax-chip": "#84d7d2",
      "focus-ring": "rgba(255, 255, 255, 0.18)",
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

export function getAppThemeById(
  id: string,
  customSchemes: AppColorScheme[] = []
): AppColorScheme | undefined {
  return [...BUILT_IN_APP_SCHEMES, ...customSchemes].find((scheme) => scheme.id === id);
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
  const accent = scheme.tokens["accent-primary"];

  variables["--theme-color-mode"] = scheme.type;
  variables["--theme-accent-rgb"] = accent.startsWith("#") ? hexToRgbTriplet(accent) : "0, 0, 0";

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

export function normalizeAppColorScheme(
  maybeScheme: Partial<AppColorScheme>,
  fallback: AppColorScheme = BUILT_IN_APP_SCHEMES[0]
): AppColorScheme {
  return {
    id: typeof maybeScheme.id === "string" && maybeScheme.id.trim() ? maybeScheme.id : fallback.id,
    name:
      typeof maybeScheme.name === "string" && maybeScheme.name.trim()
        ? maybeScheme.name
        : fallback.name,
    type:
      maybeScheme.type === "light" ? "light" : maybeScheme.type === "dark" ? "dark" : fallback.type,
    builtin: false,
    tokens: normalizeAppThemeTokens(
      (maybeScheme.tokens as Record<string, unknown> | undefined) ?? {},
      fallback.tokens
    ),
  };
}
