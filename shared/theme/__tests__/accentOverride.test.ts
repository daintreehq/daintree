import { describe, expect, it } from "vitest";
import {
  applyAccentOverrideToScheme,
  BUILT_IN_APP_SCHEMES,
  computeAccentOverrideTokens,
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

  it("brightens accent-hover for dark schemes and darkens for light schemes", () => {
    const dark = computeAccentOverrideTokens("#3366ff", darkScheme);
    const light = computeAccentOverrideTokens("#3366ff", lightScheme);
    expect(dark["accent-hover"]).toBe("color-mix(in oklab, #3366ff 90%, #ffffff)");
    expect(light["accent-hover"]).toBe("color-mix(in oklab, #3366ff 90%, #000000)");
  });

  it("uses higher alpha for soft/muted on dark than on light", () => {
    const dark = computeAccentOverrideTokens("#3366ff", darkScheme);
    const light = computeAccentOverrideTokens("#3366ff", lightScheme);
    expect(dark["accent-soft"]).toBe("rgba(51, 102, 255, 0.18)");
    expect(dark["accent-muted"]).toBe("rgba(51, 102, 255, 0.3)");
    expect(light["accent-soft"]).toBe("rgba(51, 102, 255, 0.12)");
    expect(light["accent-muted"]).toBe("rgba(51, 102, 255, 0.2)");
  });

  it("picks a high-contrast accent-foreground for a very light accent", () => {
    // A near-white accent must choose a dark foreground for readability.
    const tokens = computeAccentOverrideTokens("#fafafa", darkScheme);
    // Candidate order: text-inverse, text-primary, #ffffff, #000000.
    // On a dark theme, text-inverse is dark, so contrast is very high.
    // Either way, the winner must NOT be #ffffff.
    expect(tokens["accent-foreground"]).not.toBe("#ffffff");
  });

  it("picks a high-contrast accent-foreground for a very dark accent", () => {
    const tokens = computeAccentOverrideTokens("#050505", lightScheme);
    expect(tokens["accent-foreground"]).not.toBe("#000000");
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
