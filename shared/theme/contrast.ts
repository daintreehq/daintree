import type { AppColorScheme, AppThemeValidationWarning, AppThemeTokenKey } from "./types.js";

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
  { foreground: "text-secondary", background: "surface-canvas", minimum: 3.0 },
  { foreground: "text-secondary", background: "surface-panel", minimum: 3.0 },
  { foreground: "text-secondary", background: "surface-panel-elevated", minimum: 3.0 },
  { foreground: "accent-foreground", background: "accent-primary", minimum: 4.5 },
  { foreground: "terminal-foreground", background: "terminal-background", minimum: 4.5 },
  { foreground: "terminal-red", background: "terminal-background", minimum: 3.0 },
  { foreground: "terminal-green", background: "terminal-background", minimum: 3.0 },
];

function isHexColor(value: string): boolean {
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value);
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

export function getThemeContrastWarnings(scheme: AppColorScheme): AppThemeValidationWarning[] {
  const warnings: AppThemeValidationWarning[] = [];

  for (const pair of CONTRAST_PAIRS) {
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
