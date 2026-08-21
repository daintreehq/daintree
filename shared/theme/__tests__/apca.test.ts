import { describe, expect, it } from "vitest";
import { apcaContrast, apcaLc } from "../apca.js";
import { contrastRatio } from "../contrast.js";

/** The grey that sits at exactly `ratio` against `backdrop`, found by bisection. */
function greyAtRatio(backdrop: string, ratio: number): string {
  const toward = contrastRatio("#000000", backdrop) >= ratio ? 0 : 255;
  let near = toward === 0 ? 255 : 0;
  let far = toward;
  for (let step = 0; step < 24; step++) {
    const mid = Math.round((near + far) / 2);
    const hex = `#${mid.toString(16).padStart(2, "0").repeat(3)}`;
    if (contrastRatio(hex, backdrop) >= ratio) far = mid;
    else near = mid;
  }
  return `#${far.toString(16).padStart(2, "0").repeat(3)}`;
}

describe("apcaContrast", () => {
  it("reproduces the published APCA-W3 reference pair", () => {
    // The two values every APCA-W3 implementation is checked against. They are
    // the spec's, not ours — nothing in `apca.ts` contains either number, so
    // this fails if a constant or an exponent is mistyped.
    expect(apcaContrast("#000000", "#ffffff")).toBeCloseTo(106.04, 2);
    expect(apcaContrast("#ffffff", "#000000")).toBeCloseTo(-107.88, 2);
  });

  it("signs dark-on-light positive and light-on-dark negative", () => {
    expect(apcaContrast("#333333", "#eeeeee")).toBeGreaterThan(0);
    expect(apcaContrast("#eeeeee", "#333333")).toBeLessThan(0);
    expect(apcaLc("#eeeeee", "#333333")).toBeGreaterThan(0);
  });

  it("reports nothing for a foreground indistinguishable from its backdrop", () => {
    expect(apcaContrast("#404040", "#404040")).toBe(0);
    expect(apcaContrast("#404040", "#404142")).toBe(0);
  });

  it("weighs the same WCAG ratio differently in each polarity", () => {
    // This asymmetry is the reason the module exists. WCAG's ratio has no
    // polarity term, so it calls these two pairs equal; APCA does not, and a
    // fade sized in WCAG ratios lands differently on a dark theme than on a
    // light one for exactly this reason.
    const onLight = { fg: greyAtRatio("#ffffff", 4.5), bg: "#ffffff" };
    const onDark = { fg: greyAtRatio("#1a1a1a", 4.5), bg: "#1a1a1a" };
    expect(contrastRatio(onLight.fg, onLight.bg)).toBeCloseTo(
      contrastRatio(onDark.fg, onDark.bg),
      1
    );
    expect(Math.abs(apcaLc(onLight.fg, onLight.bg) - apcaLc(onDark.fg, onDark.bg))).toBeGreaterThan(
      5
    );
  });

  it("grows monotonically as a foreground moves away from its backdrop", () => {
    const steps = ["#2a2a2a", "#555555", "#808080", "#aaaaaa", "#d5d5d5", "#ffffff"];
    const measured = steps.map((hex) => apcaLc(hex, "#1a1a1a"));
    for (let i = 1; i < measured.length; i++) {
      expect(measured[i]!).toBeGreaterThan(measured[i - 1]!);
    }
  });
});
