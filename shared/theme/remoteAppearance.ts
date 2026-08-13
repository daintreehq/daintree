import { formatHex8 } from "culori";
import {
  REMOTE_APPEARANCE_VERSION,
  RemoteAppearanceSnapshotSchema,
  type RemoteAppearanceColor,
  type RemoteAppearanceSnapshot,
} from "../types/remote/appearance.js";
import type { AppColorScheme, AppThemeTokenKey } from "./types.js";
import { compositedContrastRatio } from "./contrast.js";
import {
  applyAccentOverrideToScheme,
  BUILT_IN_APP_SCHEMES,
  getBuiltInAppSchemeForType,
} from "./themes.js";

type AppearanceSource = Pick<AppColorScheme, "id" | "name" | "type"> & {
  tokens: Partial<Record<AppThemeTokenKey, unknown>>;
};

export interface ProjectRemoteAppearanceOptions {
  revision: number;
  accentColorOverride?: string | null;
}

const DAINTREE_SCHEME = BUILT_IN_APP_SCHEMES.find((scheme) => scheme.id === "daintree")!;

function normalizeColor(value: unknown): RemoteAppearanceColor | null {
  if (typeof value !== "string" || value.length > 256) return null;
  const normalized = formatHex8(value.trim());
  return normalized && /^#[0-9a-f]{8}$/.test(normalized)
    ? (normalized as RemoteAppearanceColor)
    : null;
}

function normalizeIdentity(value: unknown, fallback: string, opaque: boolean): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().normalize("NFC").slice(0, 128);
  if (!normalized || /[\p{C}]/u.test(normalized)) return fallback;
  if (opaque && !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized)) return fallback;
  return normalized;
}

function normalizeRadiusScale(value: unknown, fallback: unknown): number {
  for (const candidate of [value, fallback, DAINTREE_SCHEME.tokens["radius-scale"], 1]) {
    const parsed = typeof candidate === "number" ? candidate : Number(candidate);
    if (Number.isFinite(parsed) && parsed >= 0.5 && parsed <= 2) return parsed;
  }
  return 1;
}

export function projectRemoteAppearance(
  source: AppearanceSource,
  options: ProjectRemoteAppearanceOptions
): RemoteAppearanceSnapshot {
  const polarityFallback = getBuiltInAppSchemeForType(source.type);
  const effectiveSource = applyAccentOverrideToScheme(
    source as AppColorScheme,
    options.accentColorOverride
  );

  const colorCandidates = (...keys: AppThemeTokenKey[]): RemoteAppearanceColor[] => {
    const candidates: RemoteAppearanceColor[] = [];
    for (const key of keys) {
      for (const tokens of [
        effectiveSource.tokens,
        polarityFallback.tokens,
        DAINTREE_SCHEME.tokens,
      ]) {
        const normalized = normalizeColor(tokens[key]);
        if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
      }
    }
    return candidates;
  };

  const color = (...keys: AppThemeTokenKey[]): RemoteAppearanceColor => {
    const candidate = colorCandidates(...keys)[0];
    if (candidate) return candidate;
    throw new Error(`No safe remote appearance fallback for ${keys.join(", ")}`);
  };

  const opaqueColor = (...keys: AppThemeTokenKey[]): RemoteAppearanceColor =>
    colorCandidates(...keys).find((candidate) => candidate.endsWith("ff")) ??
    (source.type === "light" ? "#ffffffff" : "#000000ff");

  const readableColor = (
    background: RemoteAppearanceColor,
    minimumContrast: number,
    ...keys: AppThemeTokenKey[]
  ): RemoteAppearanceColor => {
    const candidates = [
      ...colorCandidates(...keys),
      "#000000ff" as RemoteAppearanceColor,
      "#ffffffff" as RemoteAppearanceColor,
    ];
    return (
      candidates.find(
        (candidate) => compositedContrastRatio(candidate, background) >= minimumContrast
      ) ??
      candidates.reduce((best, candidate) =>
        compositedContrastRatio(candidate, background) > compositedContrastRatio(best, background)
          ? candidate
          : best
      )
    );
  };

  const canvas = opaqueColor("surface-canvas");
  const terminalBackground = opaqueColor("terminal-background", "surface-canvas");

  const lowEmphasis = (foreground: AppThemeTokenKey, surface: AppThemeTokenKey) => ({
    foreground: color(foreground),
    surface: color(surface, "surface-hover", "surface-panel"),
  });

  return RemoteAppearanceSnapshotSchema.parse({
    version: REMOTE_APPEARANCE_VERSION,
    revision: options.revision,
    themeId: normalizeIdentity(source.id, DAINTREE_SCHEME.id, true),
    displayName: normalizeIdentity(source.name, DAINTREE_SCHEME.name, false),
    polarity: source.type,
    surfaces: {
      grid: color("surface-grid"),
      chrome: color("surface-sidebar"),
      canvas,
      toolbar: color("surface-toolbar", "surface-sidebar"),
      panel: color("surface-panel"),
      elevatedPanel: color("surface-panel-elevated"),
      input: color("surface-input", "surface-panel-elevated"),
      inset: color("surface-inset", "surface-panel"),
      hover: color("surface-hover", "surface-panel-elevated"),
      active: color("surface-active", "surface-panel-elevated"),
    },
    text: {
      primary: readableColor(canvas, 4.5, "text-primary"),
      secondary: readableColor(canvas, 3, "text-secondary"),
      muted: readableColor(canvas, 3, "text-muted"),
      placeholder: readableColor(canvas, 3, "text-placeholder", "text-muted"),
      inverse: color("text-inverse"),
      link: readableColor(canvas, 3, "text-link", "accent-primary"),
    },
    borders: {
      default: color("border-default"),
      subtle: color("border-subtle", "border-default"),
      strong: color("border-strong", "border-default"),
      divider: color("border-divider", "border-default"),
      interactive: color("border-interactive", "border-default"),
    },
    accent: {
      primary: color("accent-primary"),
      foreground: color("accent-foreground", "text-inverse"),
      soft: color("accent-soft", "accent-primary"),
      muted: color("accent-muted", "accent-primary"),
      focusRing: color("focus-ring", "accent-primary"),
    },
    status: {
      success: lowEmphasis("status-success", "status-success-surface"),
      warning: lowEmphasis("status-warning", "status-warning-surface"),
      danger: lowEmphasis("status-danger", "status-danger-surface"),
      info: lowEmphasis("status-info", "status-info-surface"),
    },
    activity: {
      active: lowEmphasis("activity-active", "status-success-surface"),
      idle: lowEmphasis("activity-idle", "surface-hover"),
      working: lowEmphasis("activity-working", "status-success-surface"),
      waiting: lowEmphasis("activity-waiting", "status-warning-surface"),
      completed: lowEmphasis("activity-completed", "status-success-surface"),
    },
    terminal: {
      background: terminalBackground,
      foreground: readableColor(terminalBackground, 4.5, "terminal-foreground", "text-primary"),
      muted: color("terminal-muted", "text-muted"),
      cursor: readableColor(terminalBackground, 3, "terminal-cursor", "accent-primary"),
      cursorAccent: color("terminal-cursor-accent", "terminal-background"),
      selection: readableColor(terminalBackground, 1.15, "terminal-selection", "accent-soft"),
      black: color("terminal-black", "surface-canvas"),
      red: readableColor(terminalBackground, 4, "terminal-red", "status-danger"),
      green: readableColor(terminalBackground, 4, "terminal-green", "status-success"),
      yellow: readableColor(terminalBackground, 4, "terminal-yellow", "status-warning"),
      blue: readableColor(terminalBackground, 4, "terminal-blue", "status-info"),
      magenta: readableColor(terminalBackground, 4, "terminal-magenta", "accent-primary"),
      cyan: readableColor(terminalBackground, 4, "terminal-cyan", "status-info"),
      white: readableColor(terminalBackground, 4, "terminal-white", "text-primary"),
      brightBlack: color("terminal-bright-black", "activity-idle"),
      brightRed: readableColor(terminalBackground, 4, "terminal-bright-red", "terminal-red"),
      brightGreen: readableColor(terminalBackground, 4, "terminal-bright-green", "terminal-green"),
      brightYellow: readableColor(
        terminalBackground,
        4,
        "terminal-bright-yellow",
        "terminal-yellow"
      ),
      brightBlue: readableColor(terminalBackground, 4, "terminal-bright-blue", "terminal-blue"),
      brightMagenta: readableColor(
        terminalBackground,
        4,
        "terminal-bright-magenta",
        "terminal-magenta"
      ),
      brightCyan: readableColor(terminalBackground, 4, "terminal-bright-cyan", "terminal-cyan"),
      brightWhite: readableColor(terminalBackground, 4, "terminal-bright-white", "terminal-white"),
    },
    strategy: {
      radiusScale: normalizeRadiusScale(
        effectiveSource.tokens["radius-scale"],
        polarityFallback.tokens["radius-scale"]
      ),
    },
  });
}
