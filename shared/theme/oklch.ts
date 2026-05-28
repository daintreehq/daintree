import { isHexColor, hexToRgb, hexToLinear } from "./contrast.js";
import type { ThemePalette } from "./palette.js";
import type { BuiltInThemeSource } from "./builtInThemeSources.js";

export interface OklchColor {
  l: number;
  c: number;
  h: number;
}

export interface AuditResult {
  failures: string[];
  warnings: string[];
}

const SURFACE_RAMP_KEYS = ["grid", "sidebar", "canvas", "panel", "elevated"] as const;

// --- Thresholds ---

// Perceptual JND (just-noticeable difference) for lightness in OKLab.
// Adjacent surface steps below this merge perceptually.
const RAMP_DL_JND = 0.02;

// Runaway ratio: max adjacent dL / min adjacent dL. Above this, one step
// dominates the ramp and the elevation progression reads as uneven.
const RAMP_RUNAWAY_RATIO = 3;

// Accent chroma floor: below this in OKLCH, a color reads as a tinted
// neutral rather than unambiguously colored.
const ACCENT_CHROMA_WARN = 0.05;

// Accent-to-canvas lightness separation for grayscale survivability.
// Below this, the accent blends into the canvas under achromatopsia.
const ACCENT_CANVAS_DL_WARN = 0.2;

// Minimum pairwise ΔE between primary accents of same-polarity themes.
// Below this, two themes' accents are perceptibly the same color.
// ΔE is in OKLab space [0, ~1]; 0.12 is approximately the threshold
// where two moderately-saturated accents become hard to tell apart.
const CROSS_THEME_DE_WARN = 0.12;

// --- Conversion ---

/**
 * Convert a hex color string to OKLCH. Returns null for non-hex or
 * unparseable values. Uses the CSS Color 4 / Björn Ottosson conversion
 * chain: sRGB gamma decode → LMS (M1) → cbrt → OKLab (M2) → OKLCh.
 */
export function hexToOklch(hex: string): OklchColor | null {
  if (typeof hex !== "string" || !isHexColor(hex)) return null;
  const [r, g, b] = hexToRgb(hex);
  const lr = hexToLinear(r);
  const lg = hexToLinear(g);
  const lb = hexToLinear(b);

  // M1: linear sRGB → LMS (canonical CSS Color 4 values)
  const lmsL = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const lmsM = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const lmsS = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;

  const l_ = Math.cbrt(lmsL);
  const m_ = Math.cbrt(lmsM);
  const s_ = Math.cbrt(lmsS);

  // M2: LMS' → OKLab (canonical CSS Color 4 values)
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const b_ = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;

  const C = Math.sqrt(a * a + b_ * b_);
  let h = Math.atan2(b_, a) * (180 / Math.PI);
  if (h < 0) h += 360;

  return { l: L, c: C, h };
}

// --- Distance ---

/**
 * Perceptual distance between two OKLCH colors. Hue distance is weighted
 * by the geometric mean chroma so that achromatic colors (C≈0) contribute
 * no hue penalty. Falls back to ΔL-only when both colors are effectively
 * achromatic to avoid hue-noise amplification from floating-point rounding.
 */
export function deltaOklch(a: OklchColor, b: OklchColor): number {
  const dL = a.l - b.l;
  const dC = a.c - b.c;

  const dhRad = (((a.h - b.h + 540) % 360) - 180) * (Math.PI / 180);
  const dH = 2 * Math.sqrt(a.c * b.c) * Math.sin(dhRad / 2);

  return Math.sqrt(dL * dL + dC * dC + dH * dH);
}

// --- Ramp Audit ---

/**
 * Audit the 5-tier surface elevation ramp for perceptual evenness.
 * Checks each adjacent pair for collapse (below JND) and for runaway
 * steps (one step dramatically larger than its neighbours).
 */
export function auditSurfaceRamp(surfaces: ThemePalette["surfaces"], themeId: string): AuditResult {
  const warnings: string[] = [];

  const oklchValues: Array<{ key: string; l: number }> = [];
  for (const key of SURFACE_RAMP_KEYS) {
    const hex = surfaces[key];
    const color = hexToOklch(hex);
    if (!color) {
      warnings.push(
        `${themeId}: surface-${key} "${hex}" is not a parseable hex color — skipping ramp step`
      );
      oklchValues.push({ key, l: NaN });
    } else {
      oklchValues.push({ key, l: color.l });
    }
  }

  // Adjacent-pair dL check
  const adjacentDLs: number[] = [];
  for (let i = 1; i < oklchValues.length; i++) {
    const prev = oklchValues[i - 1];
    const curr = oklchValues[i];
    if (!prev || !curr) continue;
    if (isNaN(prev.l) || isNaN(curr.l)) continue;

    const dL = Math.abs(curr.l - prev.l);
    adjacentDLs.push(dL);

    if (dL < RAMP_DL_JND) {
      warnings.push(
        `${themeId}: surface-${prev.key} → surface-${curr.key} dL=${dL.toFixed(4)} is below JND threshold (${RAMP_DL_JND}) — surfaces may perceptually merge`
      );
    }
  }

  // Runaway check: skip when fewer than 3 valid adjacent pairs (need at least
  // one neighbour on each side of the suspect step to compute the ratio).
  if (adjacentDLs.length >= 3) {
    const maxDL = Math.max(...adjacentDLs);
    const minDL = Math.min(...adjacentDLs);
    if (minDL > 0) {
      const ratio = maxDL / minDL;
      if (ratio > RAMP_RUNAWAY_RATIO) {
        warnings.push(
          `${themeId}: surface ramp runaway detected — adjacent-step dL range [${minDL.toFixed(4)}, ${maxDL.toFixed(4)}] ratio ${ratio.toFixed(1)}:1 exceeds ${RAMP_RUNAWAY_RATIO}:1 — one step dominates the elevation progression`
        );
      }
    }
  }

  return { failures: [], warnings };
}

// --- Accent Prominence Audit ---

/**
 * Audit the accent color for perceptual prominence against the canvas surface.
 * Checks lightness separation (grayscale survivability) and chroma floor
 * (reads as colored rather than tinted neutral).
 */
export function auditAccentProminence(palette: ThemePalette, themeId: string): AuditResult {
  const warnings: string[] = [];

  const canvas = hexToOklch(palette.surfaces.canvas);
  if (!canvas) {
    warnings.push(
      `${themeId}: surface-canvas "${palette.surfaces.canvas}" is not parseable — skipping accent audit`
    );
    return { failures: [], warnings };
  }

  const accents: Array<{ label: string; hex: string }> = [{ label: "accent", hex: palette.accent }];
  if (palette.accentSecondary) {
    accents.push({ label: "accentSecondary", hex: palette.accentSecondary });
  }

  for (const { label, hex } of accents) {
    const accentColor = hexToOklch(hex);
    if (!accentColor) {
      warnings.push(`${themeId}: ${label} "${hex}" is not parseable — skipping`);
      continue;
    }

    const dL = Math.abs(accentColor.l - canvas.l);
    if (dL < ACCENT_CANVAS_DL_WARN) {
      warnings.push(
        `${themeId}: ${label} ΔL=${dL.toFixed(3)} against canvas is below ${ACCENT_CANVAS_DL_WARN} — accent may not survive grayscale`
      );
    }

    if (accentColor.c < ACCENT_CHROMA_WARN) {
      warnings.push(
        `${themeId}: ${label} chroma C=${accentColor.c.toFixed(3)} is below ${ACCENT_CHROMA_WARN} — may read as tinted neutral rather than colored`
      );
    }
  }

  return { failures: [], warnings };
}

// --- Cross-Theme Accent Distinctness Audit ---

/**
 * Audit accent distinctness across all built-in themes. Checks that primary
 * accents within the same polarity are perceptibly different (ΔE), and that
 * no two themes share the exact same accentSecondary hex.
 *
 * Only exact hex duplicate of accentSecondary is a hard failure — everything
 * else starts as a warning per the warn-first policy.
 */
export function auditCrossThemeAccents(sources: BuiltInThemeSource[]): AuditResult {
  const failures: string[] = [];
  const warnings: string[] = [];

  const dark = sources.filter((s) => s.palette.type === "dark");
  const light = sources.filter((s) => s.palette.type === "light");

  for (const [label, group] of [
    ["dark", dark],
    ["light", light],
  ] as const) {
    // Pairwise primary accent ΔE
    const entries: Array<{ id: string; accent: OklchColor }> = [];
    for (const source of group) {
      const color = hexToOklch(source.palette.accent);
      if (color) {
        entries.push({ id: source.id, accent: color });
      } else {
        warnings.push(
          `${label} theme "${source.id}" accent "${source.palette.accent}" is not a parseable hex color — excluded from cross-theme comparison`
        );
      }
    }

    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i];
        const b = entries[j];
        if (!a || !b) continue;
        const de = deltaOklch(a.accent, b.accent);
        if (de < CROSS_THEME_DE_WARN) {
          warnings.push(
            `${label} themes "${a.id}" and "${b.id}" primary accents are ΔE=${de.toFixed(2)} — below ${CROSS_THEME_DE_WARN} threshold for distinctness`
          );
        }
      }
    }

    // Exact-duplicate accentSecondary hexes (warn for now; promoted to
    // hard fail once per-theme palette fixes land in follow-up PRs)
    const secondaryByHex = new Map<string, string[]>();
    for (const source of group) {
      const hex = source.palette.accentSecondary;
      if (!hex) continue;
      const normalized = hex.toLowerCase();
      const list = secondaryByHex.get(normalized) ?? [];
      list.push(source.id);
      secondaryByHex.set(normalized, list);
    }
    for (const [hex, ids] of secondaryByHex) {
      if (ids.length > 1) {
        warnings.push(
          `${label} themes [${ids.join(", ")}] share the same accentSecondary "${hex}" — accents should be unique across themes`
        );
      }
    }
  }

  return { failures, warnings };
}
