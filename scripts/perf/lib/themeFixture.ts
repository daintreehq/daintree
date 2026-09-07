import {
  APP_THEME_TOKEN_KEYS,
  BUILT_IN_APP_SCHEMES,
  EXTENSION_KEYS,
  apcaContrast,
  apcaLc,
  applyAccentOverrideToScheme,
  contrastRatio,
  deltaEOK,
  getAppThemeCssVariables,
  getAppThemeWarnings,
  getLightThemeMatrixWarnings,
  hexToRgbTriplet,
  normalizeAppColorScheme,
  parseRgba,
  validateImportedThemeData,
  type AppColorScheme,
  type AppThemeTokenKey,
  type AppThemeValidationWarning,
} from "../../../shared/theme/index.js";
import { hexToOklch, deltaOklch } from "../../../shared/theme/oklch.js";
import { isExtensionKeyRequired } from "../../../shared/theme/extensionRegistry.js";
import { BUILT_IN_THEME_SOURCES } from "../../../shared/theme/builtInThemes/index.js";
import type { BuiltInThemeSource } from "../../../shared/theme/builtInThemeSources.js";
import {
  applyAppThemeToRoot,
  applyColorVisionMode,
  RED_GREEN_OVERRIDES,
  BLUE_YELLOW_OVERRIDES,
  ALL_CVD_TOKENS,
} from "../../../src/theme/applyAppTheme";
import { parseAppThemeContent } from "../../../electron/utils/appThemeImporter";
import { AGENT_REGISTRY } from "../../../shared/config/agentRegistry";
import { BRAND_MARK_SURFACES, resolveBrandMarkInk } from "../../../src/lib/brandIcon";

/**
 * Theme-system fixture. Everything measured here is the real `shared/theme`
 * code driven through its exported entry points in a plain Node process.
 *
 * SCOPE LIMITS, stated once so no number here is read for more than it is:
 *
 * - **The built-in cohort is resolved at module evaluation.** `themes.ts` maps
 *   `BUILT_IN_THEME_SOURCES` through a module-private `createThemeFromSource`
 *   when `@shared/theme` is first imported, so that exact call is unreachable
 *   from a benchmark — it has already run. PERF-300 drives
 *   `normalizeAppColorScheme`, the exported resolver every plugin and custom
 *   theme takes, over the same 15 palettes. It shares `compilePaletteToTokens`
 *   and `createDaintreeTokens` with the built-in path and diverges in exactly
 *   one token (see `ACCENT_FOREGROUND_DIVERGES` below).
 * - **There is no CSSOM.** PERF-304 drives the real `applyAppThemeToRoot` /
 *   `applyColorVisionMode` against a Map-backed stand-in for `HTMLElement`, so
 *   the counts (variables written, stale variables removed, CVD tokens
 *   overridden) are real and the duration is a Map walk, not a style
 *   recalculation. Nothing here prices layout, paint or the compositor.
 * - **The oracles do their own colour maths.** `wcagRatio`, `srgbToLinear`,
 *   `neutralOklabL`, `compositeOver`, `oklabOf`, `apcaWeight` and `mixChannels`
 *   below are written here rather than imported, because grading `contrastRatio`
 *   with `contrastRatio` grades nothing — and neither does compositing a
 *   backdrop with the subject's own blend. Each is anchored against a value the
 *   subject does not contain: WCAG's 21:1 for white-on-black, APCA-W3's
 *   published 106.04 / -107.88 pair, and the identity that a neutral grey's
 *   OKLab L is the cube root of its linearised channel (the M1/M2 rows sum to 1
 *   for an achromatic input), which also fixes both OKLab distances exactly on
 *   any pair of greys.
 */

export const THEME_SOURCES: readonly BuiltInThemeSource[] = BUILT_IN_THEME_SOURCES;

/**
 * `normalizeAppColorScheme` re-derives `accent-foreground` with
 * `pickReadableForeground`, which picks pure black or white; the built-in path
 * lets `createDaintreeTokens` default it to the palette's `text-inverse`. A
 * real, documented divergence between two entry points, so the shipped-scheme
 * comparison excludes it rather than reporting 14 permanent misses.
 */
const ACCENT_FOREGROUND_DIVERGES: AppThemeTokenKey = "accent-foreground";

// --- Oracle-only colour maths -------------------------------------------------

function channels(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const wide =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => `${c}${c}`)
          .join("")
      : clean;
  return [
    parseInt(wide.slice(0, 2), 16),
    parseInt(wide.slice(2, 4), 16),
    parseInt(wide.slice(4, 6), 16),
  ];
}

/** IEC 61966-2-1 inverse transfer function, written out for the oracle. */
export function srgbToLinear(channel: number): number {
  const v = channel / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

// Memoized because the crossfade grid re-measures the same interpolated hexes
// across 1,620 resolutions; the value is a pure function of the string.
const luminanceCache = new Map<string, number>();

function oracleLuminance(hex: string): number {
  const cached = luminanceCache.get(hex);
  if (cached !== undefined) return cached;
  const [r, g, b] = channels(hex);
  const value = 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
  luminanceCache.set(hex, value);
  return value;
}

/** WCAG 2.x contrast ratio, derived here so it can grade the product's own. */
export function wcagRatio(foreground: string, background: string): number {
  const a = oracleLuminance(foreground);
  const b = oracleLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Straight sRGB alpha composite, the oracle's own copy of the blend. */
export function compositeOver(foreground: string, background: string, alpha: number): string {
  const fg = channels(foreground);
  const bg = channels(background);
  const mixed = fg.map((c, i) => Math.round(c * alpha + bg[i] * (1 - alpha)));
  return `#${mixed.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * OKLab lightness of a neutral grey. Both conversion matrices have rows summing
 * to 1, so an achromatic input collapses the whole chain to a cube root — an
 * identity no line of `oklch.ts` contains.
 */
export function neutralOklabL(channel: number): number {
  return Math.cbrt(srgbToLinear(channel));
}

export interface OracleOklab {
  L: number;
  a: number;
  b: number;
}

/**
 * OKLab coordinates, written out so `deltaEOK` and the brand-mark predicates
 * are graded by something neither `oklch.ts` nor `brandIcon.ts` contains.
 *
 * `neutralOklabL` is what anchors it: both matrices have rows summing to 1, so
 * an achromatic input must come back with L at the cube root and a, b at zero.
 */
export function oklabOf(hex: string): OracleOklab {
  const [r8, g8, b8] = channels(hex);
  const r = srgbToLinear(r8);
  const g = srgbToLinear(g8);
  const b = srgbToLinear(b8);
  const long = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const medium = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const short = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short,
    a: 1.9779984951 * long - 2.428592205 * medium + 0.4505937099 * short,
    b: 0.0259040371 * long + 0.7827717662 * medium - 0.808675766 * short,
  };
}

/** Euclidean OKLab distance — what a perceptual ΔE in this space is defined as. */
export function oklabDistance(from: string, to: string): number {
  const a = oklabOf(from);
  const b = oklabOf(to);
  return Math.hypot(a.L - b.L, a.a - b.a, a.b - b.b);
}

export function oklabChroma(hex: string): number {
  const { a, b } = oklabOf(hex);
  return Math.hypot(a, b);
}

/** Hue angle in degrees. Noise below `COLOURLESS_CHROMA`, so it is only read above it. */
export function oklabHue(hex: string): number {
  const { a, b } = oklabOf(hex);
  const degrees = (Math.atan2(b, a) * 180) / Math.PI;
  return degrees < 0 ? degrees + 360 : degrees;
}

/** Shortest angular separation between two hues, in degrees. */
export function hueSeparation(from: number, to: number): number {
  return Math.abs(((((from - to) % 360) + 540) % 360) - 180);
}

/** APCA's soft black clamp: it models screen flare, where WCAG models nothing. */
const APCA_BLACK_THRESHOLD = 0.022;

function screenLuminance(hex: string): number {
  const [r, g, b] = channels(hex);
  const y =
    (r / 255) ** 2.4 * 0.2126729 + (g / 255) ** 2.4 * 0.7151522 + (b / 255) ** 2.4 * 0.072175;
  return y > APCA_BLACK_THRESHOLD ? y : y + (APCA_BLACK_THRESHOLD - y) ** 1.414;
}

/**
 * APCA-W3 (`0.98G-4g`) perceived weight, unsigned, so the brand-mark predicate
 * is not grading `apca.ts` with `apca.ts`. Anchored on the published
 * 106.04 / 107.88 pair, which is a constant in neither implementation.
 */
export function apcaWeight(foreground: string, background: string): number {
  const text = screenLuminance(foreground);
  const backdrop = screenLuminance(background);
  if (Math.abs(backdrop - text) < 0.0005) return 0;
  const sapc =
    backdrop > text
      ? (backdrop ** 0.56 - text ** 0.57) * 1.14
      : (backdrop ** 0.65 - text ** 0.62) * 1.14;
  return Math.abs(sapc) < 0.1 ? 0 : (Math.abs(sapc) - 0.027) * 100;
}

/** Channel-wise sRGB interpolation — the space a CSS `color` transition crossfades in. */
export function mixChannels(from: string, to: string, ratio: number): string {
  const a = channels(from);
  const b = channels(to);
  return `#${a
    .map((c, i) =>
      Math.round(c + (b[i] - c) * ratio)
        .toString(16)
        .padStart(2, "0")
    )
    .join("")}`;
}

function isOpaqueHex(value: string | undefined): value is string {
  return typeof value === "string" && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value);
}

// --- PERF-300: cohort resolution ---------------------------------------------

export interface ResolvedTheme {
  source: BuiltInThemeSource;
  scheme: AppColorScheme;
  variables: Record<string, string>;
}

/**
 * Palette → 155 semantic tokens → CSS custom properties, for all 15 shipped
 * palettes. The timed subject; nothing here grades.
 */
export function resolveThemeCohort(): ResolvedTheme[] {
  const resolved: ResolvedTheme[] = [];
  for (const source of THEME_SOURCES) {
    const scheme = normalizeAppColorScheme({
      id: source.id,
      name: source.name,
      type: source.type,
      palette: source.palette,
      tokens: source.tokens as Record<string, unknown> | undefined,
      extensions: source.extensions,
    });
    resolved.push({ source, scheme, variables: getAppThemeCssVariables(scheme) });
  }
  return resolved;
}

/**
 * Grades a resolution against the palette it came from, not against itself.
 *
 * Four independent readings, chosen so the three cheap wrong answers all score:
 * a resolver that returns its input has neither the token keys nor the derived
 * values; one that returns a constant fails the palette echo; one that copies
 * the accent everywhere fails the alpha derivation.
 */
export function themeResolutionMisses(resolved: ResolvedTheme[]): number {
  let misses = 0;
  if (resolved.length !== THEME_SOURCES.length) return THEME_SOURCES.length;

  for (const { source, scheme, variables } of resolved) {
    const palette = source.palette;
    const overrides = (source.tokens ?? {}) as Record<string, unknown>;

    // 1. Completeness: every declared token key present and non-empty.
    for (const key of APP_THEME_TOKEN_KEYS) {
      const value = scheme.tokens[key];
      if (typeof value !== "string" || !value.trim()) misses += 1;
    }

    // 2. Palette echo: the tokens that are the palette, verbatim.
    const echoes: Array<[AppThemeTokenKey, string]> = [
      ["surface-canvas", palette.surfaces.canvas],
      ["surface-panel", palette.surfaces.panel],
      ["surface-sidebar", palette.surfaces.sidebar],
      ["text-primary", palette.text.primary],
      ["accent-primary", palette.accent],
      ["status-danger", palette.status.danger],
    ];
    for (const [key, expected] of echoes) {
      if (key in overrides) continue;
      if (scheme.tokens[key] !== expected) misses += 1;
    }

    // 3. Derivation: the accent wash is the accent at a fixed alpha, computed
    //    here from the palette. A resolver that echoed the accent scores.
    if (!("accent-soft" in overrides) && !("accent-primary" in overrides)) {
      const expected = `rgba(${hexToRgbTriplet(palette.accent)}, 0.18)`;
      if (scheme.tokens["accent-soft"] !== expected) misses += 1;
    }
    if (!("accent-rgb" in overrides) && isOpaqueHex(palette.accent)) {
      if (scheme.tokens["accent-rgb"] !== hexToRgbTriplet(palette.accent)) misses += 1;
    }

    // 4. CSS surface: every token becomes a `--theme-*` variable, the polarity
    //    is published, and every extension key this polarity REQUIRES is there.
    for (const key of APP_THEME_TOKEN_KEYS) {
      if (typeof variables[`--theme-${key}`] !== "string") misses += 1;
    }
    if (variables["--theme-color-mode"] !== source.type) misses += 1;
    for (const key of EXTENSION_KEYS) {
      if (isExtensionKeyRequired(key, source.type) && typeof variables[`--${key}`] !== "string") {
        misses += 1;
      }
    }

    // 5. Agreement with the cohort the app itself resolved at module load.
    const shipped = BUILT_IN_APP_SCHEMES.find((s) => s.id === source.id);
    if (!shipped) {
      misses += 1;
      continue;
    }
    for (const key of APP_THEME_TOKEN_KEYS) {
      if (key === ACCENT_FOREGROUND_DIVERGES) continue;
      if (scheme.tokens[key] !== shipped.tokens[key]) misses += 1;
    }
  }
  return misses;
}

export function countCssVariables(resolved: ResolvedTheme[]): number {
  let total = 0;
  for (const { variables } of resolved) total += Object.keys(variables).length;
  return total;
}

// --- PERF-301: contrast / APCA audit -----------------------------------------

/**
 * A theme whose text sits one JND from every surface it is painted on
 * (#808080 on #7f7f7f is ~1.01:1). Built once, outside every timed bracket;
 * the audit must report it, and an audit that reports nothing is the fastest
 * audit there is.
 */
export function createPlantedDefectScheme(): AppColorScheme {
  const base = BUILT_IN_APP_SCHEMES[0]!;
  return {
    ...base,
    id: "perf-planted-flat",
    name: "Planted Flat",
    tokens: {
      ...base.tokens,
      "surface-grid": "#7f7f7f",
      "surface-sidebar": "#7f7f7f",
      "surface-canvas": "#7f7f7f",
      "surface-panel": "#7f7f7f",
      "surface-panel-elevated": "#7f7f7f",
      "text-primary": "#808080",
      "text-secondary": "#808080",
      "text-muted": "#808080",
      "accent-primary": "#808080",
    },
  };
}

/** A hex no shipped palette uses, so the override path really re-derives. */
export const FOREIGN_ACCENT = "#7c5cff";

export interface AuditSweep {
  shippedWarnings: AppThemeValidationWarning[][];
  lightMatrixWarnings: number;
  accentOverrideWarnings: number;
  plantedWarnings: AppThemeValidationWarning[];
}

/**
 * The sweep `ThemeBrowser` runs whenever the accent override changes: every
 * scheme audited, then every scheme audited again through
 * `applyAccentOverrideToScheme`. The planted theme rides along so the failing
 * direction is exercised on the same pass as the passing one.
 */
export function runAuditSweep(planted: AppColorScheme): AuditSweep {
  const shippedWarnings: AppThemeValidationWarning[][] = [];
  let lightMatrixWarnings = 0;
  let accentOverrideWarnings = 0;

  for (const scheme of BUILT_IN_APP_SCHEMES) {
    shippedWarnings.push(getAppThemeWarnings(scheme));
    if (scheme.type === "light") {
      lightMatrixWarnings += getLightThemeMatrixWarnings(scheme).length;
    }
    accentOverrideWarnings += getAppThemeWarnings(
      applyAccentOverrideToScheme(scheme, FOREIGN_ACCENT)
    ).length;
  }

  return {
    shippedWarnings,
    lightMatrixWarnings,
    accentOverrideWarnings,
    plantedWarnings: getAppThemeWarnings(planted),
  };
}

/**
 * Two-sided, plus the anchors that catch a constant.
 *
 * `contrastRatio` returning a fixed number passes "the shipped cohort is clean"
 * or "the planted theme is dirty" but never both, and fails the two anchor
 * values outright — neither 21 nor the APCA pair appears anywhere in
 * `contrast.ts` or `apca.ts`.
 */
export function auditSweepMisses(sweep: AuditSweep): number {
  let misses = 0;

  if (sweep.shippedWarnings.length !== BUILT_IN_APP_SCHEMES.length) misses += 1;
  for (const warnings of sweep.shippedWarnings) misses += warnings.length;

  const plantedLowContrast = sweep.plantedWarnings.filter((w) => w.kind === "low-contrast").length;
  if (plantedLowContrast === 0) misses += 1;

  // WCAG's fixed point, and the oracle's own arithmetic agreeing with it.
  if (Math.abs(contrastRatio("#ffffff", "#000000") - 21) > 1e-9) misses += 1;
  if (Math.abs(wcagRatio("#ffffff", "#000000") - 21) > 1e-9) misses += 1;
  for (const [fg, bg] of [
    ["#767676", "#ffffff"],
    ["#36ce94", "#101418"],
    ["#004e6b", "#f5f8fb"],
  ] as const) {
    if (Math.abs(contrastRatio(fg, bg) - wcagRatio(fg, bg)) > 1e-6) misses += 1;
  }

  // The published APCA-W3 reference pair.
  if (Math.abs(apcaContrast("#000000", "#ffffff") - 106.04) > 0.01) misses += 1;
  if (Math.abs(apcaContrast("#ffffff", "#000000") + 107.88) > 0.01) misses += 1;

  return misses;
}

// --- PERF-302: colour-maths corpus -------------------------------------------

export interface ColourCorpus {
  /** Every opaque hex token in the cohort, paired with its own theme's canvas. */
  pairs: ReadonlyArray<{ hex: string; canvas: string }>;
}

export function buildColourCorpus(): ColourCorpus {
  const pairs: Array<{ hex: string; canvas: string }> = [];
  for (const scheme of BUILT_IN_APP_SCHEMES) {
    const canvas = scheme.tokens["surface-canvas"];
    if (!isOpaqueHex(canvas)) continue;
    for (const key of APP_THEME_TOKEN_KEYS) {
      const value = scheme.tokens[key];
      if (isOpaqueHex(value)) pairs.push({ hex: value, canvas });
    }
  }
  return { pairs };
}

export interface ColourMathPass {
  conversions: number;
  /**
   * One accumulator per operation, not one checksum for all of them.
   *
   * A single aggregate cannot see a deleted term: drop `deltaEOK` from the loop
   * and the other four keep the total non-zero, so the scenario gets 23% faster
   * at zero misses. Per-operation sums make each call site its own evidence —
   * deleting one zeroes its own accumulator while its expectation stays
   * non-zero.
   */
  sums: {
    deltaOklch: number;
    contrast: number;
    apca: number;
    deltaEOK: number;
  };
}

/** Five operations over every colour a cohort audit has to consider. */
export function runColourMathPass(corpus: ColourCorpus): ColourMathPass {
  const sums = { deltaOklch: 0, contrast: 0, apca: 0, deltaEOK: 0 };
  let conversions = 0;
  for (const { hex, canvas } of corpus.pairs) {
    const a = hexToOklch(hex);
    const b = hexToOklch(canvas);
    conversions += 2;
    if (a && b) {
      sums.deltaOklch += deltaOklch(a, b);
      conversions += 1;
    }
    sums.contrast += contrastRatio(hex, canvas);
    sums.apca += apcaLc(hex, canvas);
    sums.deltaEOK += deltaEOK(hex, canvas);
    // Counted at the call, never as a literal. `conversions += 5` was a
    // constant that stayed correct after an operation was removed.
    conversions += 3;
  }
  return { conversions, sums };
}

/**
 * What each accumulator must hold, computed outside the timed bracket.
 *
 * Three come from the fixture's own maths and therefore catch a WRONG
 * implementation as well as a missing call. `deltaOklch` is recomputed by
 * calling the subject, because reproducing its exact OKLCh metric here would
 * be guessing at a formula rather than deriving one — that term catches a call
 * deleted from the loop, which is the defect this exists for, and the grey-pair
 * identity below is what catches the implementation being wrong.
 */
export function expectedColourMathSums(corpus: ColourCorpus): ColourMathPass["sums"] {
  const sums = { deltaOklch: 0, contrast: 0, apca: 0, deltaEOK: 0 };
  for (const { hex, canvas } of corpus.pairs) {
    const a = hexToOklch(hex);
    const b = hexToOklch(canvas);
    if (a && b) sums.deltaOklch += deltaOklch(a, b);
    sums.contrast += wcagRatio(hex, canvas);
    sums.apca += apcaWeight(hex, canvas);
    sums.deltaEOK += oklabDistance(hex, canvas);
  }
  return sums;
}

/** Greys the corpus does not contain, so the identity is tested, not replayed. */
const GREY_PROBES = [0x00, 0x1a, 0x40, 0x80, 0xbf, 0xe6, 0xff];

function greyHex(channel: number): string {
  return `#${channel.toString(16).padStart(2, "0").repeat(3)}`;
}

/**
 * Known values, every one derivable without reading `oklch.ts` or `apca.ts`.
 * A conversion returning a constant, its input, or null scores on all of them.
 */
export function colourMathMisses(corpus: ColourCorpus, pass: ColourMathPass): number {
  let misses = 0;
  // Each accumulator against what the loop owed it. This is the term that sees
  // a call deleted from the timed pass: re-invoking a healthy export in the
  // oracle proves the export works, never that the bracket ran it.
  const expected = expectedColourMathSums(corpus);
  for (const key of ["deltaOklch", "contrast", "apca", "deltaEOK"] as const) {
    const actual = pass.sums[key];
    if (!Number.isFinite(actual) || actual === 0) {
      misses += 1;
      continue;
    }
    // Relative, because these are sums over ~1,000 terms and an exact
    // comparison would fail on float association alone.
    if (Math.abs(actual - expected[key]) > Math.abs(expected[key]) * 1e-9) misses += 1;
  }

  // Two conversions plus three metrics per pair, and one distance per pair that
  // converted. Derived from the corpus, so an operation dropped from the loop
  // moves it.
  const convertible = corpus.pairs.filter(
    ({ hex, canvas }) => hexToOklch(hex) !== null && hexToOklch(canvas) !== null
  ).length;
  if (pass.conversions !== corpus.pairs.length * 5 + convertible) misses += 1;

  for (const channel of GREY_PROBES) {
    const hex = greyHex(channel);
    const oklch = hexToOklch(hex);
    if (!oklch) {
      misses += 1;
      continue;
    }
    if (Math.abs(oklch.l - neutralOklabL(channel)) > 1e-6) misses += 1;
    if (oklch.c > 1e-6) misses += 1;
  }

  // Both distances are exact on a pair of greys: a and b are zero there, so the
  // whole distance collapses to the same cube-root identity the probes above
  // check. This is the anchor `deltaEOK` had none of — the aggregate checksum
  // stayed non-zero from the other four operations while it returned anything.
  for (let i = 0; i < GREY_PROBES.length; i += 1) {
    for (let j = i + 1; j < GREY_PROBES.length; j += 1) {
      const from = greyHex(GREY_PROBES[i]);
      const to = greyHex(GREY_PROBES[j]);
      const expected = Math.abs(neutralOklabL(GREY_PROBES[j]) - neutralOklabL(GREY_PROBES[i]));
      if (Math.abs(deltaEOK(from, to) - expected) > 1e-6) misses += 1;
      const a = hexToOklch(from);
      const b = hexToOklch(to);
      if (!a || !b || Math.abs(deltaOklch(a, b) - expected) > 1e-6) misses += 1;
    }
  }

  // Distance is a metric: zero on itself, symmetric, and non-zero between two
  // colours a theme actually distinguishes.
  const white = hexToOklch("#ffffff");
  const black = hexToOklch("#000000");
  if (!white || !black) misses += 1;
  else {
    if (deltaOklch(white, white) !== 0) misses += 1;
    if (Math.abs(deltaOklch(white, black) - deltaOklch(black, white)) > 1e-9) misses += 1;
    if (deltaOklch(white, black) < 0.9) misses += 1;
  }
  if (deltaEOK("#ffffff", "#ffffff") !== 0) misses += 1;
  if (Math.abs(deltaEOK("#ffffff", "#000000") - deltaEOK("#000000", "#ffffff")) > 1e-9) misses += 1;
  if (deltaEOK("#ffffff", "#000000") < 0.9) misses += 1;

  // Every operation the timed loop pays for, against the oracle's own maths,
  // over the real corpus edges rather than over anchors alone.
  for (const { hex, canvas } of corpus.pairs) {
    if (Math.abs(contrastRatio(hex, canvas) - wcagRatio(hex, canvas)) > 1e-6) misses += 1;
    if (Math.abs(deltaEOK(hex, canvas) - oklabDistance(hex, canvas)) > 1e-9) misses += 1;
    if (Math.abs(apcaLc(hex, canvas) - apcaWeight(hex, canvas)) > 1e-9) misses += 1;
  }

  if (Math.abs(apcaLc("#000000", "#ffffff") - 106.04) > 0.01) misses += 1;
  if (Math.abs(apcaLc("#ffffff", "#000000") - 107.88) > 0.01) misses += 1;
  if (Math.abs(apcaWeight("#000000", "#ffffff") - 106.04) > 0.01) misses += 1;
  if (Math.abs(apcaWeight("#ffffff", "#000000") - 107.88) > 0.01) misses += 1;

  return misses;
}

// --- PERF-303: import validation ---------------------------------------------

export interface ImportCorpus {
  valid: ReadonlyArray<{ name: string; json: string }>;
  invalid: ReadonlyArray<{ name: string; json: string }>;
  bytes: number;
}

/**
 * The 15 shipped themes serialised as import files, plus seven files that are
 * invalid for a reason the validator names. `/etc/passwd` is deliberately NOT
 * among them: `isValidThemeHeroImage` documents root-relative paths as allowed,
 * so listing it would assert a bug rather than a contract.
 */
export function buildImportCorpus(): ImportCorpus {
  const valid = THEME_SOURCES.map((source) => ({
    name: source.id,
    json: JSON.stringify({
      id: `perf-import-${source.id}`,
      name: source.name,
      type: source.type,
      palette: source.palette,
      ...(source.tokens ? { tokens: source.tokens } : {}),
      ...(source.extensions ? { extensions: source.extensions } : {}),
    }),
  }));

  const base = JSON.parse(valid[0]!.json) as Record<string, unknown>;
  const palette = base.palette as Record<string, unknown>;
  const invalid = [
    { name: "palette-leaf", body: { ...base, palette: { ...palette, accent: "not-a-color" } } },
    { name: "palette-not-object", body: { ...base, palette: ["nope"] } },
    { name: "token-value", body: { ...base, tokens: { "surface-canvas": "###" } } },
    { name: "token-not-string", body: { ...base, tokens: { "accent-primary": 42 } } },
    { name: "accent-rgb-triplet", body: { ...base, tokens: { "accent-rgb": "300, 0" } } },
    { name: "remote-hero", body: { ...base, heroImage: "https://cdn.example/x.png" } },
    { name: "windows-absolute-hero", body: { ...base, heroImage: "C:\\themes\\x.png" } },
  ].map(({ name, body }) => ({ name, json: JSON.stringify(body) }));

  let bytes = 0;
  for (const entry of [...valid, ...invalid]) bytes += Buffer.byteLength(entry.json, "utf8");
  return { valid, invalid, bytes };
}

export interface ImportPass {
  accepted: number;
  rejected: number;
  acceptedInvalid: string[];
  rejectedValid: string[];
}

/**
 * The whole import boundary: zod parse, `validateImportedThemeData`,
 * `normalizeAppColorScheme` and the closing `getAppThemeWarnings`.
 */
export function runImportPass(corpus: ImportCorpus): ImportPass {
  let accepted = 0;
  let rejected = 0;
  const acceptedInvalid: string[] = [];
  const rejectedValid: string[] = [];

  for (const entry of corpus.valid) {
    const result = parseAppThemeContent(entry.json, `${entry.name}.json`);
    if (result.ok) accepted += 1;
    else rejectedValid.push(entry.name);
  }
  for (const entry of corpus.invalid) {
    const result = parseAppThemeContent(entry.json, `${entry.name}.json`);
    if (result.ok) acceptedInvalid.push(entry.name);
    else rejected += 1;
  }

  return { accepted, rejected, acceptedInvalid, rejectedValid };
}

/** Both directions. A validator that approves everything scores the invalid half. */
export function importPassMisses(corpus: ImportCorpus, pass: ImportPass): number {
  let misses = pass.acceptedInvalid.length + pass.rejectedValid.length;
  if (pass.accepted !== corpus.valid.length) misses += 1;
  if (pass.rejected !== corpus.invalid.length) misses += 1;

  // The leaf-level validator, on values chosen so approving everything and
  // rejecting everything are both caught.
  const good = validateImportedThemeData({ palette: THEME_SOURCES[0]!.palette });
  if (!good.valid) misses += 1;
  const bad = validateImportedThemeData({ tokens: { "accent-primary": "chartreusey" } });
  if (bad.valid) misses += 1;

  return misses;
}

// --- PERF-304: theme switch + colour vision ----------------------------------

interface StyleStandIn {
  colorScheme: string;
  setProperty(name: string, value: string): void;
  removeProperty(name: string): void;
  getPropertyValue(name: string): string;
}

export interface RootStandIn {
  root: HTMLElement;
  declared: Map<string, string>;
  writes: number;
  removals: number;
  classes: Set<string>;
}

/**
 * The smallest surface `applyAppThemeToRoot` and `applyColorVisionMode`
 * actually touch: inline custom properties, three dataset keys, `colorScheme`
 * and two class toggles. A Map, not a CSSOM — the counts are the reading.
 */
export function createRootStandIn(): RootStandIn {
  const declared = new Map<string, string>();
  const classes = new Set<string>();
  const stand: RootStandIn = {
    root: null as unknown as HTMLElement,
    declared,
    writes: 0,
    removals: 0,
    classes,
  };
  const style: StyleStandIn = {
    colorScheme: "",
    setProperty(name, value) {
      declared.set(name, value);
      stand.writes += 1;
    },
    removeProperty(name) {
      if (declared.delete(name)) stand.removals += 1;
    },
    getPropertyValue(name) {
      return declared.get(name) ?? "";
    },
  };
  stand.root = {
    style,
    dataset: {} as DOMStringMap,
    classList: {
      toggle(name: string, force?: boolean) {
        if (force) classes.add(name);
        else classes.delete(name);
        return Boolean(force);
      },
    },
  } as unknown as HTMLElement;
  return stand;
}

export interface SwitchPass {
  switches: number;
  writes: number;
  removals: number;
  cvdOverridden: number;
  /** Per-switch symmetric difference against the independently derived key set. */
  keySetMisses: number;
  cvdMisses: number;
}

function expectedVariableKeys(scheme: AppColorScheme): Set<string> {
  const keys = new Set<string>(["--theme-color-mode"]);
  for (const key of APP_THEME_TOKEN_KEYS) keys.add(`--theme-${key}`);
  for (const [name, value] of Object.entries(scheme.extensions ?? {})) {
    if (typeof value === "string" && value.trim()) keys.add(`--${name}`);
  }
  return keys;
}

/**
 * Walk the whole cohort as a switch chain, then drive the three colour-vision
 * modes on the last theme.
 *
 * Grading happens inline because it is a read of what the stand-in holds after
 * each step, and the scenario times the switches only — `runThemeSwitchChain`
 * is called once outside the bracket to grade, and again inside it to measure.
 */
export function runThemeSwitchChain(stand: RootStandIn, grade: boolean): SwitchPass {
  let keySetMisses = 0;
  let cvdMisses = 0;
  let cvdOverridden = 0;
  const startWrites = stand.writes;
  const startRemovals = stand.removals;

  for (const scheme of BUILT_IN_APP_SCHEMES) {
    applyAppThemeToRoot(stand.root, scheme);
    if (!grade) continue;
    const expected = expectedVariableKeys(scheme);
    for (const key of expected) if (!stand.declared.has(key)) keySetMisses += 1;
    for (const key of stand.declared.keys()) if (!expected.has(key)) keySetMisses += 1;
  }

  const last = BUILT_IN_APP_SCHEMES[BUILT_IN_APP_SCHEMES.length - 1]!;
  const base = getAppThemeCssVariables(last);
  for (const [mode, overrides] of [
    ["red-green", RED_GREEN_OVERRIDES],
    ["blue-yellow", BLUE_YELLOW_OVERRIDES],
  ] as const) {
    applyColorVisionMode(stand.root, mode, last);
    cvdOverridden += Object.keys(overrides).length;
    if (!grade) continue;
    for (const [token, value] of Object.entries(overrides)) {
      if (stand.declared.get(token) !== value) cvdMisses += 1;
    }
    // Tokens this mode does not itself override must be restored, not erased.
    for (const token of ALL_CVD_TOKENS) {
      if (token in overrides) continue;
      const expected = base[token];
      if (expected != null && stand.declared.get(token) !== expected) cvdMisses += 1;
    }
  }

  applyColorVisionMode(stand.root, "default", last);
  if (grade) {
    for (const token of ALL_CVD_TOKENS) {
      const expected = base[token];
      if (expected != null && stand.declared.get(token) !== expected) cvdMisses += 1;
    }
  }

  return {
    switches: BUILT_IN_APP_SCHEMES.length,
    writes: stand.writes - startWrites,
    removals: stand.removals - startRemovals,
    cvdOverridden,
    keySetMisses,
    cvdMisses,
  };
}

export function switchPassMisses(pass: SwitchPass): number {
  let misses = pass.keySetMisses + pass.cvdMisses;
  if (pass.switches !== BUILT_IN_APP_SCHEMES.length) misses += 1;
  // The cohort's extension sets differ by up to 23 keys, so a chain that walks
  // it must have removed stale variables somewhere. Zero means the switch did
  // not switch.
  if (pass.removals === 0) misses += 1;
  if (pass.writes < BUILT_IN_APP_SCHEMES.length * APP_THEME_TOKEN_KEYS.length) misses += 1;
  return misses;
}

// --- PERF-305: brand-mark ink ------------------------------------------------

export const BRAND_COLOURS: readonly string[] = Object.values(AGENT_REGISTRY)
  .map((config) => (config as { color?: string }).color)
  .filter((color): color is string => typeof color === "string");

export interface InkResolution {
  schemeIndex: number;
  surface: AppThemeTokenKey;
  brand: string;
  rest: string | null;
  active: string | null;
}

export interface InkSweep {
  resolutions: InkResolution[];
  attempted: number;
}

/**
 * Every shipped brand mark against every theme on every surface it can be
 * painted on — 18 x 15 x 6. The sweep exceeds `brandIcon`'s 512-entry FIFO
 * cache, so a repeat of the full sweep re-resolves rather than hitting; the
 * warm reading in PERF-305 uses a bounded subset for that reason.
 */
export function runInkSweep(schemes: readonly AppColorScheme[]): InkSweep {
  const resolutions: InkResolution[] = [];
  let attempted = 0;
  for (let index = 0; index < schemes.length; index += 1) {
    const scheme = schemes[index]!;
    for (const surface of BRAND_MARK_SURFACES) {
      for (const brand of BRAND_COLOURS) {
        const ink = resolveBrandMarkInk(brand, scheme, { surface });
        attempted += 1;
        resolutions.push({
          schemeIndex: index,
          surface,
          brand,
          rest: ink?.rest ?? null,
          active: ink?.active ?? null,
        });
      }
    }
  }
  return { resolutions, attempted };
}

/**
 * The two backdrops a mark meets, composited by the oracle rather than asked of
 * the subject.
 *
 * `compositeOver` exists so this file owns its own blend; the earlier revision
 * wrote it and then called the product's `blendOverBackground` here anyway,
 * which grades a blend with the blend. An opaque `overlay-elevated` replaces the
 * surface rather than lifting it — reading it as a lift would measure a pixel
 * the screen covers.
 */
function backdropsFor(
  scheme: AppColorScheme,
  surface: AppThemeTokenKey
): { rest: string; active: string } | null {
  const rest = scheme.tokens[surface];
  if (!isOpaqueHex(rest)) return null;
  const declared = scheme.tokens["overlay-elevated"] ?? "";
  if (isOpaqueHex(declared)) return { rest, active: declared };
  const overlay = parseRgba(declared);
  return {
    rest,
    active: overlay ? compositeOver(overlay.hex, rest, overlay.opacity) : rest,
  };
}

// The resolver's published contract, named here because a predicate that cannot
// say the numbers cannot check them. Each is a threshold, not an implementation:
// WCAG 1.4.11's non-text floor, `brandIcon`'s ACTIVE_MIN_LC, and the chroma
// under which a brand has no hue for a theme to carry.
const NON_TEXT_CONTRAST_FLOOR = 3;
const ACTIVE_MIN_LC = 35;
const COLOURLESS_CHROMA = 0.02;

/**
 * Hue drift a correction is allowed. `atLightness` holds the hue and gives up
 * chroma to fit sRGB, so the only drift is 8-bit rounding; the cohort's worst is
 * 1.63 degrees.
 */
const BRAND_HUE_TOLERANCE_DEG = 3;

/**
 * The crossfade grid, at twice the resolver's own resolution.
 *
 * `staysLegible` samples 9 points on each axis and enforces the floor with
 * headroom because the minimum can sit between two samples. Sampling the 17-point
 * superset at the bare floor tests that claim rather than replaying it: the 8
 * interpolated points per axis are exactly what the headroom is for.
 */
const ORACLE_CROSSFADE_SAMPLES = Array.from({ length: 17 }, (_, index) => index / 16);

/**
 * Everything the resolver guarantees, re-derived: WCAG 1.4.11's 3:1 across the
 * whole crossfade rather than at its endpoints, the APCA floor an active mark is
 * placed at, and the hue a correction has to preserve.
 *
 * The endpoints alone were not enough to grade this. The APCA floor is where the
 * cheap wrong answer hid: 153 of the 1,620 marks clear WCAG's 3:1 on the raw
 * brand hex while sitting under Lc 35, so a resolver that stops at WCAG is
 * faster and no endpoint check would say so.
 *
 * The crossfade is graded as a grid for the same reason the resolver searches
 * one — both inks are in flight, so the minimum can sit between the endpoints.
 * On the shipped matrix the interior never binds: shortening the resolver's own
 * grid to its two endpoints halves its cost and returns byte-identical ink for
 * all 1,620 resolutions. That is a finding about the resolver rather than a hole
 * here — a pair that does dip between its endpoints is rejected.
 *
 * A resolver that hands back the brand hex unchanged scores on `rest === active`
 * — the whole point of the two states is that they differ — on the contrast
 * floor wherever the raw brand was illegible, and now on the APCA floor for the
 * marks that were legible and still too light to read.
 */
export function inkSweepMisses(schemes: readonly AppColorScheme[], sweep: InkSweep): number {
  let misses = 0;
  const expected = schemes.length * BRAND_MARK_SURFACES.length * BRAND_COLOURS.length;
  if (sweep.attempted !== expected) misses += 1;
  if (sweep.resolutions.length !== expected) misses += 1;

  // Anchor the oracle's own arithmetic before it is used to grade anything.
  if (Math.abs(wcagRatio("#ffffff", "#000000") - 21) > 1e-9) misses += 1;
  if (compositeOver("#ffffff", "#000000", 1) !== "#ffffff") misses += 1;
  if (compositeOver("#ffffff", "#000000", 0) !== "#000000") misses += 1;
  if (mixChannels("#000000", "#ffffff", 0.5) !== "#808080") misses += 1;
  if (Math.abs(apcaWeight("#000000", "#ffffff") - 106.04) > 0.01) misses += 1;
  if (Math.abs(apcaWeight("#ffffff", "#000000") - 107.88) > 0.01) misses += 1;
  if (Math.abs(oklabDistance("#000000", "#ffffff") - 1) > 1e-6) misses += 1;
  if (oklabChroma(greyHex(0x80)) > 1e-6) misses += 1;

  for (const resolution of sweep.resolutions) {
    if (!resolution.rest || !resolution.active) {
      misses += 1;
      continue;
    }
    if (resolution.rest === resolution.active) misses += 1;
    const scheme = schemes[resolution.schemeIndex];
    if (!scheme) {
      misses += 1;
      continue;
    }
    const backdrops = backdropsFor(scheme, resolution.surface);
    if (!backdrops) {
      misses += 1;
      continue;
    }

    // One miss per resolution: the reading is "this mark's crossfade is not
    // legible", not how many of its 289 frames are not.
    if (!crossfadeStaysLegible(resolution.rest, resolution.active, backdrops)) misses += 1;

    const activeWeight = Math.min(
      apcaWeight(resolution.active, backdrops.rest),
      apcaWeight(resolution.active, backdrops.active)
    );
    const ink = scheme.tokens["text-secondary"];
    const colourless = oklabChroma(resolution.brand) < COLOURLESS_CHROMA;
    const silhouette =
      colourless && isOpaqueHex(ink) && resolution.rest.toLowerCase() === ink.toLowerCase();

    if (silhouette) {
      // A brand with no hue is drawn in the theme's own icon ink, so weight is
      // the only reveal it has: active must sit further from the backdrop than
      // rest does. The APCA floor is not this path's contract.
      const restWeight = Math.min(
        apcaWeight(resolution.rest, backdrops.rest),
        apcaWeight(resolution.rest, backdrops.active)
      );
      if (activeWeight <= restWeight) misses += 1;
    } else if (activeWeight < ACTIVE_MIN_LC) {
      misses += 1;
    }

    if (!colourless) {
      // Hue is the half of a brand mark a correction has to survive with, and a
      // grey that clears every floor is the cheap wrong answer this catches.
      if (oklabChroma(resolution.active) < COLOURLESS_CHROMA) misses += 1;
      else if (
        hueSeparation(oklabHue(resolution.active), oklabHue(resolution.brand)) >
        BRAND_HUE_TOLERANCE_DEG
      ) {
        misses += 1;
      }
    }
  }
  return misses;
}

export function crossfadeStaysLegible(
  rest: string,
  active: string,
  backdrops: { rest: string; active: string }
): boolean {
  for (const foreground of ORACLE_CROSSFADE_SAMPLES) {
    const ink = mixChannels(rest, active, foreground);
    for (const background of ORACLE_CROSSFADE_SAMPLES) {
      const behind = mixChannels(backdrops.rest, backdrops.active, background);
      if (wcagRatio(ink, behind) < NON_TEXT_CONTRAST_FLOOR) return false;
    }
  }
  return true;
}
