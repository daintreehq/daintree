import type { AppColorScheme, AppThemeValidationWarning, AppThemeTokenKey } from "./types.js";

const DISPLAY_SURFACES: AppThemeTokenKey[] = [
  "surface-grid",
  "surface-sidebar",
  "surface-canvas",
  "surface-panel",
  "surface-panel-elevated",
];

const CONTRAST_PAIRS: Array<{
  foreground: AppThemeTokenKey;
  background: AppThemeTokenKey;
  minimum: number;
}> = [
  { foreground: "text-primary", background: "surface-grid", minimum: 4.5 },
  { foreground: "text-primary", background: "surface-sidebar", minimum: 4.5 },
  { foreground: "text-primary", background: "surface-canvas", minimum: 4.5 },
  { foreground: "text-primary", background: "surface-panel", minimum: 4.5 },
  { foreground: "text-primary", background: "surface-panel-elevated", minimum: 4.5 },
  { foreground: "text-secondary", background: "surface-grid", minimum: 3.0 },
  { foreground: "text-secondary", background: "surface-sidebar", minimum: 3.0 },
  { foreground: "text-secondary", background: "surface-canvas", minimum: 3.0 },
  { foreground: "text-secondary", background: "surface-panel", minimum: 3.0 },
  { foreground: "text-secondary", background: "surface-panel-elevated", minimum: 3.0 },
  { foreground: "status-success", background: "surface-panel", minimum: 3.0 },
  { foreground: "status-success", background: "surface-grid", minimum: 3.0 },
  { foreground: "status-success", background: "surface-sidebar", minimum: 3.0 },
  { foreground: "status-success", background: "surface-canvas", minimum: 3.0 },
  { foreground: "status-success", background: "surface-panel-elevated", minimum: 3.0 },
  { foreground: "status-warning", background: "surface-panel", minimum: 3.0 },
  { foreground: "status-warning", background: "surface-grid", minimum: 3.0 },
  { foreground: "status-warning", background: "surface-sidebar", minimum: 3.0 },
  { foreground: "status-warning", background: "surface-canvas", minimum: 3.0 },
  { foreground: "status-warning", background: "surface-panel-elevated", minimum: 3.0 },
  { foreground: "status-danger", background: "surface-panel", minimum: 3.0 },
  { foreground: "status-danger", background: "surface-grid", minimum: 3.0 },
  { foreground: "status-danger", background: "surface-sidebar", minimum: 3.0 },
  { foreground: "status-danger", background: "surface-canvas", minimum: 3.0 },
  { foreground: "status-danger", background: "surface-panel-elevated", minimum: 3.0 },
  { foreground: "status-info", background: "surface-panel", minimum: 3.0 },
  { foreground: "status-info", background: "surface-grid", minimum: 3.0 },
  { foreground: "status-info", background: "surface-sidebar", minimum: 3.0 },
  { foreground: "status-info", background: "surface-canvas", minimum: 3.0 },
  { foreground: "status-info", background: "surface-panel-elevated", minimum: 3.0 },
  { foreground: "accent-foreground", background: "accent-primary", minimum: 4.5 },
  { foreground: "search-highlight-text", background: "search-highlight-background", minimum: 3.0 },
  { foreground: "terminal-foreground", background: "terminal-background", minimum: 4.5 },
  { foreground: "terminal-red", background: "terminal-background", minimum: 3.0 },
  { foreground: "terminal-green", background: "terminal-background", minimum: 3.0 },
];

function isHexColor(value: string): boolean {
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value.trim());
}

export function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.trim().replace("#", "");
  if (clean.length === 3 || clean.length === 4) {
    const expanded = clean
      .slice(0, 3)
      .split("")
      .map((c) => `${c}${c}`)
      .join("");
    return [
      parseInt(expanded.slice(0, 2), 16),
      parseInt(expanded.slice(2, 4), 16),
      parseInt(expanded.slice(4, 6), 16),
    ];
  }
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

function parseRgba(value: string): { hex: string; opacity: number } | null {
  const trimmed = value.trim();
  const match = trimmed.match(/^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/);
  if (!match) return null;
  return {
    hex: `#${parseInt(match[1]!, 10).toString(16).padStart(2, "0")}${parseInt(match[2]!, 10).toString(16).padStart(2, "0")}${parseInt(match[3]!, 10).toString(16).padStart(2, "0")}`,
    opacity: parseFloat(match[4]!),
  };
}

function blendOverBackground(fgHex: string, bgHex: string, opacity: number): string {
  const [fr, fg, fb] = hexToRgb(fgHex);
  const [br, bg, bb] = hexToRgb(bgHex);
  const r = Math.round(fr * opacity + br * (1 - opacity));
  const g = Math.round(fg * opacity + bg * (1 - opacity));
  const b = Math.round(fb * opacity + bb * (1 - opacity));
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

const FRESHNESS_OPACITY_TIERS: Array<{ opacity: number; tier: string }> = [
  { opacity: 0.75, tier: "aging" },
];

export function hexToLinear(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const clean = hex.trim().replace("#", "");
  let rgb: string;
  if (clean.length === 3 || clean.length === 4) {
    // 3-digit (#rgb) or 4-digit (#rgba): expand RGB nibbles, drop alpha for static analysis.
    rgb = clean
      .slice(0, 3)
      .split("")
      .map((char) => `${char}${char}`)
      .join("");
  } else {
    // 6-digit (#rrggbb) or 8-digit (#rrggbbaa): take first 6 chars, drop alpha for static analysis.
    rgb = clean.slice(0, 6);
  }
  const red = hexToLinear(parseInt(rgb.slice(0, 2), 16));
  const green = hexToLinear(parseInt(rgb.slice(2, 4), 16));
  const blue = hexToLinear(parseInt(rgb.slice(4, 6), 16));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function contrastRatio(foreground: string, background: string): number {
  const l1 = relativeLuminance(foreground);
  const l2 = relativeLuminance(background);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

export { isHexColor };

export function getThemeContrastWarnings(scheme: AppColorScheme): AppThemeValidationWarning[] {
  const warnings: AppThemeValidationWarning[] = [];

  for (const pair of CONTRAST_PAIRS) {
    const fg = scheme.tokens[pair.foreground];
    const bg = scheme.tokens[pair.background];
    if (!isHexColor(fg)) {
      warnings.push({
        message: `Cannot evaluate contrast for ${pair.foreground} on ${pair.background}: non-hex foreground "${fg}"`,
      });
      continue;
    }
    if (isHexColor(bg)) {
      const ratio = contrastRatio(fg, bg);
      if (ratio < pair.minimum) {
        warnings.push({
          message: `${pair.foreground} on ${pair.background} is ${ratio.toFixed(2)}:1; target is ${pair.minimum.toFixed(1)}:1`,
        });
      }
    } else {
      const rgba = parseRgba(bg);
      if (rgba) {
        if (rgba.opacity >= 1) {
          const ratio = contrastRatio(fg, rgba.hex);
          if (ratio < pair.minimum) {
            warnings.push({
              message: `${pair.foreground} on ${pair.background} is ${ratio.toFixed(2)}:1; target is ${pair.minimum.toFixed(1)}:1`,
            });
          }
        } else {
          let anySurfaceEvaluable = false;
          for (const surfaceKey of DISPLAY_SURFACES) {
            const surface = scheme.tokens[surfaceKey];
            if (!isHexColor(surface)) continue;
            anySurfaceEvaluable = true;
            const compositedBg = blendOverBackground(rgba.hex, surface, rgba.opacity);
            const ratio = contrastRatio(fg, compositedBg);
            if (ratio < pair.minimum) {
              warnings.push({
                message: `${pair.foreground} on ${pair.background} (over ${surfaceKey}) is ${ratio.toFixed(2)}:1; target is ${pair.minimum.toFixed(1)}:1`,
              });
            }
          }
          if (!anySurfaceEvaluable) {
            warnings.push({
              message: `Cannot evaluate contrast for ${pair.foreground} on ${pair.background}: ${pair.background}="${bg}" requires compositing over a surface but no evaluable surface found`,
            });
          }
        }
      } else {
        warnings.push({
          message: `Cannot evaluate contrast for ${pair.foreground} on ${pair.background}: non-hex background "${bg}"`,
        });
      }
    }
  }

  const textPrimaryPairs = CONTRAST_PAIRS.filter((p) => p.foreground === "text-primary");
  for (const pair of textPrimaryPairs) {
    const fg = scheme.tokens[pair.foreground];
    const bg = scheme.tokens[pair.background];
    if (!isHexColor(fg) || !isHexColor(bg)) continue;
    for (const { opacity, tier } of FRESHNESS_OPACITY_TIERS) {
      const blended = blendOverBackground(fg, bg, opacity);
      const ratio = contrastRatio(blended, bg);
      if (ratio < pair.minimum) {
        warnings.push({
          message: `text-primary on ${pair.background} at ${Math.round(opacity * 100)}% opacity (${tier}) is ${ratio.toFixed(2)}:1; target is ${pair.minimum.toFixed(1)}:1`,
        });
      }
    }
  }

  const accent = scheme.tokens["accent-primary"];
  const accentHex = isHexColor(accent);
  for (const surfaceKey of DISPLAY_SURFACES) {
    const surface = scheme.tokens[surfaceKey];
    const surfaceHex = isHexColor(surface);
    if (!accentHex || !surfaceHex) {
      const unevaluable: string[] = [];
      if (!accentHex) unevaluable.push(`accent-primary="${accent}"`);
      if (!surfaceHex) unevaluable.push(`${surfaceKey}="${surface}"`);
      warnings.push({
        message: `Cannot evaluate accent-primary outline contrast on ${surfaceKey}: non-hex token value(s) ${unevaluable.join(", ")}`,
      });
      continue;
    }
    const ratio = contrastRatio(accent, surface);
    if (ratio < ACCENT_OUTLINE_MIN_CONTRAST) {
      warnings.push({
        message: `accent-primary outline on ${surfaceKey} is ${ratio.toFixed(2)}:1; target is ${ACCENT_OUTLINE_MIN_CONTRAST.toFixed(1)}:1 (WCAG 1.4.11 Non-text Contrast)`,
      });
    }
  }

  const accentSecondary = scheme.tokens["accent-secondary"];
  const accentSecondaryHex = isHexColor(accentSecondary);
  for (const surfaceKey of DISPLAY_SURFACES) {
    const surface = scheme.tokens[surfaceKey];
    const surfaceHex = isHexColor(surface);
    if (!accentSecondaryHex || !surfaceHex) {
      const unevaluable: string[] = [];
      if (!accentSecondaryHex) unevaluable.push(`accent-secondary="${accentSecondary}"`);
      if (!surfaceHex) unevaluable.push(`${surfaceKey}="${surface}"`);
      warnings.push({
        message: `Cannot evaluate accent-secondary outline contrast on ${surfaceKey}: non-hex token value(s) ${unevaluable.join(", ")}`,
      });
      continue;
    }
    const ratio = contrastRatio(accentSecondary, surface);
    if (ratio < ACCENT_OUTLINE_MIN_CONTRAST) {
      warnings.push({
        message: `accent-secondary outline on ${surfaceKey} is ${ratio.toFixed(2)}:1; target is ${ACCENT_OUTLINE_MIN_CONTRAST.toFixed(1)}:1 (WCAG 1.4.11 Non-text Contrast)`,
      });
    }
  }

  return warnings;
}

const ACCENT_MIN_CONTRAST = 4.5;
const ACCENT_OUTLINE_MIN_CONTRAST = 3.0;

export function accentOverrideHasLowContrast(scheme: AppColorScheme): boolean {
  const accent = scheme.tokens["accent-primary"];
  if (!isHexColor(accent)) return false;

  const accentForeground = scheme.tokens["accent-foreground"];
  if (
    isHexColor(accentForeground) &&
    contrastRatio(accentForeground, accent) < ACCENT_MIN_CONTRAST
  ) {
    return true;
  }

  return DISPLAY_SURFACES.some((key) => {
    const background = scheme.tokens[key];
    return isHexColor(background) && contrastRatio(accent, background) < ACCENT_MIN_CONTRAST;
  });
}
