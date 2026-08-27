import { describe, expect, it } from "vitest";
import {
  BUILT_IN_APP_SCHEMES,
  DISPLAY_SURFACES,
  apcaContrast,
  apcaLc,
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

describe("resolveOnSurface", () => {
  it("passes an opaque hex through untouched", () => {
    expect(resolveOnSurface("#e4e4e7", "#101014")).toBe("#e4e4e7");
  });

  it("composites an rgba token against the surface it paints on", () => {
    // text-placeholder is derived as withAlpha(text-primary, 0.35) on 7 of the
    // 15 built-ins, so a report that skipped this would measure the wrong colour.
    const onDark = resolveOnSurface("rgba(255, 255, 255, 0.35)", "#000000");
    const onLight = resolveOnSurface("rgba(255, 255, 255, 0.35)", "#ffffff");
    expect(onDark).not.toBe(onLight);
    expect(onDark).toBe("#595959");
    expect(onLight).toBe("#ffffff");
  });

  it("refuses to guess at forms only a browser can resolve", () => {
    expect(resolveOnSurface("color-mix(in oklab, #fff 70%, #000)", "#101014")).toBeNull();
  });
});

describe("buildReport", () => {
  const report = buildReport();

  it("measures every text role on every display surface of every built-in theme", () => {
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
  });

  it("reports a band for every step of the ramp", () => {
    expect(report.bands.map((b) => b.step)).toEqual([...RAMP_STEPS]);
  });

  it("ranks the ramp monotonically — more alpha is never less separation", () => {
    const medians = report.bands.map((b) => b.ramp.median);
    for (let i = 1; i < medians.length; i++) {
      expect(medians[i]!, `/${RAMP_STEPS[i]} ranks below /${RAMP_STEPS[i - 1]}`).toBeGreaterThan(
        medians[i - 1]!
      );
    }
  });

  it("names the weakest theme/surface a step actually occurs on", () => {
    for (const band of report.bands) {
      const { worst } = band.ramp;
      const scheme = BUILT_IN_APP_SCHEMES.find((s) => s.id === worst.theme);
      expect(scheme, `${worst.theme} is not a built-in`).toBeDefined();
      expect(DISPLAY_SURFACES).toContain(worst.surface);
      expect(worst.lc).toBeCloseTo(band.ramp.min, 5);
    }
  });

  it("derives floorDelta from the nearest role's own floor", () => {
    for (const band of report.bands) {
      const role = report.roles[band.nearestRole];
      expect(role, `${band.nearestRole} has no measured spread`).toBeDefined();
      expect(band.floorDelta).toBeCloseTo(role!.min - band.ramp.min, 5);
    }
  });

  it("composites the ramp against the surface rather than dimming in isolation", () => {
    // A step blended toward the background must land between the background
    // (Lc 0 against itself) and the undimmed token.
    const primary = report.roles["text-primary"]!;
    const full = report.bands.at(-1)!;
    expect(full.ramp.max).toBeLessThan(primary.max);
    expect(report.bands[0]!.ramp.min).toBeLessThan(full.ramp.min);
  });

  it("is deterministic across runs", () => {
    expect(buildReport().bands).toEqual(report.bands);
  });

  it("skips a theme whose surface is not a resolvable colour", () => {
    const broken: AppColorScheme = {
      ...BUILT_IN_APP_SCHEMES[0]!,
      id: "unresolvable",
      tokens: {
        ...BUILT_IN_APP_SCHEMES[0]!.tokens,
        "surface-canvas": "color-mix(in oklab, #fff 50%, #000)",
      },
    };
    const measured = buildReport([broken]).measurements;
    expect(measured.some((m) => m.surface === "surface-canvas")).toBe(false);
    expect(measured.some((m) => m.surface === "surface-panel")).toBe(true);
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

  it("signs the floor delta so a regression reads as negative", () => {
    const output = formatReport(report);
    const regressing = report.bands.filter((b) => b.floorDelta < 0);
    expect(regressing.length, "expected some band to lower the floor").toBeGreaterThan(0);
    expect(output).toMatch(/\s-\d+\.\d/);
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

  it("shows a role's floor sitting far below its median, so bands cannot be read off medians", () => {
    // The trap #12031 has to design around. text-muted carries no dark contrast
    // floor (`getThemeContrastWarnings` guards it on light only), so its weakest
    // theme lands nowhere near its typical one — and a band chosen on the median
    // would quietly ship that worst case to 2.1k call sites.
    const report = buildReport();
    const muted = report.roles["text-muted"]!;
    expect(muted.median - muted.min).toBeGreaterThan(20);
  });

  it("keeps the roles ordered by median, so 'nearest role' means something", () => {
    const report = buildReport();
    const medians = TEXT_ROLES.map((role) => report.roles[role]!.median);
    for (let i = 1; i < medians.length; i++) {
      expect(
        medians[i]!,
        `${TEXT_ROLES[i]} does not recede from ${TEXT_ROLES[i - 1]}`
      ).toBeLessThan(medians[i - 1]!);
    }
  });
});
