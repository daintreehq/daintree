import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import {
  APP_THEME_TOKEN_KEYS,
  BUILT_IN_APP_SCHEMES,
  deltaEOK,
  parseRgba,
  type AppColorScheme,
  type AppThemeTokenKey,
  type AppThemeValidationWarning,
} from "../../../shared/theme/index.js";
import { allScenarios } from "../scenarios";
import {
  BRAND_COLOURS,
  apcaWeight,
  auditSweepMisses,
  buildColourCorpus,
  buildImportCorpus,
  colourMathMisses,
  compositeOver,
  createPlantedDefectScheme,
  createRootStandIn,
  crossfadeStaysLegible,
  importPassMisses,
  inkSweepMisses,
  neutralOklabL,
  oklabDistance,
  oklabOf,
  resolveThemeCohort,
  runAuditSweep,
  runColourMathPass,
  runImportPass,
  runInkSweep,
  runThemeSwitchChain,
  srgbToLinear,
  switchPassMisses,
  themeResolutionMisses,
  wcagRatio,
  type AuditSweep,
  type ResolvedTheme,
} from "../lib/themeFixture";

const context = { mode: "smoke" as const, now: () => performance.now() };

function scenario(id: string) {
  const found = allScenarios.find((s) => s.id === id);
  expect(found, `${id} must be registered`).toBeDefined();
  return found!;
}

/**
 * Each predicate is exercised against the wrong answer it exists to catch, not
 * only against the healthy path. Colour work has three cheap wrong answers —
 * a resolver that returns its input, a validator that approves everything, and
 * a contrast function returning a constant — and every one of them is fast.
 */

describe("PERF-300 theme resolution oracle", () => {
  const resolved = resolveThemeCohort();

  it("clears on the real cohort and resolves every declared token", () => {
    expect(resolved).toHaveLength(BUILT_IN_APP_SCHEMES.length);
    expect(themeResolutionMisses(resolved)).toBe(0);
    for (const key of APP_THEME_TOKEN_KEYS) {
      expect(typeof resolved[0]!.scheme.tokens[key]).toBe("string");
    }
  });

  it("scores a resolver that handed the palette straight back", () => {
    const echoed: ResolvedTheme[] = resolved.map((entry) => ({
      ...entry,
      scheme: {
        ...entry.scheme,
        tokens: entry.source.palette as unknown as AppColorScheme["tokens"],
      },
      variables: {},
    }));
    expect(themeResolutionMisses(echoed)).toBeGreaterThan(0);
  });

  it("scores a resolver that returned one constant for every token", () => {
    const flat = Object.fromEntries(
      APP_THEME_TOKEN_KEYS.map((key) => [key, "#000000"])
    ) as AppColorScheme["tokens"];
    const constant: ResolvedTheme[] = resolved.map((entry) => ({
      ...entry,
      scheme: { ...entry.scheme, tokens: flat },
    }));
    expect(themeResolutionMisses(constant)).toBeGreaterThan(0);
  });

  it("scores a resolver that copied the accent instead of deriving the wash", () => {
    const target = resolved.find((entry) => !(entry.source.tokens ?? {})["accent-soft"])!;
    const copied: ResolvedTheme[] = resolved.map((entry) =>
      entry === target
        ? {
            ...entry,
            scheme: {
              ...entry.scheme,
              tokens: { ...entry.scheme.tokens, "accent-soft": entry.source.palette.accent },
            },
          }
        : entry
    );
    expect(themeResolutionMisses(copied)).toBeGreaterThan(0);
  });

  it("scores a resolution that emitted no CSS variables", () => {
    const bare: ResolvedTheme[] = resolved.map((entry) => ({ ...entry, variables: {} }));
    expect(themeResolutionMisses(bare)).toBeGreaterThan(0);
  });

  it("produces a real cardinality and a zero predicate through run()", async () => {
    const sample = await scenario("PERF-300").run(context);
    expect(sample.metrics!.themeCount).toBe(BUILT_IN_APP_SCHEMES.length);
    expect(sample.metrics!.cssVariableCount).toBeGreaterThan(
      BUILT_IN_APP_SCHEMES.length * APP_THEME_TOKEN_KEYS.length
    );
    expect(sample.metrics!.extensionVariableCount).toBeGreaterThan(0);
    expect(sample.metrics!.resolveMisses).toBe(0);
    expect(sample.durationMs).toBeGreaterThan(0);
  });
});

describe("PERF-301 audit oracle", () => {
  const planted = createPlantedDefectScheme();
  const sweep = runAuditSweep(planted);

  it("clears on the shipped cohort while reporting the planted theme", () => {
    expect(auditSweepMisses(sweep)).toBe(0);
    expect(sweep.shippedWarnings.flat()).toHaveLength(0);
    expect(sweep.plantedWarnings.filter((w) => w.kind === "low-contrast").length).toBeGreaterThan(
      0
    );
  });

  it("scores an audit that reported nothing at all", () => {
    const silent: AuditSweep = { ...sweep, plantedWarnings: [] };
    expect(auditSweepMisses(silent)).toBeGreaterThan(0);
  });

  it("scores an audit that flagged a shipped theme", () => {
    const noisy: AppThemeValidationWarning[][] = sweep.shippedWarnings.map((w, i) =>
      i === 0 ? [{ kind: "low-contrast", message: "spurious" }] : w
    );
    expect(auditSweepMisses({ ...sweep, shippedWarnings: noisy })).toBeGreaterThan(0);
  });

  it("scores a sweep that skipped schemes", () => {
    expect(auditSweepMisses({ ...sweep, shippedWarnings: [] })).toBeGreaterThan(0);
  });

  it("audits every scheme through run() with a zero predicate", async () => {
    const sample = await scenario("PERF-301").run(context);
    expect(sample.metrics!.auditedThemeCount).toBe(BUILT_IN_APP_SCHEMES.length);
    expect(sample.metrics!.shippedWarningCount).toBe(0);
    expect(sample.metrics!.plantedWarningCount).toBeGreaterThan(0);
    expect(sample.metrics!.auditMisses).toBe(0);
  });
});

describe("PERF-302 colour maths oracle", () => {
  const corpus = buildColourCorpus();
  const pass = runColourMathPass(corpus);

  it("walks a corpus of real theme colours", () => {
    expect(corpus.pairs.length).toBeGreaterThan(500);
    expect(colourMathMisses(corpus, pass)).toBe(0);
  });

  it("derives its grey anchor without the subject", () => {
    // The whole oracle rests on this identity holding independently.
    expect(neutralOklabL(0xff)).toBeCloseTo(1, 12);
    expect(neutralOklabL(0)).toBe(0);
    expect(srgbToLinear(255)).toBeCloseTo(1, 12);
    expect(wcagRatio("#ffffff", "#000000")).toBeCloseTo(21, 12);
  });

  it("fixes both OKLab distances on a pair of greys, without the subject", () => {
    // a and b are zero for an achromatic input, so the distance is a difference
    // of cube roots — the anchor deltaEOK previously had none of.
    const expected = neutralOklabL(0xff) - neutralOklabL(0x80);
    expect(deltaEOK("#808080", "#ffffff")).toBeCloseTo(expected, 6);
    expect(oklabDistance("#808080", "#ffffff")).toBeCloseTo(expected, 6);
    expect(deltaEOK("#ffffff", "#000000")).toBeCloseTo(1, 6);
  });

  it("scores deltaEOK stubbed to return zero", async () => {
    // The hole this closes: four of the five operations keep the checksum
    // non-zero, so the loop got faster and nothing scored.
    vi.resetModules();
    vi.doMock("../../../shared/theme/index.js", async () => {
      const actual = await vi.importActual<Record<string, unknown>>(
        "../../../shared/theme/index.js"
      );
      return { ...actual, deltaEOK: () => 0 };
    });
    const stubbed = await import("../lib/themeFixture");
    const stubbedCorpus = stubbed.buildColourCorpus();
    const stubbedPass = stubbed.runColourMathPass(stubbedCorpus);
    expect(stubbedPass.checksum).not.toBe(0);
    expect(stubbed.colourMathMisses(stubbedCorpus, stubbedPass)).toBeGreaterThan(0);
    vi.doUnmock("../../../shared/theme/index.js");
    vi.resetModules();
  });

  it("scores a pass that converted nothing", () => {
    expect(colourMathMisses(corpus, { conversions: 0, checksum: 0 })).toBeGreaterThan(0);
  });

  it("scores a pass whose accumulator never moved", () => {
    expect(colourMathMisses(corpus, { ...pass, checksum: 0 })).toBeGreaterThan(0);
  });

  it("reports a deterministic conversion count through run()", async () => {
    const sample = await scenario("PERF-302").run(context);
    expect(sample.metrics!.hexTokens).toBe(corpus.pairs.length);
    expect(sample.metrics!.conversionCount).toBe(corpus.pairs.length * 5);
    expect(sample.metrics!.usPerKConversions).toBeGreaterThan(0);
    expect(sample.metrics!.mathMisses).toBe(0);
  });
});

describe("PERF-303 import oracle", () => {
  const corpus = buildImportCorpus();
  const pass = runImportPass(corpus);

  it("accepts every shipped theme and rejects every planted defect", () => {
    expect(pass.accepted).toBe(corpus.valid.length);
    expect(pass.rejected).toBe(corpus.invalid.length);
    expect(importPassMisses(corpus, pass)).toBe(0);
  });

  it("scores a validator that approved everything", () => {
    const approveAll = {
      accepted: corpus.valid.length,
      rejected: 0,
      acceptedInvalid: corpus.invalid.map((entry) => entry.name),
      rejectedValid: [],
    };
    expect(importPassMisses(corpus, approveAll)).toBeGreaterThanOrEqual(corpus.invalid.length);
  });

  it("scores a validator that rejected everything", () => {
    const rejectAll = {
      accepted: 0,
      rejected: corpus.invalid.length,
      acceptedInvalid: [],
      rejectedValid: corpus.valid.map((entry) => entry.name),
    };
    expect(importPassMisses(corpus, rejectAll)).toBeGreaterThanOrEqual(corpus.valid.length);
  });

  it("reports both directions through run()", async () => {
    const sample = await scenario("PERF-303").run(context);
    expect(sample.metrics!.acceptedCount).toBe(corpus.valid.length);
    expect(sample.metrics!.rejectedCount).toBe(corpus.invalid.length);
    expect(sample.metrics!.payloadBytes).toBeGreaterThan(50_000);
    expect(sample.metrics!.validationMisses).toBe(0);
  });
});

describe("PERF-304 switch oracle", () => {
  const graded = runThemeSwitchChain(createRootStandIn(), true);

  it("leaves the root holding exactly the active theme's variables", () => {
    expect(switchPassMisses(graded)).toBe(0);
    expect(graded.removals).toBeGreaterThan(0);
  });

  it("scores a switch that wrote nothing", () => {
    expect(switchPassMisses({ ...graded, writes: 0, removals: 0 })).toBeGreaterThan(0);
  });

  it("scores a switch that left the previous theme's variables behind", () => {
    expect(switchPassMisses({ ...graded, keySetMisses: 3 })).toBeGreaterThan(0);
  });

  it("scores a colour-vision mode that did not restore its base values", () => {
    expect(switchPassMisses({ ...graded, cvdMisses: 2 })).toBeGreaterThan(0);
  });

  it("retires stale variables through run()", async () => {
    const sample = await scenario("PERF-304").run(context);
    expect(sample.metrics!.switchCount).toBe(BUILT_IN_APP_SCHEMES.length);
    expect(sample.metrics!.variableWrites).toBeGreaterThan(
      BUILT_IN_APP_SCHEMES.length * APP_THEME_TOKEN_KEYS.length
    );
    expect(sample.metrics!.staleVariableRemovalCount).toBeGreaterThan(0);
    expect(sample.metrics!.cvdTokensOverridden).toBeGreaterThan(0);
    expect(sample.metrics!.switchMisses).toBe(0);
  });
});

function hoverBackdrops(scheme: AppColorScheme, surface: AppThemeTokenKey) {
  const rest = scheme.tokens[surface]!;
  const overlay = parseRgba(scheme.tokens["overlay-elevated"] ?? "");
  return { rest, active: overlay ? compositeOver(overlay.hex, rest, overlay.opacity) : rest };
}

/** The neutral grey of the same OKLab lightness — same weight, no hue. */
function greyAtLightness(hex: string): string {
  const linear = oklabOf(hex).L ** 3;
  const encoded = linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
  const channel = Math.min(255, Math.max(0, Math.round(encoded * 255)));
  return `#${channel.toString(16).padStart(2, "0").repeat(3)}`;
}

describe("PERF-305 brand ink oracle", () => {
  const schemes = BUILT_IN_APP_SCHEMES.slice(0, 3);
  const sweep = runInkSweep(schemes);

  it("clears WCAG 1.4.11 on every mark, on both states, over both backdrops", () => {
    expect(sweep.attempted).toBe(schemes.length * 6 * BRAND_COLOURS.length);
    expect(inkSweepMisses(schemes, sweep)).toBe(0);
  });

  it("scores a resolver that handed the brand hex back unchanged", () => {
    const echoed = {
      ...sweep,
      resolutions: sweep.resolutions.map((r) => ({ ...r, rest: r.brand, active: r.brand })),
    };
    expect(inkSweepMisses(schemes, echoed)).toBeGreaterThan(0);
  });

  it("composites the hover backdrop itself", () => {
    // White at 6% over daintree's canvas, by hand: 26*0.94 + 255*0.06 = 39.74.
    expect(compositeOver("#ffffff", "#1a1918", 0.06)).toBe("#282726");
  });

  it("sees a crossfade that clears both ends and collapses in the middle", () => {
    const flat = { rest: "#767676", active: "#767676" };
    // Black to white over a mid grey is ~4.7:1 and ~4.5:1 at the ends, ~1.1:1 halfway.
    expect(wcagRatio("#000000", "#767676")).toBeGreaterThan(3);
    expect(wcagRatio("#ffffff", "#767676")).toBeGreaterThan(3);
    expect(crossfadeStaysLegible("#000000", "#ffffff", flat)).toBe(false);
    expect(
      crossfadeStaysLegible("#000000", "#0a0a0a", { rest: "#ffffff", active: "#f2f2f2" })
    ).toBe(true);
  });

  it("scores an active state that clears WCAG and sits under the APCA floor", () => {
    const underweight = new Set(
      sweep.resolutions.filter((r) => {
        const scheme = schemes[r.schemeIndex]!;
        const backdrops = hoverBackdrops(scheme, r.surface);
        return (
          wcagRatio(r.brand, backdrops.rest) >= 3 &&
          wcagRatio(r.brand, backdrops.active) >= 3 &&
          Math.min(apcaWeight(r.brand, backdrops.rest), apcaWeight(r.brand, backdrops.active)) < 35
        );
      })
    );
    // The marks the Lc 35 floor exists for: legible by WCAG, still too light to
    // read. A resolver that stopped at WCAG hands these back untouched.
    expect(underweight.size).toBeGreaterThan(0);
    const stopped = {
      ...sweep,
      resolutions: sweep.resolutions.map((r) =>
        underweight.has(r) ? { ...r, active: r.brand } : r
      ),
    };
    expect(inkSweepMisses(schemes, stopped)).toBeGreaterThanOrEqual(underweight.size);
  });

  it("scores a resolver that dropped the hue and painted every mark grey", () => {
    const greyed = {
      ...sweep,
      resolutions: sweep.resolutions.map((r) => ({
        ...r,
        rest: r.rest ? greyAtLightness(r.rest) : r.rest,
        active: r.active ? greyAtLightness(r.active) : r.active,
      })),
    };
    expect(inkSweepMisses(schemes, greyed)).toBeGreaterThan(0);
  });

  it("scores a resolver that returned nothing", () => {
    const empty = {
      ...sweep,
      resolutions: sweep.resolutions.map((r) => ({ ...r, rest: null, active: null })),
    };
    expect(inkSweepMisses(schemes, empty)).toBeGreaterThan(0);
  });

  it("scores a sweep that stopped short of the matrix", () => {
    expect(inkSweepMisses(schemes, { ...sweep, attempted: 0 })).toBeGreaterThan(0);
  });

  it("resolves the whole matrix through run() with a measured cache ratio", async () => {
    const sample = await scenario("PERF-305").run(context);
    expect(sample.metrics!.markResolutionCount).toBe(
      BUILT_IN_APP_SCHEMES.length * 6 * BRAND_COLOURS.length
    );
    expect(sample.metrics!.warmSpeedup).toBeGreaterThan(1);
    expect(sample.metrics!.inkMisses).toBe(0);
  }, 20_000);
});
