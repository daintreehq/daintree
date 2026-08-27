#!/usr/bin/env tsx
// Measures what the `text-daintree-text/NN` opacity ramp actually renders at,
// against the four solid text tokens that would replace it, on every built-in
// theme and display surface (#12031).
//
// The ramp is 2.1k sites expressing a text hierarchy through alpha rather than
// tokens. Retiring it means picking a real token per opacity band, and the band
// boundaries are only defensible against measured numbers: `text-placeholder`
// is itself alpha-derived on 7 of 15 themes, and `text-muted` carries no dark
// contrast floor at all (`getThemeContrastWarnings` only guards it on light).
//
// Report-only, and deliberately outside `npm run check`. WCAG ratio is the
// accessibility contract and APCA Lc ranks perceived separation — the report
// gives both and picks neither, because "nearest role" is a similarity
// measure, not a recommendation. A band whose floor delta is negative lowers
// the worst case somewhere, and that is a decision for #12003 to make site by
// site rather than a verdict this script can issue.
//
//   npm run theme:text-contrast              band summary across all themes
//   npm run theme:text-contrast -- --theme daintree   per-surface detail
//   npm run theme:text-contrast -- --json    machine-readable

import {
  BUILT_IN_APP_SCHEMES,
  DISPLAY_SURFACES,
  apcaLc,
  blendOverBackground,
  contrastRatio,
  parseRgba,
} from "../shared/theme/index.js";
import type { AppColorScheme, AppThemeTokenKey } from "../shared/theme/index.js";

export const TEXT_ROLES: AppThemeTokenKey[] = [
  "text-primary",
  "text-secondary",
  "text-muted",
  "text-placeholder",
];

export const RAMP_STEPS = [20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90] as const;

export type Sample = {
  theme: string;
  surface: AppThemeTokenKey;
  lc: number;
  ratio: number;
};

export type Measurement = Sample & {
  role: AppThemeTokenKey;
  /** Composited foreground actually painted, after any token alpha is resolved. */
  hex: string;
};

export type Spread = {
  /** Weakest perceived separation anywhere — the number a band decision lives or dies on. */
  lcMin: number;
  lcMedian: number;
  lcMax: number;
  ratioMin: number;
  /** Where lcMin occurs. */
  worst: Sample;
};

export type StepBand = {
  step: number;
  ramp: Spread;
  /** Role whose Lc spread sits closest to this step's, by median. Similarity, not advice. */
  nearestRole: AppThemeTokenKey;
  /** How far each floor moves if this step becomes `nearestRole`. Negative = worse. */
  lcFloorDelta: number;
  ratioFloorDelta: number;
};

export type Unresolved = {
  theme: string;
  surface: AppThemeTokenKey;
  token: AppThemeTokenKey;
  value: string;
};

export type Report = {
  roles: Record<string, Spread>;
  bands: StepBand[];
  measurements: Measurement[];
  /** Tokens no static resolver can evaluate. Reported rather than skipped in silence. */
  unresolved: Unresolved[];
};

const OPAQUE_HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const ALPHA_HEX = /^#(?:([0-9a-f]{3})([0-9a-f])|([0-9a-f]{6})([0-9a-f]{2}))$/i;

/**
 * Resolve a token to the hex actually painted on `surfaceHex`, compositing any
 * alpha the token carries.
 *
 * Deliberately does not lean on `isHexColor`: that accepts `#RGBA`/`#RRGGBBAA`
 * and the contrast helpers drop the alpha bytes, so an 8-digit token would be
 * measured as fully opaque and read far stronger than it paints.
 */
export function resolveOnSurface(value: string, surfaceHex: string): string | null {
  const trimmed = value.trim();
  if (OPAQUE_HEX.test(trimmed)) return trimmed;

  const hexAlpha = trimmed.match(ALPHA_HEX);
  if (hexAlpha) {
    const short = hexAlpha[1] !== undefined;
    const rgb = short
      ? `#${hexAlpha[1]!
          .split("")
          .map((c) => `${c}${c}`)
          .join("")}`
      : `#${hexAlpha[3]!}`;
    const alphaHex = short ? `${hexAlpha[2]!}${hexAlpha[2]!}` : hexAlpha[4]!;
    return blendOverBackground(rgb, surfaceHex, parseInt(alphaHex, 16) / 255);
  }

  const rgba = parseRgba(trimmed);
  if (rgba) return blendOverBackground(rgba.hex, surfaceHex, rgba.opacity);

  // color-mix(), oklch() and friends need a browser to evaluate. A theme that
  // reaches one for a text role or display surface is itself a finding, so the
  // caller records it instead of dropping the sample quietly.
  return null;
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

// `apcaLc` reports magnitude, not signed Lc — which is the point: it lets a dark
// theme's separation be compared directly against a light theme's.
function spread(samples: Sample[]): Spread {
  const lc = samples.map((s) => s.lc).sort((a, b) => a - b);
  const ratios = samples.map((s) => s.ratio).sort((a, b) => a - b);
  return {
    lcMin: lc[0]!,
    lcMedian: median(lc),
    lcMax: lc.at(-1)!,
    ratioMin: ratios[0]!,
    worst: samples.reduce((a, b) => (a.lc <= b.lc ? a : b)),
  };
}

export function buildReport(schemes: AppColorScheme[] = BUILT_IN_APP_SCHEMES): Report {
  const measurements: Measurement[] = [];
  const unresolved: Unresolved[] = [];
  const roleSamples = new Map<AppThemeTokenKey, Sample[]>();
  const stepSamples = new Map<number, Sample[]>();

  function push<K>(map: Map<K, Sample[]>, key: K, sample: Sample) {
    const existing = map.get(key);
    if (existing) existing.push(sample);
    else map.set(key, [sample]);
  }

  const sample = (theme: string, surface: AppThemeTokenKey, fg: string, bg: string): Sample => ({
    theme,
    surface,
    lc: apcaLc(fg, bg),
    ratio: contrastRatio(fg, bg),
  });

  for (const scheme of [...schemes].sort((a, b) => a.id.localeCompare(b.id))) {
    for (const surface of DISPLAY_SURFACES) {
      const rawSurface = scheme.tokens[surface];
      // A surface must be opaque: it is what everything else composites onto.
      const bg = rawSurface && OPAQUE_HEX.test(rawSurface.trim()) ? rawSurface.trim() : null;
      if (!bg) {
        unresolved.push({
          theme: scheme.id,
          surface,
          token: surface,
          value: rawSurface ?? "(undeclared)",
        });
        continue;
      }

      for (const role of TEXT_ROLES) {
        const raw = scheme.tokens[role];
        const fg = raw ? resolveOnSurface(raw, bg) : null;
        if (!fg) {
          unresolved.push({
            theme: scheme.id,
            surface,
            token: role,
            value: raw ?? "(undeclared)",
          });
          continue;
        }
        const s = sample(scheme.id, surface, fg, bg);
        measurements.push({ ...s, role, hex: fg });
        push(roleSamples, role, s);
      }

      // The ramp dims `text-primary`, so it is the only role the steps composite.
      const primary = scheme.tokens["text-primary"];
      const primaryHex = primary ? resolveOnSurface(primary, bg) : null;
      if (!primaryHex) continue;
      for (const step of RAMP_STEPS) {
        const fg = blendOverBackground(primaryHex, bg, step / 100);
        push(stepSamples, step, sample(scheme.id, surface, fg, bg));
      }
    }
  }

  const roles: Record<string, Spread> = {};
  for (const [role, samples] of roleSamples) roles[role] = spread(samples);

  const bands: StepBand[] = RAMP_STEPS.map((step) => {
    const ramp = spread(stepSamples.get(step) ?? []);
    const candidates = TEXT_ROLES.filter((role) => roles[role]);
    const nearestRole = candidates.reduce((best, role) =>
      Math.abs(roles[role]!.lcMedian - ramp.lcMedian) <
      Math.abs(roles[best]!.lcMedian - ramp.lcMedian)
        ? role
        : best
    );
    return {
      step,
      ramp,
      nearestRole,
      lcFloorDelta: roles[nearestRole]!.lcMin - ramp.lcMin,
      ratioFloorDelta: roles[nearestRole]!.ratioMin - ramp.ratioMin,
    };
  });

  return { roles, bands, measurements, unresolved };
}

const n = (value: number, width = 7) => value.toFixed(1).padStart(width);
const signed = (value: number, width = 7) =>
  `${value >= 0 ? "+" : ""}${value.toFixed(1)}`.padStart(width);

export function formatReport(report: Report): string {
  const lines: string[] = [];

  lines.push("Solid text tokens — across every theme x display surface");
  lines.push("  role                 Lc min  Lc med  Lc max  WCAG min   weakest at");
  for (const role of TEXT_ROLES) {
    const s = report.roles[role];
    if (!s) continue;
    lines.push(
      `  ${role.padEnd(18)}${n(s.lcMin)}${n(s.lcMedian)}${n(s.lcMax)}${n(s.ratioMin, 10)}   ` +
        `${s.worst.theme}/${s.worst.surface}`
    );
  }

  lines.push("");
  lines.push("Opacity ramp — what text-daintree-text/NN actually renders at");
  lines.push("  step     Lc min  Lc med  Lc max  WCAG min   weakest at");
  for (const band of report.bands) {
    lines.push(
      `  /${String(band.step).padEnd(4)}${n(band.ramp.lcMin)}${n(band.ramp.lcMedian)}` +
        `${n(band.ramp.lcMax)}${n(band.ramp.ratioMin, 10)}   ` +
        `${band.ramp.worst.theme}/${band.ramp.worst.surface}`
    );
  }

  lines.push("");
  lines.push("Nearest solid role by median Lc — a similarity, NOT a recommendation");
  lines.push("  step   nearest role       floor delta Lc   floor delta WCAG");
  for (const band of report.bands) {
    lines.push(
      `  /${String(band.step).padEnd(4)} ${band.nearestRole.padEnd(20)}` +
        `${signed(band.lcFloorDelta, 11)}${signed(band.ratioFloorDelta, 19)}`
    );
  }

  lines.push("");
  lines.push("Floor delta = the role's weakest measurement minus this step's weakest.");
  lines.push("Negative means adopting that role lowers the worst case on some theme.");
  lines.push("Ranking by floor instead would pick text-primary almost everywhere, so");
  lines.push("neither column decides a band on its own — #12003 owns the per-site call.");

  if (report.unresolved.length > 0) {
    lines.push("");
    lines.push(
      `Unresolved tokens (${report.unresolved.length}) — excluded from every number above`
    );
    for (const u of report.unresolved) {
      lines.push(`  ${u.theme}/${u.surface}  ${u.token} = ${u.value}`);
    }
  }

  return lines.join("\n");
}

export function formatTheme(report: Report, themeId: string): string {
  const rows = report.measurements.filter((m) => m.theme === themeId);
  if (rows.length === 0) return `no measurements for theme "${themeId}"`;

  const lines = [
    `${themeId} — solid text tokens, composited on each display surface`,
    "  surface                 role                  hex           Lc    WCAG",
  ];
  for (const surface of DISPLAY_SURFACES) {
    const onSurface = rows.filter((m) => m.surface === surface);
    onSurface.forEach((m, i) => {
      lines.push(
        `  ${(i === 0 ? surface : "").padEnd(22)}${m.role.padEnd(20)}` +
          `${m.hex.padEnd(10)}${n(m.lc)}${n(m.ratio, 8)}`
      );
    });
  }
  return lines.join("\n");
}

const invokedDirectly = process.argv[1]?.endsWith("theme-text-contrast.ts") === true;
if (invokedDirectly) {
  const report = buildReport();
  const themeFlag = process.argv.indexOf("--theme");
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else if (themeFlag !== -1) {
    console.log(formatTheme(report, process.argv[themeFlag + 1] ?? ""));
  } else {
    console.log(formatReport(report));
  }
}
