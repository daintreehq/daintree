import { performance } from "node:perf_hooks";
import type { PerfScenario } from "../types";
import { APP_THEME_TOKEN_KEYS, BUILT_IN_APP_SCHEMES } from "../../../shared/theme/index.js";
import { BRAND_MARK_SURFACES } from "../../../src/lib/brandIcon";
import {
  BRAND_COLOURS,
  auditSweepMisses,
  buildColourCorpus,
  buildImportCorpus,
  colourMathMisses,
  countCssVariables,
  createPlantedDefectScheme,
  createRootStandIn,
  importPassMisses,
  inkSweepMisses,
  resolveThemeCohort,
  runAuditSweep,
  runColourMathPass,
  runImportPass,
  runInkSweep,
  runThemeSwitchChain,
  switchPassMisses,
  themeResolutionMisses,
} from "../lib/themeFixture";

// The theme system: `shared/theme` (contrast.ts, themes.ts, oklch.ts,
// colorValidator.ts, apca.ts, colorVisionOverrides.ts) plus the two consumers
// that run its maths at scale — `src/theme/applyAppTheme.ts` on every switch
// and `src/lib/brandIcon.ts` on every brand mark.
//
// Theme resolution sits on the startup path (importing `@shared/theme` resolves
// all 15 built-in palettes at module evaluation, in main and in every project
// renderer), on every theme switch, and on every theme import. Colour maths is
// real compute: the audit alone walks ~1,000 hex tokens through WCAG, APCA and
// OKLab per sweep, and the brand-mark resolver runs an iterative APCA/OKLCH
// search per mark.
//
// The trap this family is built against is specific to colour work: a resolver
// that returns its input, a validator that approves everything and a contrast
// function returning a constant are all fast and all wrong. Every predicate
// here grades against a value derived without the subject — the palette a
// theme was compiled from, WCAG's 21:1 fixed point, APCA-W3's published
// reference pair, the cube-root identity a neutral grey's OKLab lightness
// satisfies, and a planted theme whose text sits ~1.01:1 from its own surfaces.
//
// Scope limits are stated in full in `lib/themeFixture.ts`. The two that decide
// how a number reads: the built-in cohort's own resolver runs at module load
// and is unreachable, so PERF-300 drives the exported resolver over the same
// palettes; and PERF-304 has no CSSOM, so its counts are real and its duration
// is a Map walk.

export const themeScenarios: PerfScenario[] = [
  {
    id: "PERF-300",
    name: "Theme Resolution - Built-in Cohort",
    description:
      "Resolve all 15 shipped palettes through the real normalizeAppColorScheme (palette → " +
      "155 semantic tokens, via compilePaletteToTokens/createDaintreeTokens) and project each " +
      "into CSS custom properties with getAppThemeCssVariables. This is what importing " +
      "@shared/theme costs at module evaluation, in main and in every project renderer. " +
      "cssVariableCount is a deterministic cardinality that travels across machines; " +
      "resolveMisses grades each resolution against the palette it came from.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 8, ci: 14, nightly: 20 },
    warmups: 2,
    correctness: ["resolveMisses"],
    run() {
      const REPEATS = 6;
      let resolved = resolveThemeCohort();
      const start = performance.now();
      for (let i = 0; i < REPEATS; i += 1) resolved = resolveThemeCohort();
      const durationMs = performance.now() - start;

      const cssVariableCount = countCssVariables(resolved);
      // Everything past the token contract and the one polarity marker: the
      // theme extensions, which is where the cohort's spread lives.
      const extensionVariableCount =
        cssVariableCount - resolved.length * (APP_THEME_TOKEN_KEYS.length + 1);

      return {
        durationMs,
        metrics: {
          themeCount: resolved.length,
          tokenKeyCount: APP_THEME_TOKEN_KEYS.length,
          cssVariableCount,
          extensionVariableCount,
          msPerTheme: durationMs / (REPEATS * Math.max(1, resolved.length)),
          resolveMisses: themeResolutionMisses(resolved),
        },
      };
    },
  },
  {
    id: "PERF-301",
    name: "Theme Audit - Contrast and APCA Sweep",
    description:
      "The sweep ThemeBrowser recomputes whenever the accent override changes: " +
      "getAppThemeWarnings over all 15 schemes, getLightThemeMatrixWarnings over the 7 light " +
      "ones, and a second full pass through applyAccentOverrideToScheme with a foreign accent — " +
      "the same audit the theme importer closes with. Every shipped theme must come back clean " +
      "(shippedWarningCount 0) while a planted theme whose text sits ~1.01:1 from its own " +
      "surfaces must be reported, and auditMisses additionally anchors the maths against WCAG's " +
      "21:1 and the published APCA-W3 pair.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 8, ci: 14, nightly: 20 },
    warmups: 2,
    correctness: ["auditMisses"],
    run() {
      const REPEATS = 3;
      // The planted theme is fixture construction, not audit work.
      const planted = createPlantedDefectScheme();
      let sweep = runAuditSweep(planted);
      const start = performance.now();
      for (let i = 0; i < REPEATS; i += 1) sweep = runAuditSweep(planted);
      const durationMs = performance.now() - start;

      let shippedWarningCount = 0;
      for (const warnings of sweep.shippedWarnings) shippedWarningCount += warnings.length;

      return {
        durationMs,
        metrics: {
          auditedThemeCount: BUILT_IN_APP_SCHEMES.length,
          shippedWarningCount,
          plantedWarningCount: sweep.plantedWarnings.length,
          lightMatrixWarningCount: sweep.lightMatrixWarnings,
          accentOverrideWarningCount: sweep.accentOverrideWarnings,
          msPerTheme: durationMs / (REPEATS * Math.max(1, BUILT_IN_APP_SCHEMES.length)),
          auditMisses: auditSweepMisses(sweep),
        },
      };
    },
  },
  {
    id: "PERF-302",
    name: "Theme Colour Maths - Cohort Corpus",
    description:
      "Price the five colour operations an audit runs per token — hexToOklch, deltaOklch, " +
      "contrastRatio, apcaLc and deltaEOK — over every opaque hex token in the shipped cohort. " +
      "hexTokens and conversionCount are deterministic cardinalities that travel; " +
      "usPerKConversions is the unit price PERF-301's composed number is made of. mathMisses " +
      "grades every one of the five against values no line of oklch.ts or apca.ts contains: a " +
      "neutral grey's OKLab lightness is the cube root of its linearised channel, which fixes " +
      "both OKLab distances exactly on any pair of greys; white-on-black is exactly 21:1; and " +
      "the APCA-W3 reference pair is 106.04 / -107.88. contrastRatio, deltaEOK and apcaLc are " +
      "each additionally compared against the oracle's own arithmetic over the real corpus, so " +
      "an operation stubbed out cannot hide behind the aggregate checksum.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 10, ci: 16, nightly: 22 },
    warmups: 2,
    correctness: ["mathMisses"],
    run() {
      const REPEATS = 8;
      const corpus = buildColourCorpus();
      let pass = runColourMathPass(corpus);
      const start = performance.now();
      for (let i = 0; i < REPEATS; i += 1) pass = runColourMathPass(corpus);
      const durationMs = performance.now() - start;

      const conversions = pass.conversions * REPEATS;
      return {
        durationMs,
        metrics: {
          hexTokens: corpus.pairs.length,
          conversionCount: pass.conversions,
          usPerKConversions: (durationMs * 1e6) / Math.max(1, conversions),
          mathMisses: colourMathMisses(corpus, pass),
        },
      };
    },
  },
  {
    id: "PERF-303",
    name: "Theme Import - Validation Boundary",
    description:
      "Drive the real parseAppThemeContent (zod schema → validateImportedThemeData → " +
      "normalizeAppColorScheme → getAppThemeWarnings) over the 15 shipped themes serialised as " +
      "import files plus 7 files that are invalid for a reason the validator names. payloadBytes " +
      "is a deterministic byte total; validationMisses is two-sided, so a validator that " +
      "approves everything scores the invalid half and one that rejects everything scores the " +
      "valid half.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 6, ci: 12, nightly: 18 },
    warmups: 1,
    correctness: ["validationMisses"],
    run() {
      const corpus = buildImportCorpus();
      const start = performance.now();
      const pass = runImportPass(corpus);
      const durationMs = performance.now() - start;

      const files = corpus.valid.length + corpus.invalid.length;
      return {
        durationMs,
        metrics: {
          themeFiles: files,
          payloadBytes: corpus.bytes,
          acceptedCount: pass.accepted,
          rejectedCount: pass.rejected,
          msPerFile: durationMs / Math.max(1, files),
          validationMisses: importPassMisses(corpus, pass),
        },
      };
    },
  },
  {
    id: "PERF-304",
    name: "Theme Switch - Variable Rewrite and Colour Vision",
    description:
      "Walk the whole cohort as a switch chain through the real applyAppThemeToRoot, then drive " +
      "red-green, blue-yellow and back to default through the real applyColorVisionMode. " +
      "Themes declare between 37 and 60 extensions, so a switch has to retire the variables the " +
      "previous theme owned — staleVariableRemovalCount is that work, and zero would mean the " +
      "switch did not switch. NO CSSOM: the root is a Map-backed stand-in, so the counts are " +
      "real and the duration is a Map walk, not a style recalculation. switchMisses reads the " +
      "root back against a key set derived from APP_THEME_TOKEN_KEYS and the scheme's own " +
      "extensions, and requires every non-overridden CVD token restored to its base value.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 8, ci: 14, nightly: 20 },
    warmups: 2,
    correctness: ["switchMisses"],
    run() {
      // Graded on its own stand-in, outside the bracket: reading the root back
      // after every switch is oracle work, not switch work.
      const graded = runThemeSwitchChain(createRootStandIn(), true);

      const stand = createRootStandIn();
      const start = performance.now();
      const timed = runThemeSwitchChain(stand, false);
      const durationMs = performance.now() - start;

      return {
        durationMs,
        metrics: {
          switchCount: timed.switches,
          variableWrites: timed.writes,
          staleVariableRemovalCount: timed.removals,
          cvdTokensOverridden: timed.cvdOverridden,
          msPerSwitch: durationMs / Math.max(1, timed.switches),
          switchMisses: switchPassMisses(graded),
        },
      };
    },
  },
  {
    id: "PERF-305",
    name: "Brand Mark Ink - APCA Search Across the Cohort",
    description:
      "resolveBrandMarkInk for all 18 shipped agent brand colours against all 15 themes on all " +
      "6 surfaces a mark can be painted on — the heaviest real consumer of the APCA and OKLCH " +
      "maths, run for every brand mark whenever the active theme changes. The full sweep is " +
      "1,620 resolutions against a 512-entry FIFO cache, so it thrashes and every pass is cold; " +
      "warmSpeedup is measured on a bounded subset that fits. inkMisses composites each backdrop " +
      "itself and grades the two things the resolution actually costs: WCAG 1.4.11's 3:1 across " +
      "a 17x17 crossfade grid rather than at its endpoints, and the APCA Lc 35 floor an active " +
      "mark is placed at — 153 of the 1,620 clear 3:1 on the raw brand hex and are moved by " +
      "nothing but that floor. Hue is checked too, so a grey that clears every floor scores.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 4, ci: 8, nightly: 12 },
    warmups: 1,
    correctness: ["inkMisses"],
    run() {
      // A subset small enough to fit brandIcon's cache, resolved twice, so the
      // cache's value is a measured ratio rather than an assumption.
      const subset = BUILT_IN_APP_SCHEMES.slice(0, 4);
      const coldStart = performance.now();
      runInkSweep(subset);
      const subsetColdMs = performance.now() - coldStart;
      const warmStart = performance.now();
      runInkSweep(subset);
      const subsetWarmMs = performance.now() - warmStart;

      const start = performance.now();
      const sweep = runInkSweep(BUILT_IN_APP_SCHEMES);
      const durationMs = performance.now() - start;

      return {
        durationMs,
        metrics: {
          markResolutionCount: sweep.attempted,
          brandCount: BRAND_COLOURS.length,
          surfaceCount: BRAND_MARK_SURFACES.length,
          msPer1kMarks: (durationMs * 1000) / Math.max(1, sweep.attempted),
          subsetColdMs,
          subsetWarmMs,
          warmSpeedup: subsetWarmMs > 0 ? subsetColdMs / subsetWarmMs : 0,
          inkMisses: inkSweepMisses(BUILT_IN_APP_SCHEMES, sweep),
        },
      };
    },
  },
];
