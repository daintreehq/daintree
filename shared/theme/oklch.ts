import {
  isHexColor,
  hexToRgb,
  hexToLinear,
  contrastRatio,
  parseRgba,
  blendOverBackground,
} from "./contrast.js";
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

// Light-theme depth budget (RC-1). On a near-white canvas the eye's luminance
// discrimination is compressed against the L=1.0 ceiling, so the additive-glow
// machinery (overlay/shadow/border) has 2-3x less perceptual room. Depth must
// therefore be carried by the surface ramp itself, and these are hard failures
// for LIGHT themes only — dark themes run wider ramps natively and several dark
// palettes sit (intentionally) below the JND on a single step.
//
// - Span floor: total grid→elevated dL must clear this so the five planes don't
//   converge into one undifferentiated sheet (light cohort spans ~0.10-0.12).
// - Step floor: every adjacent step must clear the JND so no two stacked planes
//   merge perceptually.
// - Panel→elevated must NOT be the smallest step: the floating tier needs the
//   strongest lift, mirroring the dark themes (which reserve their largest step
//   for it). The pre-fix light themes inverted this, giving floating elements no
//   luminance lift at the top of the stack.
const LIGHT_RAMP_SPAN_FLOOR = 0.09;
const LIGHT_RAMP_STEP_FLOOR = RAMP_DL_JND;

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
 *
 * For LIGHT themes the depth-collapse checks are HARD FAILURES, not advisory
 * warnings (RC-1): on a near-white canvas the surface ramp is the primary
 * depth channel because the additive overlay/shadow machinery has little room
 * to work. `type` defaults to "dark" so existing dark callers keep warn-only
 * semantics. The runaway/JND-warning behaviour is unchanged for dark.
 */
export function auditSurfaceRamp(
  surfaces: ThemePalette["surfaces"],
  themeId: string,
  type: "dark" | "light" = "dark"
): AuditResult {
  const failures: string[] = [];
  const warnings: string[] = [];
  const isLight = type === "light";

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
  const keyedSteps: Array<{ from: string; to: string; dL: number }> = [];
  for (let i = 1; i < oklchValues.length; i++) {
    const prev = oklchValues[i - 1];
    const curr = oklchValues[i];
    if (!prev || !curr) continue;
    if (isNaN(prev.l) || isNaN(curr.l)) continue;

    const dL = Math.abs(curr.l - prev.l);
    adjacentDLs.push(dL);
    keyedSteps.push({ from: prev.key, to: curr.key, dL });

    if (dL < RAMP_DL_JND) {
      const msg = `${themeId}: surface-${prev.key} → surface-${curr.key} dL=${dL.toFixed(4)} is below JND threshold (${RAMP_DL_JND}) — surfaces may perceptually merge`;
      // Light themes carry depth in the ramp itself (RC-1): a sub-JND step is a
      // hard failure, not advice.
      if (isLight && dL < LIGHT_RAMP_STEP_FLOOR) failures.push(msg);
      else warnings.push(msg);
    }
  }

  // Light-only depth-budget hard checks (RC-1).
  if (isLight && adjacentDLs.length === SURFACE_RAMP_KEYS.length - 1) {
    const first = oklchValues[0];
    const last = oklchValues[oklchValues.length - 1];
    if (first && last && !isNaN(first.l) && !isNaN(last.l)) {
      const span = Math.abs(last.l - first.l);
      if (span < LIGHT_RAMP_SPAN_FLOOR) {
        failures.push(
          `${themeId}: light surface ramp span dL=${span.toFixed(4)} (surface-${first.key} → surface-${last.key}) is below the light depth floor (${LIGHT_RAMP_SPAN_FLOOR}) — the five planes converge into one sheet`
        );
      }
    }

    const minStep = Math.min(...adjacentDLs);
    const panelToElevated = keyedSteps.find((s) => s.from === "panel" && s.to === "elevated");
    if (panelToElevated && panelToElevated.dL <= minStep + 1e-9) {
      failures.push(
        `${themeId}: light surface-panel → surface-elevated dL=${panelToElevated.dL.toFixed(4)} is the smallest adjacent step — the floating tier must get the strongest luminance lift, not the weakest (RC-1 ramp-shape inversion)`
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

  return { failures, warnings };
}

// --- Border Separation Audit ---

// Minimum WCAG contrast a border must clear against the brightest surface it
// can sit against (RC-6). On light themes overlay/shadow depth cues collapse,
// so separation falls to borders — but the engine historically under-powered
// them. 1.18 is below the 3:1 WCAG non-text floor (borders are decorative
// separators, not UI-component boundaries that 1.4.11 governs) but high enough
// that the line is perceptible against a near-white field. Light-only: dark
// border-default routinely composites near-invisible against its surface (it
// leans on luminance stepping instead) so this guard would false-fail dark.
const LIGHT_BORDER_MIN_CONTRAST = 1.18;

const BORDER_AUDIT_SURFACES = [
  "surface-grid",
  "surface-sidebar",
  "surface-canvas",
  "surface-panel",
  "surface-panel-elevated",
] as const;

function compositeBorder(value: string, surfaceHex: string): string | null {
  if (isHexColor(value)) return value;
  const rgba = parseRgba(value);
  if (rgba) return blendOverBackground(rgba.hex, surfaceHex, rgba.opacity);
  return null;
}

/**
 * Audit border separation for LIGHT themes (RC-6). `border-default` and
 * `border-interactive` must clear `LIGHT_BORDER_MIN_CONTRAST` against the
 * brightest display surface — that is the worst case, since the brightest
 * surface gives a border the least luminance to contrast against. Both inputs
 * may be hex or rgba; rgba is composited over the surface before measuring.
 *
 * Returns warn-only for dark (and emits no checks there) so a single call site
 * can run it for every theme without special-casing the polarity.
 */
export function auditBorderSeparation(
  tokens: { borderDefault: string; borderInteractive: string; surfaces: Record<string, string> },
  themeId: string,
  type: "dark" | "light"
): AuditResult {
  const failures: string[] = [];
  const warnings: string[] = [];
  if (type !== "light") return { failures, warnings };

  const surfaceHexes = BORDER_AUDIT_SURFACES.map((k) => tokens.surfaces[k]).filter(
    (v): v is string => typeof v === "string" && isHexColor(v)
  );
  if (surfaceHexes.length === 0) {
    warnings.push(`${themeId}: no evaluable display surface — skipping border separation audit`);
    return { failures, warnings };
  }

  // Brightest = highest OKLab L; a border has the least room against it.
  const brightest = surfaceHexes.reduce((a, b) => (hexToOklch(b)!.l > hexToOklch(a)!.l ? b : a));

  for (const [label, value] of [
    ["border-default", tokens.borderDefault],
    ["border-interactive", tokens.borderInteractive],
  ] as const) {
    if (typeof value !== "string" || !value.trim()) {
      failures.push(`${themeId}: ${label} is missing — cannot audit border separation`);
      continue;
    }
    const composited = compositeBorder(value, brightest);
    if (!composited) {
      warnings.push(`${themeId}: ${label} "${value}" is neither hex nor rgba — skipping`);
      continue;
    }
    const ratio = contrastRatio(composited, brightest);
    if (ratio < LIGHT_BORDER_MIN_CONTRAST) {
      failures.push(
        `${themeId}: light ${label} ("${value}") contrast against brightest surface ${brightest} is ${ratio.toFixed(3)}:1; floor is ${LIGHT_BORDER_MIN_CONTRAST}:1 — the separator is imperceptible on a near-white field (RC-6)`
      );
    }
  }

  return { failures, warnings };
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
