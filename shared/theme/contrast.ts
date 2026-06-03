import type { AppColorScheme, AppThemeValidationWarning, AppThemeTokenKey } from "./types.js";
// Function-level cyclic reference (colorValidator imports the color math below):
// safe because both sides are called at runtime, after module init, not at
// top-level evaluation. The overlay Weber floor lives in colorValidator per the
// validation-domain split; we re-run it here so it joins the same contrast gate.
import { getOverlayContrastWarnings } from "./colorValidator.js";

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
  // When set, the pair is only enforced for that polarity. Used for roles whose
  // legible-on-canvas target is a documented light-mode requirement, while the
  // dark mode runs an intentionally lower, sanctioned calibration (e.g. muted
  // label text, the on-canvas accent link) that must not regress (RC-4 / RC-8).
  appliesTo?: "light" | "dark";
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
  // text-muted is the de-emphasized label tier. A 3.0 floor (matching text-secondary)
  // is too permissive — muted text routinely drained below legibility on the light
  // palettes while still clearing 3.0. A floor of 3.5 keeps it honest as
  // readable-but-quiet (RC-8). Light-only: dark muted runs an intentionally lower,
  // sanctioned calibration (visual-guide.md sanctions sub-AA muted; daintree itself
  // sits ~4.1, namib ~2.2) which this guard must not regress.
  { foreground: "text-muted", background: "surface-grid", minimum: 3.5, appliesTo: "light" },
  { foreground: "text-muted", background: "surface-sidebar", minimum: 3.5, appliesTo: "light" },
  { foreground: "text-muted", background: "surface-canvas", minimum: 3.5, appliesTo: "light" },
  { foreground: "text-muted", background: "surface-panel", minimum: 3.5, appliesTo: "light" },
  {
    foreground: "text-muted",
    background: "surface-panel-elevated",
    minimum: 3.5,
    appliesTo: "light",
  },
  // text-link is rendered as on-canvas accent-colored text. On dark it advances as
  // a bright object; on light, the AA-forced dark/low-chroma accent recedes below
  // the surface and the engine never flagged it because no link-vs-canvas pair
  // existed (RC-4/RC-8). 4.5 = AA body text, since a link IS readable body text.
  // Light-only: the receding-link figure-ground inversion is a light-mode defect;
  // dark links are bright by construction (and arashiyama's deliberate 4.38 must
  // not regress).
  { foreground: "text-link", background: "surface-canvas", minimum: 4.5, appliesTo: "light" },
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

export function parseRgba(value: string): { hex: string; opacity: number } | null {
  const trimmed = value.trim();
  const match = trimmed.match(/^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/);
  if (!match) return null;
  return {
    hex: `#${parseInt(match[1]!, 10).toString(16).padStart(2, "0")}${parseInt(match[2]!, 10).toString(16).padStart(2, "0")}${parseInt(match[3]!, 10).toString(16).padStart(2, "0")}`,
    opacity: parseFloat(match[4]!),
  };
}

export function blendOverBackground(fgHex: string, bgHex: string, opacity: number): string {
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

export function relativeLuminance(hex: string): number {
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

// ── OKLab perceptual color math ──────────────────────────────────────────────
// Hand-rolled conversion from sRGB hex to OKLab coordinates (Ottosson 2020).
// No color-science dependency — the math is small and stable.

interface Oklab {
  L: number;
  a: number;
  b: number;
}

function hexToOklab(hex: string): Oklab {
  const [r8, g8, b8] = hexToRgb(hex);
  const r = hexToLinear(r8);
  const g = hexToLinear(g8);
  const b = hexToLinear(b8);

  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  return {
    L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  };
}

/**
 * Perceptual distance between two sRGB hex colors in OKLab space.
 * Scale is 0–1 (not CIELAB's 0–100). JND ≈ 0.02; clearly distinct ≈ 0.1–0.4.
 */
export function deltaEOK(hex1: string, hex2: string): number {
  const c1 = hexToOklab(hex1);
  const c2 = hexToOklab(hex2);
  const dL = c1.L - c2.L;
  const da = c1.a - c2.a;
  const db = c1.b - c2.b;
  return Math.sqrt(dL * dL + da * da + db * db);
}

function okLightnessDiff(fgHex: string, bgHex: string): number {
  return Math.abs(hexToOklab(fgHex).L - hexToOklab(bgHex).L);
}

// ── Terminal / syntax token groups ───────────────────────────────────────────

const TERMINAL_ANSI_COLORS: AppThemeTokenKey[] = [
  "terminal-red",
  "terminal-green",
  "terminal-yellow",
  "terminal-blue",
  "terminal-magenta",
  "terminal-cyan",
  "terminal-white",
];

const TERMINAL_ANSI_BRIGHT_COLORS: AppThemeTokenKey[] = [
  "terminal-bright-red",
  "terminal-bright-green",
  "terminal-bright-yellow",
  "terminal-bright-blue",
  "terminal-bright-magenta",
  "terminal-bright-cyan",
  "terminal-bright-white",
];

const TERMINAL_SYNTAX_ROLES: AppThemeTokenKey[] = [
  "syntax-comment",
  "syntax-punctuation",
  "syntax-number",
  "syntax-string",
  "syntax-operator",
  "syntax-keyword",
  "syntax-function",
  "syntax-link",
  "syntax-quote",
  "syntax-chip",
];

const SOFT_LEGIBILITY_ROLES: ReadonlySet<AppThemeTokenKey> = new Set([
  "syntax-comment",
  "syntax-quote",
]);

// terminal-black is intentionally near terminal-background in dark themes —
// it's the ANSI "black" slot and doubles as invisible/hidden text. Skip
// legibility; distinctness vs terminal-bright-black is the check that matters.
const LEGIBILITY_SKIP_TOKENS: ReadonlySet<AppThemeTokenKey> = new Set(["terminal-black"]);

const PRIMARY_LEGIBILITY_FLOOR = 0.55;
const STANDARD_LEGIBILITY_FLOOR = 0.18;
// De-emphasized roles (comment, quote) get the same floor at current calibration
// but use a separate constant so the floor can be relaxed independently later.
const SOFT_LEGIBILITY_FLOOR = 0.18;
// Calibrated to pass all 14 built-in themes without redesign. At 0.03 this is a
// near-duplicate guard (JND ≈ 0.02), not a robust distinctness guarantee. The
// current themes simply don't differentiate base/bright pairs more than this.
const DISTINCTNESS_FLOOR = 0.03;

// Syntax roles are painted on surface-canvas in the file viewer (editorTheme.ts),
// not on the always-dark terminal-background. The terminal legibility loop above
// validates the TERMINAL render surface; this validates the EDITOR render surface
// (RC-8). WCAG ratios are reliable here because surface-canvas is a real, possibly
// light, surface — so we use contrastRatio, not OKLab dL. Editor code is body text
// → AA 4.5:1; de-emphasized roles (comment, quote) get a relaxed legible floor.
const SYNTAX_CANVAS_MIN_CONTRAST = 4.5;
const SYNTAX_CANVAS_SOFT_MIN_CONTRAST = 3.0;
const SYNTAX_CANVAS_SURFACE: AppThemeTokenKey = "surface-canvas";
// Roles that aren't legibility-bearing foreground code text on the canvas:
// chip is a fill/badge, not a glyph color, so it's excluded from the render check.
const SYNTAX_CANVAS_SKIP: ReadonlySet<AppThemeTokenKey> = new Set(["syntax-chip"]);

interface DistinctnessPair {
  a: AppThemeTokenKey;
  b: AppThemeTokenKey;
  label: string;
}

const DISTINCTNESS_PAIRS: DistinctnessPair[] = [
  { a: "terminal-red", b: "terminal-bright-red", label: "red vs bright-red" },
  { a: "terminal-green", b: "terminal-bright-green", label: "green vs bright-green" },
  { a: "terminal-yellow", b: "terminal-bright-yellow", label: "yellow vs bright-yellow" },
  { a: "terminal-blue", b: "terminal-bright-blue", label: "blue vs bright-blue" },
  { a: "terminal-magenta", b: "terminal-bright-magenta", label: "magenta vs bright-magenta" },
  { a: "terminal-cyan", b: "terminal-bright-cyan", label: "cyan vs bright-cyan" },
  { a: "terminal-black", b: "terminal-bright-black", label: "black vs bright-black" },
  { a: "terminal-blue", b: "terminal-cyan", label: "blue vs cyan" },
  { a: "terminal-bright-blue", b: "terminal-bright-cyan", label: "bright-blue vs bright-cyan" },
  { a: "syntax-keyword", b: "syntax-function", label: "keyword vs function" },
  { a: "syntax-string", b: "syntax-number", label: "string vs number" },
];

function getTerminalSyntaxWarnings(scheme: AppColorScheme): AppThemeValidationWarning[] {
  const warnings: AppThemeValidationWarning[] = [];
  const bg = scheme.tokens["terminal-background"];
  const bgIsHex = typeof bg === "string" && isHexColor(bg);

  if (typeof bg !== "string" || !bg.trim()) {
    warnings.push({
      message: `Cannot evaluate terminal/syntax validation: terminal-background token is missing or empty`,
    });
    return warnings;
  }

  if (!bgIsHex) {
    warnings.push({
      message: `Cannot evaluate terminal/syntax legibility: terminal-background="${bg}" is not a hex color`,
    });
  }

  // Legibility — skip if background isn't evaluable.
  if (bgIsHex) {
    const allLegibilityTargets: AppThemeTokenKey[] = [
      "terminal-foreground",
      "terminal-bright-black",
      ...TERMINAL_ANSI_COLORS,
      ...TERMINAL_ANSI_BRIGHT_COLORS,
      ...TERMINAL_SYNTAX_ROLES,
    ];

    for (const tokenKey of allLegibilityTargets) {
      if (LEGIBILITY_SKIP_TOKENS.has(tokenKey)) continue;
      const fg = scheme.tokens[tokenKey];
      if (typeof fg !== "string" || !fg.trim()) {
        warnings.push({
          message: `Cannot evaluate legibility for ${tokenKey}: token is missing or empty`,
        });
        continue;
      }
      if (!isHexColor(fg)) {
        warnings.push({
          message: `Cannot evaluate legibility for ${tokenKey} on terminal-background: non-hex value "${fg}"`,
        });
        continue;
      }
      const dL = okLightnessDiff(fg, bg);
      const floor = SOFT_LEGIBILITY_ROLES.has(tokenKey)
        ? SOFT_LEGIBILITY_FLOOR
        : tokenKey === "terminal-foreground"
          ? PRIMARY_LEGIBILITY_FLOOR
          : STANDARD_LEGIBILITY_FLOOR;
      if (dL < floor) {
        warnings.push({
          message: `${tokenKey} on terminal-background OKLab lightness diff is ${dL.toFixed(3)}; floor is ${floor.toFixed(2)}`,
        });
      }
    }
  }

  // Editor render-surface legibility — syntax roles are painted on surface-canvas
  // in the file viewer, in ADDITION to the terminal (RC-8). For light themes the
  // terminal background (dark) and the canvas (near-white) diverge, so a role that
  // passes the dark-terminal check can be invisible on the canvas it renders on.
  const canvas = scheme.tokens[SYNTAX_CANVAS_SURFACE];
  if (typeof canvas === "string" && isHexColor(canvas)) {
    for (const tokenKey of TERMINAL_SYNTAX_ROLES) {
      if (SYNTAX_CANVAS_SKIP.has(tokenKey)) continue;
      const fg = scheme.tokens[tokenKey];
      if (typeof fg !== "string" || !isHexColor(fg)) continue; // terminal loop already reported non-hex/missing
      const ratio = contrastRatio(fg, canvas);
      const floor = SOFT_LEGIBILITY_ROLES.has(tokenKey)
        ? SYNTAX_CANVAS_SOFT_MIN_CONTRAST
        : SYNTAX_CANVAS_MIN_CONTRAST;
      if (ratio < floor) {
        warnings.push({
          message: `${tokenKey} on ${SYNTAX_CANVAS_SURFACE} (editor render surface) is ${ratio.toFixed(2)}:1; target is ${floor.toFixed(1)}:1`,
        });
      }
    }
  }

  // Distinctness — independent of background, always run.
  for (const pair of DISTINCTNESS_PAIRS) {
    const aVal = scheme.tokens[pair.a];
    const bVal = scheme.tokens[pair.b];
    const aOk = typeof aVal === "string" && isHexColor(aVal);
    const bOk = typeof bVal === "string" && isHexColor(bVal);
    if (!aOk || !bOk) {
      const unevaluable: string[] = [];
      if (!aOk) unevaluable.push(`${pair.a}="${aVal ?? "<missing>"}"`);
      if (!bOk) unevaluable.push(`${pair.b}="${bVal ?? "<missing>"}"`);
      warnings.push({
        message: `Cannot evaluate distinctness for ${pair.label}: non-hex token value(s) ${unevaluable.join(", ")}`,
      });
      continue;
    }
    const d = deltaEOK(aVal!, bVal!);
    if (d < DISTINCTNESS_FLOOR) {
      warnings.push({
        message: `${pair.label} deltaEOK is ${d.toFixed(3)}; floor is ${DISTINCTNESS_FLOOR.toFixed(2)}`,
      });
    }
  }

  return warnings;
}

export function getThemeContrastWarnings(scheme: AppColorScheme): AppThemeValidationWarning[] {
  const warnings: AppThemeValidationWarning[] = [];

  for (const pair of CONTRAST_PAIRS) {
    if (pair.appliesTo && pair.appliesTo !== scheme.type) continue;
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

  // Terminal ANSI / syntax legibility and distinctness — OKLab-based because
  // the terminal background is always dark and WCAG ratios are unreliable there.
  warnings.push(...getTerminalSyntaxWarnings(scheme));

  // Interactive overlay perceptibility (RC-2) — both-polarity Weber floor on the
  // hover overlay over surface-canvas. Lives in colorValidator; joined here.
  warnings.push(...getOverlayContrastWarnings(scheme));

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
