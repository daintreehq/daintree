import { describe, expect, it } from "vitest";
import {
  BUILT_IN_APP_SCHEMES,
  DISPLAY_SURFACES,
  apcaContrast,
  apcaLc,
  contrastRatio,
} from "../shared/theme/index.js";
import type { AppColorScheme } from "../shared/theme/index.js";
import {
  RAMP_STEPS,
  TEXT_ROLES,
  buildReport,
  formatReport,
  formatTheme,
  resolveOnSurface,
} from "./theme-text-contrast.js";

// One scheme with hand-picked values, so the assertions below can be worked out
// independently of the implementation rather than mirroring it. Black text on a
// white canvas, a grey secondary, and a half-alpha placeholder.
function fixture(overrides: Record<string, string> = {}): AppColorScheme {
  const base = BUILT_IN_APP_SCHEMES[0]!;
  return {
    ...base,
    id: "fixture",
    type: "light",
    tokens: {
      ...base.tokens,
      "surface-grid": "#ffffff",
      "surface-sidebar": "#ffffff",
      "surface-canvas": "#ffffff",
      "surface-panel": "#ffffff",
      "surface-panel-elevated": "#ffffff",
      "text-primary": "#000000",
      "text-secondary": "#808080",
      "text-muted": "#a0a0a0",
      "text-placeholder": "rgba(0, 0, 0, 0.5)",
      ...overrides,
    },
  };
}

describe("resolveOnSurface", () => {
  it("passes an opaque hex through untouched", () => {
    expect(resolveOnSurface("#e4e4e7", "#101014")).toBe("#e4e4e7");
    expect(resolveOnSurface("#abc", "#101014")).toBe("#abc");
  });

  it("composites an rgba token against the surface it paints on", () => {
    // text-placeholder is derived as withAlpha(text-primary, 0.35) on 7 of the
    // 15 built-ins, so a report that skipped this would measure the wrong colour.
    expect(resolveOnSurface("rgba(255, 255, 255, 0.35)", "#000000")).toBe("#595959");
    expect(resolveOnSurface("rgba(255, 255, 255, 0.35)", "#ffffff")).toBe("#ffffff");
  });

  it("composites alpha hex rather than reading it as opaque", () => {
    // `isHexColor` accepts #RGBA/#RRGGBBAA and the contrast helpers drop the
    // alpha bytes, so treating these as opaque would overstate contrast badly.
    expect(resolveOnSurface("#ffffff80", "#000000")).toBe("#808080");
    expect(resolveOnSurface("#fff8", "#000000")).toBe("#888888");
    expect(resolveOnSurface("#ffffff00", "#123456")).toBe("#123456");
    expect(resolveOnSurface("#ffffffff", "#000000")).toBe("#ffffff");
  });

  it("refuses to guess at forms only a browser can resolve", () => {
    expect(resolveOnSurface("color-mix(in oklab, #fff 70%, #000)", "#101014")).toBeNull();
    expect(resolveOnSurface("oklch(0.7 0.1 200)", "#101014")).toBeNull();
    expect(resolveOnSurface("rebeccapurple", "#101014")).toBeNull();
  });
});

describe("buildReport", () => {
  it("measures every text role on every display surface of every built-in theme", () => {
    const report = buildReport();
    for (const scheme of BUILT_IN_APP_SCHEMES) {
      for (const surface of DISPLAY_SURFACES) {
        for (const role of TEXT_ROLES) {
          const found = report.measurements.some(
            (m) => m.theme === scheme.id && m.surface === surface && m.role === role
          );
          expect(found, `${scheme.id}/${surface}/${role} went unmeasured`).toBe(true);
        }
      }
    }
    expect(report.unresolved).toEqual([]);
  });

  it("reports a band for every step of the ramp", () => {
    expect(buildReport().bands.map((b) => b.step)).toEqual([...RAMP_STEPS]);
  });

  it("composites the ramp toward the surface, not toward black", () => {
    // On a white canvas, black text at 40% must paint the same grey a designer
    // would get from `opacity` — #999999 — not a darkened variant.
    const report = buildReport([fixture()]);
    const step40 = report.bands.find((b) => b.step === 40)!;
    expect(step40.ramp.lcMin).toBeCloseTo(apcaLc("#999999", "#ffffff"), 5);
    expect(step40.ramp.ratioMin).toBeCloseTo(contrastRatio("#999999", "#ffffff"), 5);
  });

  it("resolves an alpha role against the surface before measuring it", () => {
    // rgba(0,0,0,0.5) over white is #808080, which is exactly text-secondary
    // here — so the two roles must measure identically.
    const report = buildReport([fixture()]);
    expect(report.roles["text-placeholder"]!.lcMin).toBeCloseTo(
      report.roles["text-secondary"]!.lcMin,
      5
    );
  });

  it("ranks the ramp monotonically — more alpha is never less separation", () => {
    const medians = buildReport().bands.map((b) => b.ramp.lcMedian);
    for (let i = 1; i < medians.length; i++) {
      expect(medians[i]!, `/${RAMP_STEPS[i]} ranks below /${RAMP_STEPS[i - 1]}`).toBeGreaterThan(
        medians[i - 1]!
      );
    }
  });

  it("names the weakest theme/surface a step actually occurs on", () => {
    for (const band of buildReport().bands) {
      const { worst } = band.ramp;
      expect(BUILT_IN_APP_SCHEMES.some((s) => s.id === worst.theme)).toBe(true);
      expect(DISPLAY_SURFACES).toContain(worst.surface);
      expect(worst.lc).toBeCloseTo(band.ramp.lcMin, 5);
    }
  });

  it("matches a step to the role that paints the same colour, at no cost to the floor", () => {
    // Black at 50% over white is #808080, which is exactly text-secondary in the
    // fixture — so that band is the one case where swapping is genuinely free,
    // and both floor deltas must come out at zero.
    const report = buildReport([fixture()]);
    const band = report.bands.find((b) => b.step === 50)!;
    expect(band.nearestRole).toBe("text-secondary");
    expect(band.lcFloorDelta).toBeCloseTo(0, 5);
    expect(band.ratioFloorDelta).toBeCloseTo(0, 5);
  });

  it("reports a negative floor delta when the nearest role is weaker than the step", () => {
    // text-muted at #c8c8c8 is lighter than the /25 step's #bfbfbf on white, so
    // adopting it for that band lowers contrast. The report has to say so rather
    // than presenting the closest match as safe.
    const report = buildReport([fixture({ "text-muted": "#c8c8c8" })]);
    const band = report.bands.find((b) => b.step === 25)!;
    expect(apcaLc("#c8c8c8", "#ffffff")).toBeLessThan(apcaLc("#bfbfbf", "#ffffff"));
    expect(band.nearestRole).toBe("text-muted");
    expect(band.lcFloorDelta).toBeLessThan(0);
    expect(band.ratioFloorDelta).toBeLessThan(0);
  });

  it("is deterministic across runs", () => {
    expect(buildReport().bands).toEqual(buildReport().bands);
  });

  it("records an unresolvable token instead of dropping the sample silently", () => {
    const broken = fixture({ "surface-canvas": "color-mix(in oklab, #fff 50%, #000)" });
    const report = buildReport([broken]);
    expect(report.measurements.some((m) => m.surface === "surface-canvas")).toBe(false);
    expect(report.measurements.some((m) => m.surface === "surface-panel")).toBe(true);
    expect(report.unresolved).toContainEqual({
      theme: "fixture",
      surface: "surface-canvas",
      token: "surface-canvas",
      value: "color-mix(in oklab, #fff 50%, #000)",
    });
  });

  it("records an unresolvable text role without losing the rest of the surface", () => {
    const broken = fixture({ "text-muted": "oklch(0.6 0.02 240)" });
    const report = buildReport([broken]);
    expect(report.roles["text-muted"]).toBeUndefined();
    expect(report.roles["text-secondary"]).toBeDefined();
    expect(report.unresolved.every((u) => u.token === "text-muted")).toBe(true);
    expect(report.unresolved).toHaveLength(DISPLAY_SURFACES.length);
  });
});

describe("formatting", () => {
  const report = buildReport();

  it("renders one row per role and per step, with the weakest location named", () => {
    const output = formatReport(report);
    for (const role of TEXT_ROLES) expect(output).toContain(role);
    for (const step of RAMP_STEPS) expect(output).toContain(`/${step}`);
    expect(output).toContain(report.bands[0]!.ramp.worst.theme);
  });

  it("signs both floor deltas so a regression reads as negative", () => {
    const output = formatReport(report);
    expect(report.bands.some((b) => b.lcFloorDelta < 0)).toBe(true);
    expect(output).toMatch(/\s-\d+\.\d/);
    expect(output).toMatch(/\+\d+\.\d/);
  });

  it("labels the nearest role as a similarity rather than advice", () => {
    expect(formatReport(report)).toContain("NOT a recommendation");
  });

  it("surfaces unresolved tokens instead of leaving the reader with quiet gaps", () => {
    const broken = buildReport([fixture({ "text-muted": "oklch(0.6 0.02 240)" })]);
    const output = formatReport(broken);
    expect(output).toContain("Unresolved tokens");
    expect(output).toContain("oklch(0.6 0.02 240)");
    expect(formatReport(report)).not.toContain("Unresolved tokens");
  });

  it("renders per-surface detail for a named theme and says so when there is none", () => {
    const detail = formatTheme(report, "daintree");
    for (const surface of DISPLAY_SURFACES) expect(detail).toContain(surface);
    expect(formatTheme(report, "no-such-theme")).toContain("no measurements");
  });
});

describe("the numbers the band decision rests on", () => {
  it("compares dark and light themes on one scale, because apcaLc drops the polarity sign", () => {
    // apcaContrast is signed — dark-on-light and light-on-dark point opposite
    // ways. The report ranks separation across both polarities at once, which
    // only works because apcaLc reports the magnitude.
    expect(apcaContrast("#000000", "#ffffff")).toBeGreaterThan(0);
    expect(apcaContrast("#ffffff", "#000000")).toBeLessThan(0);
    expect(apcaLc("#000000", "#ffffff")).toBeGreaterThan(0);
    expect(apcaLc("#ffffff", "#000000")).toBeGreaterThan(0);
  });

  it("keeps the roles ordered by median, so 'nearest role' means something", () => {
    const report = buildReport();
    const medians = TEXT_ROLES.map((role) => report.roles[role]!.lcMedian);
    for (let i = 1; i < medians.length; i++) {
      expect(
        medians[i]!,
        `${TEXT_ROLES[i]} does not recede from ${TEXT_ROLES[i - 1]}`
      ).toBeLessThan(medians[i - 1]!);
    }
  });
});
