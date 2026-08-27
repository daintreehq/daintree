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
// Report-only. WCAG ratio is the accessibility contract; APCA Lc ranks
// perceived separation and is a scale, not a floor — so nothing here emits a
// pass/fail verdict, and this script is deliberately not part of `npm run
// check`. It exists to make the follow-up an evidence-led decision.
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
  isHexColor,
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

export type Measurement = {
  theme: string;
  surface: AppThemeTokenKey;
  role: AppThemeTokenKey;
  /** Composited foreground actually painted, after any token alpha is resolved. */
  hex: string;
  lc: number;
  ratio: number;
};

export type Sample = { theme: string; surface: AppThemeTokenKey; lc: number };

export type Spread = {
  /** Weakest perceived separation anywhere — the number a band decision lives or dies on. */
  min: number;
  median: number;
  max: number;
  worst: Sample;
};

export type StepBand = {
  step: number;
  ramp: Spread;
  /** Role whose Lc spread sits closest to this step's, by median. */
  nearestRole: AppThemeTokenKey;
  /** How far the floor moves if this step becomes `nearestRole`. Negative = worse. */
  floorDelta: number;
};

export type Report = {
  roles: Record<string, Spread>;
  bands: StepBand[];
  measurements: Measurement[];
};

/** Resolve a token to the hex actually painted on `surfaceHex`, compositing any alpha. */
export function resolveOnSurface(value: string, surfaceHex: string): string | null {
  if (isHexColor(value)) return value;
  const rgba = parseRgba(value);
  if (rgba) return blendOverBackground(rgba.hex, surfaceHex, rgba.opacity);
  // color-mix() and other computed forms need a browser to resolve; a theme that
  // reaches one for a text role is a finding in itself, so surface it rather
  // than guessing a value.
  return null;
}

function measure(
  theme: string,
  surface: AppThemeTokenKey,
  role: AppThemeTokenKey,
  fg: string,
  bg: string
): Measurement {
  return { theme, surface, role, hex: fg, lc: apcaLc(fg, bg), ratio: contrastRatio(fg, bg) };
}

// `apcaLc` reports magnitude, not signed Lc — which is the point: it lets a dark
// theme's separation be compared directly against a light theme's.
function spread(samples: Sample[]): Spread {
  const sorted = samples.map((s) => s.lc).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
  const worst = samples.reduce((a, b) => (a.lc <= b.lc ? a : b));
  return { min: sorted[0]!, median, max: sorted.at(-1)!, worst };
}

export function buildReport(schemes: AppColorScheme[] = BUILT_IN_APP_SCHEMES): Report {
  const measurements: Measurement[] = [];
  const roleSamples = new Map<AppThemeTokenKey, Sample[]>();
  const stepSamples = new Map<number, Sample[]>();

  function push<K>(map: Map<K, Sample[]>, key: K, sample: Sample) {
    const existing = map.get(key);
    if (existing) existing.push(sample);
    else map.set(key, [sample]);
  }

  for (const scheme of [...schemes].sort((a, b) => a.id.localeCompare(b.id))) {
    for (const surface of DISPLAY_SURFACES) {
      const bg = scheme.tokens[surface];
      if (!bg || !isHexColor(bg)) continue;

      for (const role of TEXT_ROLES) {
        const raw = scheme.tokens[role];
        const fg = raw ? resolveOnSurface(raw, bg) : null;
        if (!fg) continue;
        const m = measure(scheme.id, surface, role, fg, bg);
        measurements.push(m);
        push(roleSamples, role, { theme: scheme.id, surface, lc: m.lc });
      }

      // The ramp dims `text-primary`, so it is the only role the steps composite.
      const primary = scheme.tokens["text-primary"];
      const primaryHex = primary ? resolveOnSurface(primary, bg) : null;
      if (!primaryHex) continue;
      for (const step of RAMP_STEPS) {
        const fg = blendOverBackground(primaryHex, bg, step / 100);
        push(stepSamples, step, { theme: scheme.id, surface, lc: apcaLc(fg, bg) });
      }
    }
  }

  const roles: Record<string, Spread> = {};
  for (const [role, samples] of roleSamples) roles[role] = spread(samples);

  const bands: StepBand[] = RAMP_STEPS.map((step) => {
    const ramp = spread(stepSamples.get(step) ?? []);
    const nearestRole = TEXT_ROLES.filter((r) => roles[r]).reduce((best, role) =>
      Math.abs(roles[role]!.median - ramp.median) < Math.abs(roles[best]!.median - ramp.median)
        ? role
        : best
    );
    return {
      step,
      ramp,
      nearestRole,
      floorDelta: roles[nearestRole]!.min - ramp.min,
    };
  });

  return { roles, bands, measurements };
}

const n = (value: number, width = 6) => value.toFixed(1).padStart(width);

export function formatReport(report: Report): string {
  const lines: string[] = [];

  lines.push("Solid text tokens — APCA Lc magnitude across every theme x display surface");
  lines.push("  role                  min  median     max   weakest at");
  for (const role of TEXT_ROLES) {
    const s = report.roles[role];
    if (!s) continue;
    lines.push(
      `  ${role.padEnd(18)}${n(s.min)}${n(s.median)}${n(s.max)}   ${s.worst.theme}/${s.worst.surface}`
    );
  }

  lines.push("");
  lines.push("Opacity ramp — what text-daintree-text/NN actually renders at");
  lines.push("  step     min  median     max   nearest role      floor delta   weakest at");
  for (const band of report.bands) {
    const sign = band.floorDelta >= 0 ? "+" : "";
    lines.push(
      `  /${String(band.step).padEnd(4)}${n(band.ramp.min)}${n(band.ramp.median)}${n(band.ramp.max)}   ` +
        `${band.nearestRole.padEnd(18)}${(sign + band.floorDelta.toFixed(1)).padStart(6)}   ` +
        `${band.ramp.worst.theme}/${band.ramp.worst.surface}`
    );
  }

  lines.push("");
  lines.push("floor delta = nearest role's weakest Lc minus the step's weakest Lc.");
  lines.push("Negative means adopting that role lowers the worst case somewhere.");
  lines.push("Lc ranks separation; WCAG ratio remains the accessibility contract.");

  return lines.join("\n");
}

export function formatTheme(report: Report, themeId: string): string {
  const rows = report.measurements.filter((m) => m.theme === themeId);
  if (rows.length === 0) return `no measurements for theme "${themeId}"`;

  const lines = [
    `${themeId} — solid text tokens, composited on each display surface`,
    "  surface                 role                  hex          Lc    ratio",
  ];
  for (const surface of DISPLAY_SURFACES) {
    const onSurface = rows.filter((m) => m.surface === surface);
    if (onSurface.length === 0) continue;
    onSurface.forEach((m, i) => {
      lines.push(
        `  ${(i === 0 ? surface : "").padEnd(22)}${m.role.padEnd(20)}` +
          `${m.hex.padEnd(10)}${n(m.lc)}${n(m.ratio, 9)}`
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
