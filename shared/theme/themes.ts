import type {
  AppColorScheme,
  AppColorSchemeTokens,
  AppThemeTokenKey,
  AppThemeValidationWarning,
} from "./types.js";

export const DEFAULT_APP_SCHEME_ID = "canopy";

const GITHUB_TOKENS: Pick<
  AppColorSchemeTokens,
  "github-open" | "github-merged" | "github-closed" | "github-draft"
> = {
  "github-open": "#3fb950",
  "github-merged": "#a371f7",
  "github-closed": "#f85149",
  "github-draft": "#8b949e",
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

  const dark = type === "dark";

  return {
    ...GITHUB_TOKENS,
    "category-blue": tokens["category-blue"] ?? "oklch(0.7 0.13 250)",
    "category-purple": tokens["category-purple"] ?? "oklch(0.7 0.13 310)",
    "category-cyan": tokens["category-cyan"] ?? "oklch(0.72 0.11 215)",
    "category-green": tokens["category-green"] ?? "oklch(0.7 0.13 145)",
    "category-amber": tokens["category-amber"] ?? "oklch(0.73 0.14 75)",
    "category-orange": tokens["category-orange"] ?? "oklch(0.7 0.14 45)",
    "category-teal": tokens["category-teal"] ?? "oklch(0.7 0.11 185)",
    "category-indigo": tokens["category-indigo"] ?? "oklch(0.7 0.13 275)",
    "category-rose": tokens["category-rose"] ?? "oklch(0.7 0.14 5)",
    "category-pink": tokens["category-pink"] ?? "oklch(0.72 0.13 340)",
    "category-violet": tokens["category-violet"] ?? "oklch(0.7 0.13 295)",
    "category-slate": tokens["category-slate"] ?? "oklch(0.65 0.04 240)",
    "border-subtle":
      tokens["border-subtle"] ?? (dark ? "rgba(255, 255, 255, 0.08)" : "rgba(0, 0, 0, 0.06)"),
    "border-strong":
      tokens["border-strong"] ?? (dark ? "rgba(255, 255, 255, 0.14)" : "rgba(0, 0, 0, 0.12)"),
    "border-divider":
      tokens["border-divider"] ?? (dark ? "rgba(255, 255, 255, 0.05)" : "rgba(0, 0, 0, 0.05)"),
    "accent-foreground": tokens["accent-foreground"] ?? tokens["text-inverse"],
    "accent-soft": accentSoft,
    "accent-muted": accentMuted,
    "focus-ring":
      tokens["focus-ring"] ?? (dark ? "rgba(255, 255, 255, 0.18)" : "rgba(0, 0, 0, 0.15)"),
    "overlay-subtle":
      tokens["overlay-subtle"] ?? (dark ? "rgba(255, 255, 255, 0.02)" : "rgba(0, 0, 0, 0.02)"),
    "overlay-soft":
      tokens["overlay-soft"] ?? (dark ? "rgba(255, 255, 255, 0.03)" : "rgba(0, 0, 0, 0.03)"),
    "overlay-medium":
      tokens["overlay-medium"] ?? (dark ? "rgba(255, 255, 255, 0.04)" : "rgba(0, 0, 0, 0.04)"),
    "overlay-strong":
      tokens["overlay-strong"] ?? (dark ? "rgba(255, 255, 255, 0.06)" : "rgba(0, 0, 0, 0.05)"),
    "overlay-emphasis":
      tokens["overlay-emphasis"] ?? (dark ? "rgba(255, 255, 255, 0.1)" : "rgba(0, 0, 0, 0.08)"),
    "scrim-soft": tokens["scrim-soft"] ?? (dark ? "rgba(0, 0, 0, 0.2)" : "rgba(0, 0, 0, 0.12)"),
    "scrim-medium":
      tokens["scrim-medium"] ?? (dark ? "rgba(0, 0, 0, 0.45)" : "rgba(0, 0, 0, 0.30)"),
    "scrim-strong":
      tokens["scrim-strong"] ?? (dark ? "rgba(0, 0, 0, 0.62)" : "rgba(0, 0, 0, 0.45)"),
    "terminal-black": tokens["terminal-black"] ?? tokens["surface-canvas"],
    "terminal-white": tokens["terminal-white"] ?? tokens["text-primary"],
    "terminal-bright-black": tokens["terminal-bright-black"] ?? tokens["activity-idle"],
    ...tokens,
  };
}

const INTERNAL_LIGHT_FALLBACK_SCHEME: AppColorScheme = {
  id: "canopy-light-base",
  name: "Canopy Light Base",
  type: "light",
  builtin: true,
  tokens: createCanopyTokens("light", {
    "surface-canvas": "#f6f4ef",
    "surface-sidebar": "#ebe7de",
    "surface-panel": "#fffdf8",
    "surface-panel-elevated": "#fdfbf6",
    "surface-grid": "#f0ede5",
    "text-primary": "#1f2937",
    "text-secondary": "color-mix(in oklab, #1f2937 72%, #f6f4ef)",
    "text-muted": "#5f6b76",
    "text-inverse": "#10161b",
    "border-default": "#d8d2c6",
    "accent-primary": "#3F9366",
    "accent-foreground": "#08140e",
    "status-success": "#2f6f4f",
    "status-warning": "#85551a",
    "status-danger": "#94463e",
    "status-info": "#4b5f74",
    "activity-active": "#22c55e",
    "activity-idle": "#8b95a1",
    "activity-working": "#22c55e",
    "activity-waiting": "#d97706",
    "terminal-selection": "#dbe9de",
    "terminal-red": "#b42318",
    "terminal-green": "#1f8f58",
    "terminal-yellow": "#a16207",
    "terminal-blue": "#2563eb",
    "terminal-magenta": "#8b5cf6",
    "terminal-cyan": "#0f766e",
    "terminal-bright-red": "#dc2626",
    "terminal-bright-green": "#16a34a",
    "terminal-bright-yellow": "#ca8a04",
    "terminal-bright-blue": "#3b82f6",
    "terminal-bright-magenta": "#a855f7",
    "terminal-bright-cyan": "#0891b2",
    "terminal-bright-white": "#0f172a",
    "syntax-comment": "#6b7280",
    "syntax-punctuation": "#334155",
    "syntax-number": "#b45309",
    "syntax-string": "#15803d",
    "syntax-operator": "#0f766e",
    "syntax-keyword": "#7c3aed",
    "syntax-function": "#2563eb",
    "syntax-link": "#0369a1",
    "syntax-quote": "#64748b",
    "syntax-chip": "#0f766e",
    "category-blue": "oklch(0.62 0.14 250)",
    "category-purple": "oklch(0.64 0.14 310)",
    "category-cyan": "oklch(0.65 0.12 215)",
    "category-green": "oklch(0.63 0.13 145)",
    "category-amber": "oklch(0.68 0.14 75)",
    "category-orange": "oklch(0.66 0.15 45)",
    "category-teal": "oklch(0.64 0.11 185)",
    "category-indigo": "oklch(0.61 0.13 275)",
    "category-rose": "oklch(0.63 0.14 5)",
    "category-pink": "oklch(0.66 0.13 340)",
    "category-violet": "oklch(0.63 0.13 295)",
    "category-slate": "oklch(0.58 0.04 240)",
  }),
};

export const BUILT_IN_APP_SCHEMES: AppColorScheme[] = [
  {
    id: "canopy",
    name: "Canopy",
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
    }),
  },
  {
    id: "canopy-slate",
    name: "Canopy Slate",
    type: "dark",
    builtin: true,
    tokens: createCanopyTokens("dark", {
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

export function getBuiltInAppSchemeForType(type: "dark" | "light"): AppColorScheme {
  if (type === "light") {
    return INTERNAL_LIGHT_FALLBACK_SCHEME;
  }
  return BUILT_IN_APP_SCHEMES.find((scheme) => scheme.type === type) ?? BUILT_IN_APP_SCHEMES[0];
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
