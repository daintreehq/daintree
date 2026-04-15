import type {
  AppColorScheme,
  AppColorSchemeTokens,
  AppThemeTokenKey,
  AppThemeValidationWarning,
} from "./types.js";
import type { ThemePalette } from "./palette.js";
import { getThemeContrastWarnings } from "./contrast.js";
import { BUILT_IN_THEME_SOURCES, type BuiltInThemeSource } from "./builtInThemeSources.js";

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
  const shadowAmbient =
    tokens["shadow-ambient"] ??
    (dark
      ? "0 1px 3px rgba(0, 0, 0, 0.3), 0 1px 2px rgba(0, 0, 0, 0.2)"
      : "0 2px 8px rgba(0, 0, 0, 0.06)");
  const shadowFloating =
    tokens["shadow-floating"] ??
    (dark
      ? "0 4px 12px rgba(0, 0, 0, 0.5), 0 1px 3px rgba(0, 0, 0, 0.3)"
      : "0 4px 12px rgba(0, 0, 0, 0.12), 0 1px 3px rgba(0, 0, 0, 0.08)");
  const shadowDialog = tokens["shadow-dialog"] ?? shadowFloating;

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
    "overlay-hover": tokens["overlay-hover"] ?? withAlpha(overlayTone, dark ? 0.05 : 0.03),
    "overlay-active": tokens["overlay-active"] ?? withAlpha(overlayTone, dark ? 0.08 : 0.06),
    "overlay-selected": tokens["overlay-selected"] ?? withAlpha(overlayTone, dark ? 0.04 : 0.05),
    "overlay-elevated": tokens["overlay-elevated"] ?? withAlpha(overlayTone, dark ? 0.06 : 0.08),
    "wash-subtle": tokens["wash-subtle"] ?? withAlpha(overlayBase, 0.02),
    "wash-medium": tokens["wash-medium"] ?? withAlpha(overlayBase, 0.04),
    "wash-strong": tokens["wash-strong"] ?? withAlpha(overlayBase, 0.08),
    "scrim-soft": tokens["scrim-soft"] ?? (dark ? "rgba(0, 0, 0, 0.2)" : "rgba(0, 0, 0, 0.3)"),
    "scrim-medium": tokens["scrim-medium"] ?? (dark ? "rgba(0, 0, 0, 0.45)" : "rgba(0, 0, 0, 0.5)"),
    "scrim-strong": tokens["scrim-strong"] ?? (dark ? "rgba(0, 0, 0, 0.62)" : "rgba(0, 0, 0, 0.7)"),
    "shadow-color": tokens["shadow-color"] ?? (dark ? "rgba(0, 0, 0, 0.5)" : "rgba(0, 0, 0, 0.12)"),
    "shadow-ambient": shadowAmbient,
    "shadow-floating": shadowFloating,
    "shadow-dialog": shadowDialog,
    tint: tokens["tint"] ?? tint,
    "material-blur": tokens["material-blur"] ?? "0px",
    "material-saturation": tokens["material-saturation"] ?? "100%",
    "material-opacity": tokens["material-opacity"] ?? "1",
    "radius-scale": tokens["radius-scale"] ?? "1",
    "activity-completed": tokens["activity-completed"] ?? tokens["status-success"],
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
    "state-chip-bg-opacity": tokens["state-chip-bg-opacity"] ?? (dark ? "0.15" : "0.12"),
    "state-chip-border-opacity": tokens["state-chip-border-opacity"] ?? (dark ? "0.40" : "0.35"),
    "label-pill-bg-opacity": tokens["label-pill-bg-opacity"] ?? (dark ? "0.10" : "0.08"),
    "label-pill-border-opacity": tokens["label-pill-border-opacity"] ?? (dark ? "0.20" : "0.15"),
    "scrollbar-width": tokens["scrollbar-width"] ?? "6px",
    "scrollbar-thumb": tokens["scrollbar-thumb"] ?? tokens["activity-idle"],
    "scrollbar-thumb-hover":
      tokens["scrollbar-thumb-hover"] ??
      `color-mix(in oklab, ${tokens["activity-idle"]} 85%, ${tokens["text-primary"]})`,
    "scrollbar-track": tokens["scrollbar-track"] ?? "transparent",
    "panel-state-edge-width": tokens["panel-state-edge-width"] ?? (dark ? "0px" : "2px"),
    "panel-state-edge-inset-block": tokens["panel-state-edge-inset-block"] ?? "4px",
    "panel-state-edge-radius": tokens["panel-state-edge-radius"] ?? "2px",
    "focus-ring-offset": tokens["focus-ring-offset"] ?? "2px",
    "chrome-noise-texture": tokens["chrome-noise-texture"] ?? "none",
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

const INTERNAL_LIGHT_FALLBACK_SOURCE: BuiltInThemeSource = {
  id: "daintree-light-base",
  name: "Daintree Light Base",
  type: "light",
  builtin: true,
  palette: {
    type: "light",
    surfaces: {
      grid: "#CDD3DB",
      sidebar: "#D8DEE6",
      canvas: "#ECF0F5",
      panel: "#F5F8FB",
      elevated: "#FCFDFE",
    },
    text: {
      primary: "#1E252E",
      secondary: "#4A5562",
      muted: "#7D8896",
      inverse: "#FCFDFE",
    },
    border: "#C0C8D1",
    accent: "#1A7258",
    status: {
      success: "#31684B",
      warning: "#9E5D1B",
      danger: "#AD4035",
      info: "#1C5478",
    },
    activity: {
      active: "#2D7A4A",
      idle: "#7D8896",
      working: "#2D7A4A",
      waiting: "#9E7A15",
    },
    terminal: {
      selection: "#2A3A4A",
      red: "#f87171",
      green: "#10b981",
      yellow: "#fbbf24",
      blue: "#38bdf8",
      magenta: "#a855f7",
      cyan: "#22d3ee",
      brightRed: "#fca5a5",
      brightGreen: "#34d399",
      brightYellow: "#fcd34d",
      brightBlue: "#7dd3fc",
      brightMagenta: "#c084fc",
      brightCyan: "#67e8f9",
      brightWhite: "#fafafa",
    },
    syntax: {
      comment: "#707b90",
      punctuation: "#c5d0f5",
      number: "#efb36b",
      string: "#95c879",
      operator: "#8acfe1",
      keyword: "#bc9cef",
      function: "#84adf8",
      link: "#72c1ea",
      quote: "#adb5bb",
      chip: "#7fd4cf",
    },
  },
};

function createThemeFromSource(source: BuiltInThemeSource): AppColorScheme {
  const compiledTokens = compilePaletteToTokens(source.palette);
  const tokens = source.tokens
    ? normalizeAppThemeTokens(source.tokens, compiledTokens)
    : compiledTokens;

  return {
    id: source.id,
    name: source.name,
    type: source.type,
    builtin: source.builtin,
    tokens,
    palette: source.palette,
    ...(source.extensions ? { extensions: source.extensions } : {}),
    ...(source.location ? { location: source.location } : {}),
    ...(source.heroImage ? { heroImage: source.heroImage } : {}),
    ...(source.heroVideo ? { heroVideo: source.heroVideo } : {}),
  };
}

const INTERNAL_LIGHT_FALLBACK_SCHEME = createThemeFromSource(INTERNAL_LIGHT_FALLBACK_SOURCE);

export const BUILT_IN_APP_SCHEMES: AppColorScheme[] =
  BUILT_IN_THEME_SOURCES.map(createThemeFromSource);

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

/**
 * Normalize a user-supplied accent color to canonical lowercase `#rrggbb`.
 * Accepts values with or without a leading `#`, case-insensitive, 3-digit or
 * 6-digit hex. Returns `null` for any other input. Used as the single source of
 * truth for accent override validation on both sides of the IPC boundary.
 */
export function normalizeAccentHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const clean = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  if (!/^[0-9a-f]{3}$|^[0-9a-f]{6}$/i.test(clean)) return null;
  const expanded =
    clean.length === 3
      ? clean
          .split("")
          .map((char) => `${char}${char}`)
          .join("")
      : clean;
  return `#${expanded.toLowerCase()}`;
}

/**
 * Derive the six accent tokens from a single user-picked hex color. Mirrors
 * the formulas in `createCanopyTokens` so the override is indistinguishable
 * from a theme's native accent.
 *
 * - `accent-primary`: the hex itself
 * - `accent-hover`: `color-mix(in oklab, hex 90%, #fff/#000)` (brightened for dark, darkened for light)
 * - `accent-soft`: `rgba(triplet, 0.18 dark / 0.12 light)`
 * - `accent-muted`: `rgba(triplet, 0.30 dark / 0.20 light)`
 * - `accent-rgb`: `R, G, B` triplet for use inside `rgba(var(--theme-accent-rgb), a)`
 * - `accent-foreground`: best WCAG contrast from the scheme's own text-inverse / text-primary + white/black
 */
export function computeAccentOverrideTokens(
  accentHex: string,
  baseScheme: Pick<AppColorScheme, "type" | "tokens">
): Pick<
  AppColorSchemeTokens,
  | "accent-primary"
  | "accent-hover"
  | "accent-foreground"
  | "accent-soft"
  | "accent-muted"
  | "accent-rgb"
> {
  const normalized = normalizeAccentHex(accentHex);
  if (!normalized) {
    throw new Error(`computeAccentOverrideTokens: invalid accent hex "${accentHex}"`);
  }
  const dark = baseScheme.type === "dark";
  return {
    "accent-primary": normalized,
    "accent-hover": `color-mix(in oklab, ${normalized} 90%, ${dark ? "#ffffff" : "#000000"})`,
    "accent-soft": withAlpha(normalized, dark ? 0.18 : 0.12),
    "accent-muted": withAlpha(normalized, dark ? 0.3 : 0.2),
    "accent-rgb": hexToRgbTriplet(normalized),
    "accent-foreground": pickReadableForeground(normalized, [
      baseScheme.tokens["text-inverse"],
      baseScheme.tokens["text-primary"],
      "#ffffff",
      "#000000",
    ]),
  };
}

/**
 * Return a new scheme with accent tokens patched from the override hex, or the
 * same scheme reference when no (valid) override is active. Safe to pass an
 * invalid hex — the input is silently returned unchanged, matching the
 * no-override branch so callers can call unconditionally.
 */
export function applyAccentOverrideToScheme(
  scheme: AppColorScheme,
  accentHex: string | null | undefined
): AppColorScheme {
  const normalized = normalizeAccentHex(accentHex);
  if (!normalized) return scheme;
  return {
    ...scheme,
    tokens: {
      ...scheme.tokens,
      ...computeAccentOverrideTokens(normalized, scheme),
    },
  };
}

export function getAppThemeById(
  id: string,
  customSchemes: AppColorScheme[] = []
): AppColorScheme | undefined {
  return [...BUILT_IN_APP_SCHEMES, ...customSchemes].find((scheme) => scheme.id === id);
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
  if (scheme.extensions) {
    for (const [extensionName, extensionValue] of Object.entries(scheme.extensions)) {
      if (typeof extensionValue === "string" && extensionValue.trim()) {
        variables[`--${extensionName}`] = extensionValue;
      }
    }
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
  const surfaceToken = maybeTokens["surface-canvas"];
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

export function getAppThemeWarnings(scheme: AppColorScheme): AppThemeValidationWarning[] {
  return getThemeContrastWarnings(scheme);
}

function compilePaletteToTokens(palette: ThemePalette): AppColorSchemeTokens {
  const strategy = palette.strategy;
  const shadowStyle = strategy?.shadowStyle ?? (palette.type === "dark" ? "soft" : "crisp");
  const shadowProfiles =
    shadowStyle === "none"
      ? {
          ambient: "none",
          floating: "none",
          dialog: "0 0 0 1px var(--theme-border-subtle)",
        }
      : shadowStyle === "crisp"
        ? {
            ambient: "0 1px 2px rgba(0, 0, 0, 0.2)",
            floating: "0 4px 8px rgba(0, 0, 0, 0.3)",
            dialog: "0 8px 16px rgba(0, 0, 0, 0.3)",
          }
        : shadowStyle === "atmospheric"
          ? {
              ambient: "0 4px 16px rgba(0, 0, 0, 0.15)",
              floating: "0 14px 40px rgba(0, 0, 0, 0.25)",
              dialog: "0 20px 56px rgba(0, 0, 0, 0.3)",
            }
          : {
              ambient: "0 2px 8px rgba(0, 0, 0, 0.06)",
              floating: "0 4px 12px rgba(0, 0, 0, 0.12)",
              dialog: "0 12px 32px rgba(0, 0, 0, 0.15)",
            };

  return createCanopyTokens(palette.type, {
    "surface-grid": palette.surfaces.grid,
    "surface-sidebar": palette.surfaces.sidebar,
    "surface-canvas": palette.surfaces.canvas,
    "surface-panel": palette.surfaces.panel,
    "surface-panel-elevated": palette.surfaces.elevated,
    "text-primary": palette.text.primary,
    "text-secondary": palette.text.secondary,
    "text-muted": palette.text.muted,
    "text-inverse": palette.text.inverse,
    "border-default": palette.border,
    "accent-primary": palette.accent,
    ...(palette.accentSecondary ? { "accent-secondary": palette.accentSecondary } : {}),
    "status-success": palette.status.success,
    "status-warning": palette.status.warning,
    "status-danger": palette.status.danger,
    "status-info": palette.status.info,
    "activity-active": palette.activity.active,
    "activity-idle": palette.activity.idle,
    "activity-working": palette.activity.working,
    "activity-waiting": palette.activity.waiting,
    ...(palette.overlayTint ? { "overlay-base": palette.overlayTint } : {}),
    "terminal-background": palette.terminal?.background ?? palette.surfaces.canvas,
    "terminal-foreground": palette.terminal?.foreground ?? palette.text.primary,
    "terminal-muted": palette.terminal?.muted ?? palette.text.muted,
    "terminal-cursor": palette.terminal?.cursor ?? palette.accent,
    "terminal-selection": palette.terminal?.selection ?? palette.accent,
    "terminal-red": palette.terminal?.red ?? palette.status.danger,
    "terminal-green": palette.terminal?.green ?? palette.status.success,
    "terminal-yellow": palette.terminal?.yellow ?? palette.status.warning,
    "terminal-blue": palette.terminal?.blue ?? palette.status.info,
    "terminal-magenta": palette.terminal?.magenta ?? palette.accent,
    "terminal-cyan": palette.terminal?.cyan ?? palette.activity.active,
    "terminal-bright-red": palette.terminal?.brightRed ?? palette.status.danger,
    "terminal-bright-green": palette.terminal?.brightGreen ?? palette.status.success,
    "terminal-bright-yellow": palette.terminal?.brightYellow ?? palette.status.warning,
    "terminal-bright-blue": palette.terminal?.brightBlue ?? palette.status.info,
    "terminal-bright-magenta": palette.terminal?.brightMagenta ?? palette.accent,
    "terminal-bright-cyan": palette.terminal?.brightCyan ?? palette.activity.active,
    "terminal-bright-white": palette.terminal?.brightWhite ?? palette.text.primary,
    "syntax-comment": palette.syntax.comment,
    "syntax-punctuation": palette.syntax.punctuation,
    "syntax-number": palette.syntax.number,
    "syntax-string": palette.syntax.string,
    "syntax-operator": palette.syntax.operator,
    "syntax-keyword": palette.syntax.keyword,
    "syntax-function": palette.syntax.function,
    "syntax-link": palette.syntax.link,
    "syntax-quote": palette.syntax.quote,
    "syntax-chip": palette.syntax.chip,
    "shadow-ambient": shadowProfiles.ambient,
    "shadow-floating": shadowProfiles.floating,
    "shadow-dialog": shadowProfiles.dialog,
    "material-blur": `${strategy?.materialBlur ?? 0}px`,
    "material-saturation": `${strategy?.materialSaturation ?? 100}%`,
    "material-opacity": strategy?.materialBlur && strategy.materialBlur > 0 ? "0.9" : "1",
    "radius-scale": String(strategy?.radiusScale ?? 1),
    "chrome-noise-texture":
      strategy?.noiseOpacity && strategy.noiseOpacity > 0
        ? `radial-gradient(circle at 20% 20%, rgb(255 255 255 / ${strategy.noiseOpacity}), transparent 55%)`
        : "none",
    "panel-state-edge-width":
      (strategy?.panelStateEdge ?? palette.type === "light") ? "2px" : "0px",
  });
}

export function normalizeAppColorScheme(
  maybeScheme: Partial<Omit<AppColorScheme, "tokens">> & { tokens?: Record<string, unknown> },
  fallback: AppColorScheme = BUILT_IN_APP_SCHEMES[0]
): AppColorScheme {
  const palette = maybeScheme.palette;
  const explicitType =
    maybeScheme.type === "light"
      ? "light"
      : maybeScheme.type === "dark"
        ? "dark"
        : palette?.type === "light"
          ? "light"
          : palette?.type === "dark"
            ? "dark"
            : inferAppThemeTypeFromTokens(
                (maybeScheme.tokens as Record<string, unknown> | undefined) ?? {}
              );
  const resolvedType = explicitType ?? fallback.type;
  const baseScheme =
    fallback.type === resolvedType ? fallback : getBuiltInAppSchemeForType(resolvedType);
  const rawTokens = (palette ? compilePaletteToTokens(palette) : maybeScheme.tokens) as
    | Record<string, unknown>
    | undefined;
  const tokenOverrides = (maybeScheme.tokens as Record<string, unknown> | undefined) ?? {};
  const normalizedTokens = normalizeAppThemeTokens(rawTokens ?? {}, baseScheme.tokens);
  Object.assign(normalizedTokens, normalizeAppThemeTokens(tokenOverrides, normalizedTokens));
  if (
    typeof tokenOverrides["accent-foreground"] !== "string" &&
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
    ...(palette ? { palette } : {}),
    ...(maybeScheme.extensions ? { extensions: maybeScheme.extensions } : {}),
  };
  if (typeof maybeScheme.location === "string") result.location = maybeScheme.location;
  if (typeof maybeScheme.heroImage === "string") result.heroImage = maybeScheme.heroImage;
  if (typeof maybeScheme.heroVideo === "string") result.heroVideo = maybeScheme.heroVideo;
  return result;
}
