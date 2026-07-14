import type {
  AppColorScheme,
  AppThemeValidationWarning,
  AppThemeTokenKey,
  ExtensionKey,
} from "./types.js";
// Function-level cyclic reference (colorValidator imports the color math below):
// safe because both sides are called at runtime, after module init, not at
// top-level evaluation. The overlay Weber floor lives in colorValidator per the
// validation-domain split; we re-run it here so it joins the same contrast gate.
import { getOverlayContrastWarnings } from "./colorValidator.js";
// Round-2 light elevation-direction audits. The cyclic import (oklch imports the
// color math in this file) is safe: every reference here is called at runtime,
// after module init — never during top-level evaluation.
import {
  auditSidebarSelectedLift,
  auditGridBgBelowPanel,
  auditPanelElevatedNotSmallest,
  type AuditResult,
} from "./oklch.js";

const DISPLAY_SURFACES: AppThemeTokenKey[] = [
  "surface-grid",
  "surface-sidebar",
  "surface-canvas",
  "surface-panel",
  "surface-panel-elevated",
];

// Text painted on a solid accent fill. Exported because it governs more than this
// module: the component-level guard (accentForeground.contract.test.ts) derives the
// token names and threshold it enforces from this pair, so a rename or a relaxed
// minimum here can't silently leave the components behind (#11115).
export const ACCENT_CONTRAST_PAIR = {
  foreground: "accent-foreground",
  background: "accent-primary",
  minimum: 4.5,
} as const;

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
  ACCENT_CONTRAST_PAIR,
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
      kind: "unevaluable",
      message: `Cannot evaluate terminal/syntax validation: terminal-background token is missing or empty`,
    });
    return warnings;
  }

  if (!bgIsHex) {
    warnings.push({
      kind: "unevaluable",
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
          kind: "unevaluable",
          message: `Cannot evaluate legibility for ${tokenKey}: token is missing or empty`,
        });
        continue;
      }
      if (!isHexColor(fg)) {
        warnings.push({
          kind: "unevaluable",
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
          kind: "terminal-legibility",
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
          kind: "terminal-legibility",
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
        kind: "unevaluable",
        message: `Cannot evaluate distinctness for ${pair.label}: non-hex token value(s) ${unevaluable.join(", ")}`,
      });
      continue;
    }
    const d = deltaEOK(aVal!, bVal!);
    if (d < DISTINCTNESS_FLOOR) {
      warnings.push({
        kind: "terminal-legibility",
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
        kind: "unevaluable",
        message: `Cannot evaluate contrast for ${pair.foreground} on ${pair.background}: non-hex foreground "${fg}"`,
      });
      continue;
    }
    if (isHexColor(bg)) {
      const ratio = contrastRatio(fg, bg);
      if (ratio < pair.minimum) {
        warnings.push({
          kind: "low-contrast",
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
              kind: "low-contrast",
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
                kind: "low-contrast",
                message: `${pair.foreground} on ${pair.background} (over ${surfaceKey}) is ${ratio.toFixed(2)}:1; target is ${pair.minimum.toFixed(1)}:1`,
              });
            }
          }
          if (!anySurfaceEvaluable) {
            warnings.push({
              kind: "unevaluable",
              message: `Cannot evaluate contrast for ${pair.foreground} on ${pair.background}: ${pair.background}="${bg}" requires compositing over a surface but no evaluable surface found`,
            });
          }
        }
      } else {
        warnings.push({
          kind: "unevaluable",
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
          kind: "low-contrast",
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
        kind: "unevaluable",
        message: `Cannot evaluate accent-primary outline contrast on ${surfaceKey}: non-hex token value(s) ${unevaluable.join(", ")}`,
      });
      continue;
    }
    const ratio = contrastRatio(accent, surface);
    if (ratio < ACCENT_OUTLINE_MIN_CONTRAST) {
      warnings.push({
        kind: "low-contrast",
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
        kind: "unevaluable",
        message: `Cannot evaluate accent-secondary outline contrast on ${surfaceKey}: non-hex token value(s) ${unevaluable.join(", ")}`,
      });
      continue;
    }
    const ratio = contrastRatio(accentSecondary, surface);
    if (ratio < ACCENT_OUTLINE_MIN_CONTRAST) {
      warnings.push({
        kind: "low-contrast",
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

// The override gate and the validation matrix must enforce the same threshold — a second
// literal here could silently drift from the pair everything else is derived from.
const ACCENT_MIN_CONTRAST = ACCENT_CONTRAST_PAIR.minimum;
const ACCENT_OUTLINE_MIN_CONTRAST = 3.0;

// Structured result describing how an accent override fails its contrast gate, so
// the theme picker can render a specific, actionable warning instead of a generic
// one-liner. `mode` distinguishes the two materially different failures:
//   - "foreground": accent-foreground text/icons are illegible on the accent fill
//     (e.g. a button label vanishing into its own button)
//   - "surface": the accent color itself is hard to see on a theme background
// `worstRatio` is the lowest contrast ratio found for the reported mode, and
// `worstSurface` names the offending background in surface mode (null otherwise).
export type AccentContrastFailure = {
  mode: "foreground" | "surface";
  worstRatio: number;
  worstSurface: AppThemeTokenKey | null;
};

export function accentOverrideHasLowContrast(scheme: AppColorScheme): AccentContrastFailure | null {
  const accent = scheme.tokens["accent-primary"];
  if (!isHexColor(accent)) return null;

  // Foreground-first precedence: text-on-accent-button legibility is a higher-
  // severity failure than accent-tint-on-background, so report it before scanning
  // surfaces. The user should fix this before discovering any surface issue.
  const accentForeground = scheme.tokens["accent-foreground"];
  if (isHexColor(accentForeground)) {
    const fgRatio = contrastRatio(accentForeground, accent);
    if (fgRatio < ACCENT_MIN_CONTRAST) {
      return { mode: "foreground", worstRatio: fgRatio, worstSurface: null };
    }
  }

  let worstRatio = Infinity;
  let worstSurface: AppThemeTokenKey | null = null;
  for (const key of DISPLAY_SURFACES) {
    const background = scheme.tokens[key];
    if (!isHexColor(background)) continue;
    const ratio = contrastRatio(accent, background);
    if (ratio < worstRatio) {
      worstRatio = ratio;
      worstSurface = key;
    }
  }

  if (worstSurface !== null && worstRatio < ACCENT_MIN_CONTRAST) {
    return { mode: "surface", worstRatio, worstSurface };
  }

  return null;
}

// ── Round-2 light validation matrix (E6) ─────────────────────────────────────
//
// A consolidated, polarity-aware audit covering the surface/component pairs that
// shipped wrong in round 1 because no guard existed for them: status/PR/activity
// indicators against the surface they render on, input text against the recessed
// input well, scrollbar visibility, selected-filter separation, the pulse heat
// ramp, and the two elevation-direction inversions (sidebar selection, grid
// figure-ground). EVERYTHING here is ADVISORY — `getLightThemeMatrixWarnings`
// returns a flat warning list and is NOT joined into `getThemeContrastWarnings`,
// so the build stays green while the palette work lands. The Harden phase flips
// the wiring (calls these from the test as hard-fail) once the palettes clear.
//
// Most checks are LIGHT-only: the failures they target are light-mode inversions
// (darken-to-select, black-ink chrome, grid brighter than tiles). Where a check
// is meaningful in both polarities (graphical-indicator ≥3:1, input-text AA) it
// runs for both — dark already clears them, so it stays silent there.

const RAMP_DL_JND_MATRIX = 0.02;

/**
 * Resolve a token (from `scheme.tokens`) or extension (from `scheme.extensions`)
 * to a concrete hex by compositing over a render surface when it carries alpha.
 * Returns `{ hex }` when evaluable, or `{ skip }` with a reason when the value is
 * missing, an unresolved `color-mix()`/`oklch()`/`var()`, or otherwise non-numeric.
 * The matrix is advisory, so unevaluable values are skipped (not failed): the
 * runtime CSS does the color-mix the static checker can't.
 */
function resolveToHex(
  raw: string | undefined,
  surfaceHex: string | undefined
): { hex: string } | { skip: string } {
  if (typeof raw !== "string" || !raw.trim()) return { skip: "missing/empty" };
  const trimmed = raw.trim();
  if (isHexColor(trimmed)) {
    // 8-digit hex carries alpha; composite if we can, else use the RGB as-is.
    return { hex: trimmed };
  }
  const rgba = parseRgba(trimmed);
  if (rgba) {
    if (rgba.opacity >= 1) return { hex: rgba.hex };
    if (surfaceHex && isHexColor(surfaceHex)) {
      return { hex: blendOverBackground(rgba.hex, surfaceHex, rgba.opacity) };
    }
    return { skip: `rgba needs a surface to composite over (none evaluable)` };
  }
  return { skip: `non-evaluable form "${trimmed}" (color-mix/oklch/var/named)` };
}

function tokenVal(scheme: AppColorScheme, key: AppThemeTokenKey): string | undefined {
  return scheme.tokens[key];
}

function extVal(scheme: AppColorScheme, key: ExtensionKey): string | undefined {
  return scheme.extensions?.[key];
}

interface MatrixContrastPair {
  /** Foreground token. */
  fg: AppThemeTokenKey;
  /** Background token (resolved; rgba composited over `over`). */
  bg: AppThemeTokenKey;
  /** Surface key the bg is composited over when it carries alpha. */
  over?: AppThemeTokenKey;
  minimum: number;
  label: string;
  appliesTo?: "light" | "dark";
}

// Graphical/status indicators must clear 3:1 (WCAG 1.4.11). Text against its well
// must clear AA 4.5:1. These are the gaps E6 names explicitly.
//
// LIGHT-only scoping (matching the `appliesTo: "light"` precedent in CONTRAST_PAIRS):
// the activity/pr/scrollbar deficits E6 targets are light-mode failures — on a
// near-white field the quiet idle dot, the AA-forced dark PR hue, and the subtle
// thumb all collapse. Dark runs intentionally lower, sanctioned calibrations for
// the SAME tokens (a deliberately recessive idle dot, a low-key scrollbar) that
// these floors would false-fail; gating to light keeps the Harden flip from ever
// tripping the established dark themes (owner decision: dark stays byte-for-byte).
const MATRIX_CONTRAST_PAIRS: MatrixContrastPair[] = [
  // activity-* dots render on panel/elevated/canvas chrome — graphical ≥3:1.
  ...(
    [
      ["activity-active", "active"],
      ["activity-idle", "idle"],
      ["activity-working", "working"],
      ["activity-waiting", "waiting"],
      ["activity-completed", "completed"],
    ] as const
  ).flatMap(([tok, name]) =>
    (["surface-panel", "surface-panel-elevated", "surface-canvas"] as const).map((bg) => ({
      fg: tok as AppThemeTokenKey,
      bg: bg as AppThemeTokenKey,
      minimum: 3.0,
      label: `${name} dot vs ${bg}`,
      appliesTo: "light" as const,
    }))
  ),
  // pr-* badges render as colored text/glyph on panel/elevated — AA 4.5:1.
  ...(["pr-open", "pr-merged", "pr-closed", "pr-draft"] as const).flatMap((tok) =>
    (["surface-panel", "surface-panel-elevated"] as const).map((bg) => ({
      fg: tok as AppThemeTokenKey,
      bg: bg as AppThemeTokenKey,
      minimum: 4.5,
      label: `${tok} vs ${bg}`,
      appliesTo: "light" as const,
    }))
  ),
  // scrollbar-thumb must be visible against the track / its surface — graphical 3:1.
  {
    fg: "scrollbar-thumb",
    bg: "surface-panel",
    minimum: 3.0,
    label: "scrollbar-thumb vs surface-panel",
    appliesTo: "light",
  },
  {
    fg: "scrollbar-thumb",
    bg: "surface-canvas",
    minimum: 3.0,
    label: "scrollbar-thumb vs surface-canvas",
    appliesTo: "light",
  },
  // input text must be legible against the (now recessed) input well — AA 4.5:1.
  {
    fg: "text-primary",
    bg: "surface-input",
    minimum: 4.5,
    label: "input text-primary vs surface-input",
  },
  // placeholder is a graphical-tier de-emphasis floor on the input well — 3:1.
  {
    fg: "text-placeholder",
    bg: "surface-input",
    over: "surface-input",
    minimum: 3.0,
    label: "input placeholder vs surface-input",
    appliesTo: "light",
  },
];

function runMatrixContrastPairs(scheme: AppColorScheme): AppThemeValidationWarning[] {
  const out: AppThemeValidationWarning[] = [];
  for (const pair of MATRIX_CONTRAST_PAIRS) {
    if (pair.appliesTo && pair.appliesTo !== scheme.type) continue;
    const fgRaw = tokenVal(scheme, pair.fg);
    const overSurface = pair.over ? tokenVal(scheme, pair.over) : tokenVal(scheme, pair.bg);
    const fg = resolveToHex(fgRaw, overSurface);
    const bg = resolveToHex(tokenVal(scheme, pair.bg), tokenVal(scheme, pair.bg));
    if ("skip" in fg || "skip" in bg) continue; // advisory: skip unevaluable
    const ratio = contrastRatio(fg.hex, bg.hex);
    if (ratio < pair.minimum) {
      out.push({
        kind: "low-contrast",
        message: `[matrix] ${scheme.id}: ${pair.label} is ${ratio.toFixed(2)}:1; target is ${pair.minimum.toFixed(1)}:1`,
      });
    }
  }
  return out;
}

interface MatrixSeparationPair {
  /** First resolved color (composited over `aOver`). */
  a: { token?: AppThemeTokenKey; ext?: ExtensionKey; over?: AppThemeTokenKey };
  b: { token?: AppThemeTokenKey; ext?: ExtensionKey; over?: AppThemeTokenKey };
  /** Minimum OKLab ΔE between the two. */
  minDeltaE: number;
  label: string;
  appliesTo?: "light" | "dark";
}

function resolvePart(
  scheme: AppColorScheme,
  part: { token?: AppThemeTokenKey; ext?: ExtensionKey; over?: AppThemeTokenKey }
): { hex: string } | { skip: string } {
  const raw = part.token
    ? tokenVal(scheme, part.token)
    : part.ext
      ? extVal(scheme, part.ext)
      : undefined;
  const surface = part.over ? tokenVal(scheme, part.over) : undefined;
  return resolveToHex(raw, surface);
}

// Selected/active fills must separate from their unselected sibling by a JND
// (ΔE ≈ 0.02 is the OKLab JND). filter-selected-soft vs -strong is the within-
// popover membership ramp; both are tint-derived alphas composited over panel.
const MATRIX_SEPARATION_PAIRS: MatrixSeparationPair[] = [
  {
    a: { token: "filter-selected-bg-soft", over: "surface-panel" },
    b: { token: "surface-panel" },
    minDeltaE: RAMP_DL_JND_MATRIX,
    label: "filter-selected-soft separates from surface-panel",
  },
  {
    a: { token: "filter-selected-bg-strong", over: "surface-panel" },
    b: { token: "filter-selected-bg-soft", over: "surface-panel" },
    minDeltaE: RAMP_DL_JND_MATRIX,
    label: "filter-selected strong separates from soft",
  },
];

function runMatrixSeparationPairs(scheme: AppColorScheme): AppThemeValidationWarning[] {
  const out: AppThemeValidationWarning[] = [];
  for (const pair of MATRIX_SEPARATION_PAIRS) {
    if (pair.appliesTo && pair.appliesTo !== scheme.type) continue;
    const a = resolvePart(scheme, pair.a);
    const b = resolvePart(scheme, pair.b);
    if ("skip" in a || "skip" in b) continue;
    const de = deltaEOK(a.hex, b.hex);
    if (de < pair.minDeltaE) {
      out.push({
        kind: "low-contrast",
        message: `[matrix] ${scheme.id}: ${pair.label} — ΔE=${de.toFixed(4)} below ${pair.minDeltaE.toFixed(3)} (perceptually merges)`,
      });
    }
  }
  return out;
}

/**
 * Card surfaces (settings cards / list items) must read as LIFTED above the dialog
 * body they sit on — light only (S1). When `settings-card-bg` is darker than or
 * equal to `settings-dialog-bg` the card inverts (bali ships this). Both come from
 * `scheme.extensions`; either being unset means the consumer falls back to a shared
 * default and there is nothing to compare, so skip.
 */
function runCardAboveDialogBody(scheme: AppColorScheme): AppThemeValidationWarning[] {
  if (scheme.type !== "light") return [];
  const out: AppThemeValidationWarning[] = [];
  const card = resolveToHex(extVal(scheme, "settings-card-bg"), tokenVal(scheme, "surface-panel"));
  const body = resolveToHex(
    extVal(scheme, "settings-dialog-bg"),
    tokenVal(scheme, "surface-panel")
  );
  if ("skip" in card || "skip" in body) return out;
  const cardL = relativeLuminance(card.hex);
  const bodyL = relativeLuminance(body.hex);
  if (cardL <= bodyL) {
    out.push({
      kind: "low-contrast",
      message: `[matrix] ${scheme.id}: light settings card (L≈${cardL.toFixed(3)}) is at/below the dialog body (L≈${bodyL.toFixed(3)}) — the card must lift above its container, not recede (S1)`,
    });
  }
  return out;
}

/**
 * The pulse heatmap composites a single hue at four alpha stops over the empty cell
 * (RC-2 in miniature). Light-only (P-Heat). Two failures this catches: (1) the
 * lowest heat stop is sub-JND against the empty cell, so a worked day is invisible;
 * (2) the missed-day film (a destructive streak-break signal) is sub-3:1 against the
 * empty cell. Requires `pulse-heat-color`; themes that leave it unset fall back at
 * the consumer and are skipped.
 */
function runPulseHeatSeparation(scheme: AppColorScheme): AppThemeValidationWarning[] {
  if (scheme.type !== "light") return [];
  const out: AppThemeValidationWarning[] = [];
  const emptyRaw = extVal(scheme, "pulse-empty-bg") ?? tokenVal(scheme, "surface-canvas");
  const empty = resolveToHex(emptyRaw, tokenVal(scheme, "surface-canvas"));
  if ("skip" in empty) return out;

  const heatColor = extVal(scheme, "pulse-heat-color");
  const lowOp = Number(extVal(scheme, "pulse-heat-low-opacity"));
  if (typeof heatColor === "string" && isHexColor(heatColor) && Number.isFinite(lowOp)) {
    const stop1 = blendOverBackground(heatColor, empty.hex, lowOp);
    const de = deltaEOK(stop1, empty.hex);
    if (de < RAMP_DL_JND_MATRIX) {
      out.push({
        kind: "low-contrast",
        message: `[matrix] ${scheme.id}: pulse heat level-1 (heat-color @${lowOp}) ΔE=${de.toFixed(4)} vs empty cell is below JND (${RAMP_DL_JND_MATRIX}) — a worked day is invisible (P-Heat)`,
      });
    }
  }

  const missed = resolveToHex(extVal(scheme, "pulse-missed-bg"), empty.hex);
  if (!("skip" in missed)) {
    const ratio = contrastRatio(missed.hex, empty.hex);
    if (ratio < 3.0) {
      out.push({
        kind: "low-contrast",
        message: `[matrix] ${scheme.id}: pulse missed-day fill vs empty cell is ${ratio.toFixed(2)}:1; target is 3.0:1 — the streak-break signal is imperceptible (P-Heat)`,
      });
    }
  }

  return out;
}

/**
 * working vs waiting activity dots are commonly separated by hue alone, which fails
 * on the deuteranope confusion line at 6px. Flag when their OKLab separation is below
 * a clearly-distinct floor so the palette/shape work knows to act (B2). Advisory in
 * both polarities; the backlog's primary remedy is the shape channel, so this is a
 * heads-up, not a mandate to brighten.
 */
function runActivityWorkingWaitingSeparation(scheme: AppColorScheme): AppThemeValidationWarning[] {
  const out: AppThemeValidationWarning[] = [];
  const working = tokenVal(scheme, "activity-working");
  const waiting = tokenVal(scheme, "activity-waiting");
  if (
    typeof working !== "string" ||
    typeof waiting !== "string" ||
    !isHexColor(working) ||
    !isHexColor(waiting)
  ) {
    return out;
  }
  const de = deltaEOK(working, waiting);
  // 0.10 ≈ "clearly distinct" lower bound in OKLab; below it the two dots lean on
  // hue, which the deuteranope confusion line erases on a small dot.
  if (de < 0.1) {
    out.push({
      kind: "low-contrast",
      message: `[matrix] ${scheme.id}: activity working vs waiting ΔE=${de.toFixed(3)} (<0.10) — near-isoluminant, separable by hue only; lean on the shape channel (B2)`,
    });
  }
  return out;
}

/**
 * The consolidated Round-2 light validation matrix (E6). Returns a flat advisory
 * warning list. NOT wired into `getThemeContrastWarnings` — the Harden phase calls
 * this from the test and flips it to hard-fail once the palettes clear. Each block
 * is independently skippable so an unevaluable token never masks a real failure.
 *
 * Coverage map (backlog → check):
 *   activity-*-vs-surface (≥3:1) ......... runMatrixContrastPairs
 *   pr-*-vs-surface (AA) ................. runMatrixContrastPairs
 *   scrollbar-thumb-vs-surface (3:1) ..... runMatrixContrastPairs
 *   input-text-vs-surface-input (AA) ..... runMatrixContrastPairs
 *   filter-selected separation (JND) ..... runMatrixSeparationPairs
 *   card-vs-dialog-body (light) .......... runCardAboveDialogBody
 *   pulse heat/missed separation ......... runPulseHeatSeparation
 *   activity working/waiting separation .. runActivityWorkingWaitingSeparation
 *   sidebar-selected-above-container ..... auditSidebarSelectedLift (oklch)
 *   grid-bg-below-panel (light) .......... auditGridBgBelowPanel (oklch)
 *   panel→elevated not-smallest (light) .. auditPanelElevatedNotSmallest (oklch)
 *
 * category-*-vs-render-surface is intentionally a NO-OP here: every built-in ships
 * `category-*` as `oklch(...)`, which composites at runtime via CSS `color-mix` into
 * the render surface — there is no static hex the matrix can resolve, so the check
 * would only ever skip. It is documented as deferred to a runtime/visual pass (B1)
 * rather than emit noise. `resolveToHex` will surface it the moment a theme ships a
 * hex category override.
 */
export function getLightThemeMatrixWarnings(scheme: AppColorScheme): AppThemeValidationWarning[] {
  const warnings: AppThemeValidationWarning[] = [];

  warnings.push(...runMatrixContrastPairs(scheme));
  warnings.push(...runMatrixSeparationPairs(scheme));
  warnings.push(...runCardAboveDialogBody(scheme));
  warnings.push(...runPulseHeatSeparation(scheme));
  warnings.push(...runActivityWorkingWaitingSeparation(scheme));

  const collect = (r: AuditResult, prefix: string) => {
    for (const f of r.failures)
      warnings.push({ kind: "low-contrast", message: `[matrix] ${prefix}${f}` });
    for (const w of r.warnings)
      warnings.push({ kind: "low-contrast", message: `[matrix] ${prefix}${w}` });
  };

  // Elevation-direction inversions (OKLab, light-only). Resolve the composited
  // selected-row fill and grid gutter before handing hex to the oklch audits.
  if (scheme.type === "light") {
    const sidebar = tokenVal(scheme, "surface-sidebar");
    const selectedRaw = extVal(scheme, "sidebar-active-bg");
    const selected = resolveToHex(selectedRaw, sidebar);
    if (!("skip" in selected) && typeof sidebar === "string") {
      collect(auditSidebarSelectedLift(selected.hex, sidebar, scheme.id, "light"), "");
    } else {
      warnings.push({
        kind: "unevaluable",
        message: `[matrix] ${scheme.id}: skipped sidebar-selected lift — sidebar-active-bg unevaluable (${"skip" in selected ? selected.skip : "no sidebar surface"})`,
      });
    }

    const grid = tokenVal(scheme, "surface-grid");
    const gridBgRaw = extVal(scheme, "panel-grid-bg");
    const gridBg = resolveToHex(gridBgRaw, grid);
    const panel = tokenVal(scheme, "surface-panel");
    if (!("skip" in gridBg) && typeof panel === "string") {
      collect(auditGridBgBelowPanel(gridBg.hex, panel, scheme.id, "light"), "");
    }

    if (scheme.palette?.surfaces) {
      collect(auditPanelElevatedNotSmallest(scheme.palette.surfaces, scheme.id, "light"), "");
    }
  }

  return warnings;
}
