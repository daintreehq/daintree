import {
  APP_THEME_TOKEN_KEYS,
  BUILT_IN_APP_SCHEMES,
  EXTENSION_KEYS,
  apcaContrast,
  apcaLc,
  applyAccentOverrideToScheme,
  blendOverBackground,
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
 *   `neutralOklabL` and `compositeOver` below are written here rather than
 *   imported, because grading `contrastRatio` with `contrastRatio` grades
 *   nothing. Each is anchored against a value the subject does not contain:
 *   WCAG's 21:1 for white-on-black, APCA-W3's published 106.04 / -107.88 pair,
 *   and the identity that a neutral grey's OKLab L is the cube root of its
 *   linearised channel (the M1/M2 rows sum to 1 for an achromatic input).
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

/** WCAG 2.x contrast ratio, derived here so it can grade the product's own. */
export function wcagRatio(foreground: string, background: string): number {
  const luminance = (hex: string): number => {
    const [r, g, b] = channels(hex);
    return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
  };
  const a = luminance(foreground);
  const b = luminance(background);
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
  /** Kept so nothing in the loop is dead-code-eliminated by the JIT. */
  checksum: number;
}

/** Five operations over every colour a cohort audit has to consider. */
export function runColourMathPass(corpus: ColourCorpus): ColourMathPass {
  let checksum = 0;
  let conversions = 0;
  for (const { hex, canvas } of corpus.pairs) {
    const a = hexToOklch(hex);
    const b = hexToOklch(canvas);
    if (a && b) checksum += deltaOklch(a, b);
    checksum += contrastRatio(hex, canvas);
    checksum += apcaLc(hex, canvas);
    checksum += deltaEOK(hex, canvas);
    conversions += 5;
  }
  return { conversions, checksum };
}

/** Greys the corpus does not contain, so the identity is tested, not replayed. */
const GREY_PROBES = [0x00, 0x1a, 0x40, 0x80, 0xbf, 0xe6, 0xff];

/**
 * Known values, every one derivable without reading `oklch.ts` or `apca.ts`.
 * A conversion returning a constant, its input, or null scores on all of them.
 */
export function colourMathMisses(corpus: ColourCorpus, pass: ColourMathPass): number {
  let misses = 0;
  if (pass.conversions !== corpus.pairs.length * 5) misses += 1;
  if (!Number.isFinite(pass.checksum) || pass.checksum === 0) misses += 1;

  for (const channel of GREY_PROBES) {
    const hex = `#${channel.toString(16).padStart(2, "0").repeat(3)}`;
    const oklch = hexToOklch(hex);
    if (!oklch) {
      misses += 1;
      continue;
    }
    if (Math.abs(oklch.l - neutralOklabL(channel)) > 1e-6) misses += 1;
    if (oklch.c > 1e-6) misses += 1;
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

  // The subject's own WCAG against the oracle's, over the real corpus edges.
  for (const { hex, canvas } of corpus.pairs.slice(0, 64)) {
    if (Math.abs(contrastRatio(hex, canvas) - wcagRatio(hex, canvas)) > 1e-6) misses += 1;
  }

  if (Math.abs(apcaLc("#000000", "#ffffff") - 106.04) > 0.01) misses += 1;
  if (Math.abs(apcaLc("#ffffff", "#000000") - 107.88) > 0.01) misses += 1;

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

/** The two backdrops a mark meets, derived here rather than asked of the resolver. */
function backdropsFor(
  scheme: AppColorScheme,
  surface: AppThemeTokenKey
): { rest: string; active: string } | null {
  const rest = scheme.tokens[surface];
  if (!isOpaqueHex(rest)) return null;
  const overlay = parseRgba(scheme.tokens["overlay-elevated"] ?? "");
  return {
    rest,
    active: overlay ? blendOverBackground(overlay.hex, rest, overlay.opacity) : rest,
  };
}

/**
 * WCAG 1.4.11's 3:1, checked with the oracle's own ratio against backdrops the
 * oracle composited itself.
 *
 * A resolver that hands back the brand hex unchanged scores on `rest === active`
 * — the whole point of the two states is that they differ — and on the floor
 * wherever the raw brand was illegible, which is the case the resolver exists
 * for.
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
    for (const ink of [resolution.rest, resolution.active]) {
      for (const behind of [backdrops.rest, backdrops.active]) {
        if (wcagRatio(ink, behind) < 3) misses += 1;
      }
    }
  }
  return misses;
}
