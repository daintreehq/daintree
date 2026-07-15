import { describe, expect, it } from "vitest";
import { ACCENT_CONTRAST_PAIR, accentOverrideHasLowContrast, contrastRatio } from "../contrast.js";
import {
  applyAccentOverrideToScheme,
  BUILT_IN_APP_SCHEMES,
  computeAccentOverrideTokens,
  getAppThemeWarnings,
  normalizeAccentHex,
} from "../themes.js";
import type { AppColorScheme } from "../types.js";

const darkScheme = BUILT_IN_APP_SCHEMES.find((s) => s.type === "dark")!;
const lightScheme = BUILT_IN_APP_SCHEMES.find((s) => s.type === "light")!;

describe("normalizeAccentHex", () => {
  it("canonicalizes 6-digit hex to lowercase with leading #", () => {
    expect(normalizeAccentHex("#AABBCC")).toBe("#aabbcc");
    expect(normalizeAccentHex("aabbcc")).toBe("#aabbcc");
    expect(normalizeAccentHex("  #AaBbCc  ")).toBe("#aabbcc");
  });

  it("expands 3-digit shorthand to full hex", () => {
    expect(normalizeAccentHex("#abc")).toBe("#aabbcc");
    expect(normalizeAccentHex("f0a")).toBe("#ff00aa");
  });

  it("rejects invalid input", () => {
    expect(normalizeAccentHex("")).toBeNull();
    expect(normalizeAccentHex("rgb(0,0,0)")).toBeNull();
    expect(normalizeAccentHex("#gggggg")).toBeNull();
    expect(normalizeAccentHex("#12345")).toBeNull();
    expect(normalizeAccentHex("#1234567")).toBeNull();
    expect(normalizeAccentHex(null)).toBeNull();
    expect(normalizeAccentHex(undefined)).toBeNull();
    expect(normalizeAccentHex(123)).toBeNull();
  });
});

describe("computeAccentOverrideTokens", () => {
  it("returns the hex as accent-primary and computes rgb triplet", () => {
    const tokens = computeAccentOverrideTokens("#ff8040", darkScheme);
    expect(tokens["accent-primary"]).toBe("#ff8040");
    expect(tokens["accent-rgb"]).toBe("255, 128, 64");
  });

  it("normalizes the input hex before derivation", () => {
    const tokens = computeAccentOverrideTokens("AABBCC", darkScheme);
    expect(tokens["accent-primary"]).toBe("#aabbcc");
    expect(tokens["accent-rgb"]).toBe("170, 187, 204");
  });

  it("brightens accent-hover toward white for both polarities (RC-4)", () => {
    // The accent must ADVANCE on hover regardless of polarity: on light the old
    // darken-toward-black pushed an already-receding accent further into the
    // canvas, so both modes now mix toward white.
    const dark = computeAccentOverrideTokens("#3366ff", darkScheme);
    const light = computeAccentOverrideTokens("#3366ff", lightScheme);
    expect(dark["accent-hover"]).toContain("#ffffff");
    expect(light["accent-hover"]).toContain("#ffffff");
    expect(dark["accent-hover"]).toBe(light["accent-hover"]);
  });

  it("uses the same soft/muted membership-tint alphas across polarities (RC-4)", () => {
    // Light's soft/muted were previously lower, compositing to a near-achromatic
    // grey on a light canvas; they now match dark so the membership tint reads as
    // colored. soft stays below muted (a tint, not a second accent anchor).
    const dark = computeAccentOverrideTokens("#3366ff", darkScheme);
    const light = computeAccentOverrideTokens("#3366ff", lightScheme);
    expect(light["accent-soft"]).toBe(dark["accent-soft"]);
    expect(light["accent-muted"]).toBe(dark["accent-muted"]);
    const softAlpha = Number(/,\s*([\d.]+)\)$/.exec(light["accent-soft"])![1]);
    const mutedAlpha = Number(/,\s*([\d.]+)\)$/.exec(light["accent-muted"])![1]);
    expect(softAlpha).toBeLessThan(mutedAlpha);
  });

  // Adversarial accents, both polarities (#11115). The old assertions only said the
  // derived foreground wasn't pure white/black — a 2.4:1 near-miss satisfied that.
  // #757575 is the genuinely hardest 8-bit neutral: white clears it by only 4.61:1
  // and black by 4.56:1, so a derivation that picks the wrong candidate fails here
  // while #808080 (black clears at 5.32:1) would let it pass.
  describe.each([
    ["very light", "#fafafa"],
    ["very dark", "#050505"],
    ["boundary mid-luminance", "#757575"],
  ])("a %s accent", (_label, accent) => {
    it.each([
      ["dark", darkScheme],
      ["light", lightScheme],
    ])("derives a foreground legible on the accent fill, on a %s base scheme", (_type, base) => {
      const scheme = applyAccentOverrideToScheme(base, accent);

      // Assert the ratio directly, with the threshold read from the validator's own
      // pair. Going through accentOverrideHasLowContrast alone would fail OPEN: it
      // skips the foreground branch entirely when the derived value isn't a hex, so
      // a derivation regressing to an rgba()/var() string would report no failure.
      const ratio = contrastRatio(
        scheme.tokens[ACCENT_CONTRAST_PAIR.foreground],
        scheme.tokens[ACCENT_CONTRAST_PAIR.background]
      );
      expect(ratio, `accent-foreground is illegible on ${accent}`).toBeGreaterThanOrEqual(
        ACCENT_CONTRAST_PAIR.minimum
      );

      // And the production validator must agree. A `surface`-mode failure is expected
      // and allowed — a near-white accent IS hard to see on a light canvas, which is a
      // separate finding the theme picker warns about on its own.
      const failure = accentOverrideHasLowContrast(scheme);
      expect(failure?.mode).not.toBe("foreground");
    });
  });

  it("throws on invalid hex input", () => {
    expect(() => computeAccentOverrideTokens("not-a-color", darkScheme)).toThrow();
  });
});

describe("applyAccentOverrideToScheme", () => {
  it("returns the original scheme reference when override is null/undefined/invalid", () => {
    expect(applyAccentOverrideToScheme(darkScheme, null)).toBe(darkScheme);
    expect(applyAccentOverrideToScheme(darkScheme, undefined)).toBe(darkScheme);
    expect(applyAccentOverrideToScheme(darkScheme, "")).toBe(darkScheme);
    expect(applyAccentOverrideToScheme(darkScheme, "not-hex")).toBe(darkScheme);
  });

  it("patches all six accent tokens without mutating the input scheme", () => {
    const originalAccent = darkScheme.tokens["accent-primary"];
    const patched = applyAccentOverrideToScheme(darkScheme, "#ff0000");
    expect(patched).not.toBe(darkScheme);
    expect(darkScheme.tokens["accent-primary"]).toBe(originalAccent);
    expect(patched.tokens["accent-primary"]).toBe("#ff0000");
    expect(patched.tokens["accent-hover"]).toContain("#ff0000");
    expect(patched.tokens["accent-soft"]).toContain("255, 0, 0");
    expect(patched.tokens["accent-muted"]).toContain("255, 0, 0");
    expect(patched.tokens["accent-rgb"]).toBe("255, 0, 0");
    // All non-accent tokens untouched.
    expect(patched.tokens["surface-canvas"]).toBe(darkScheme.tokens["surface-canvas"]);
    expect(patched.tokens["text-primary"]).toBe(darkScheme.tokens["text-primary"]);
  });

  it("preserves scheme metadata (id, name, type, builtin)", () => {
    const patched = applyAccentOverrideToScheme(darkScheme, "#00ff00");
    expect(patched.id).toBe(darkScheme.id);
    expect(patched.name).toBe(darkScheme.name);
    expect(patched.type).toBe(darkScheme.type);
    expect(patched.builtin).toBe(darkScheme.builtin);
  });

  it("also merges override into a synthetic scheme with custom tokens", () => {
    const synthetic: AppColorScheme = {
      ...lightScheme,
      id: "synthetic",
      name: "Synthetic",
      builtin: false,
    };
    const patched = applyAccentOverrideToScheme(synthetic, "#123456");
    expect(patched.tokens["accent-primary"]).toBe("#123456");
    expect(patched.id).toBe("synthetic");
  });
});

describe("getAppThemeWarnings — non-hex accent-rgb degradation", () => {
  it("warns when accent-primary is non-hex and accent-rgb falls back to 0, 0, 0", () => {
    const scheme: AppColorScheme = {
      ...darkScheme,
      tokens: {
        ...darkScheme.tokens,
        "accent-primary": "oklch(0.7 0.13 295)",
        "accent-rgb": "0, 0, 0",
      },
    };
    const warnings = getAppThemeWarnings(scheme);
    expect(warnings.some((w) => w.message.includes("accent-rgb"))).toBe(true);
  });

  it("does not warn when accent-primary is non-hex but accent-rgb is explicitly set", () => {
    const scheme: AppColorScheme = {
      ...darkScheme,
      tokens: {
        ...darkScheme.tokens,
        "accent-primary": "oklch(0.7 0.13 295)",
        "accent-rgb": "180, 90, 255",
      },
    };
    const warnings = getAppThemeWarnings(scheme);
    expect(warnings.some((w) => w.message.includes("accent-rgb"))).toBe(false);
  });

  it("does not warn when accent-primary is hex (normal path)", () => {
    const warnings = getAppThemeWarnings(darkScheme);
    expect(warnings.some((w) => w.message.includes("accent-rgb"))).toBe(false);
  });

  it("warns for color-mix() accent values, not just oklch", () => {
    const scheme: AppColorScheme = {
      ...darkScheme,
      tokens: {
        ...darkScheme.tokens,
        "accent-primary": "color-mix(in oklab, #ff0000, #0000ff)",
        "accent-rgb": "0, 0, 0",
      },
    };
    const warnings = getAppThemeWarnings(scheme);
    expect(warnings.some((w) => w.message.includes("accent-rgb"))).toBe(true);
  });
});
