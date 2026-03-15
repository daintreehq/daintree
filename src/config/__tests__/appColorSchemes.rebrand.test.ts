import { describe, it, expect } from "vitest";
import { BUILT_IN_APP_SCHEMES } from "../appColorSchemes";
import { APP_THEME_TOKEN_KEYS } from "@shared/theme";

function hexToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const clean = hex.replace("#", "");
  const r = hexToLinear(parseInt(clean.slice(0, 2), 16));
  const g = hexToLinear(parseInt(clean.slice(2, 4), 16));
  const b = hexToLinear(parseInt(clean.slice(4, 6), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function getScheme(id: string) {
  const scheme = BUILT_IN_APP_SCHEMES.find((s) => s.id === id);
  if (!scheme) throw new Error(`Built-in app scheme "${id}" not found`);
  return scheme;
}

describe("appColorSchemes rebrand — semantic color separation", () => {
  describe("legacy token cleanup", () => {
    it("no scheme contains the removed canopy-success token", () => {
      for (const scheme of BUILT_IN_APP_SCHEMES) {
        expect(Object.keys(scheme.tokens)).not.toContain("canopy-success");
      }
    });
  });

  describe("all schemes are structurally complete", () => {
    it.each(BUILT_IN_APP_SCHEMES.map((s) => [s.id, s]))(
      'scheme "%s" has all required token keys',
      (_id, scheme) => {
        for (const key of APP_THEME_TOKEN_KEYS) {
          expect(scheme.tokens).toHaveProperty(key, expect.any(String));
        }
      }
    );
  });

  describe("semantic alias invariants — daintree scheme", () => {
    it("status-warning is pollen amber (#C59A4E)", () => {
      expect(getScheme("daintree").tokens["status-warning"]).toBe("#C59A4E");
    });

    it("status-danger is clay coral (#C8746C)", () => {
      expect(getScheme("daintree").tokens["status-danger"]).toBe("#C8746C");
    });

    it("status-info is river slate (#7B8C96)", () => {
      expect(getScheme("daintree").tokens["status-info"]).toBe("#7B8C96");
    });

    it("activity-working is green, not accent-primary", () => {
      const tokens = getScheme("daintree").tokens;
      expect(tokens["activity-working"]).not.toBe(tokens["accent-primary"]);
      expect(tokens["activity-working"]).toBe("#22c55e");
    });

    it("activity-active is green, not accent-primary", () => {
      const tokens = getScheme("daintree").tokens;
      expect(tokens["activity-active"]).not.toBe(tokens["accent-primary"]);
      expect(tokens["activity-active"]).toBe("#22c55e");
    });

    it("activity-active matches activity-working (same green family)", () => {
      const tokens = getScheme("daintree").tokens;
      expect(tokens["activity-active"]).toBe(tokens["activity-working"]);
    });

    it("activity-working differs from status-success (in-progress vs completed)", () => {
      const tokens = getScheme("daintree").tokens;
      expect(tokens["activity-working"]).not.toBe(tokens["status-success"]);
    });
  });

  describe("semantic alias invariants — redwoods scheme", () => {
    it("surface-canvas is old-bark brown (#1A1210)", () => {
      expect(getScheme("redwoods").tokens["surface-canvas"]).toBe("#1A1210");
    });

    it("syntax-string is sorrel green (#8CC255)", () => {
      expect(getScheme("redwoods").tokens["syntax-string"]).toBe("#8CC255");
    });

    it("accent-primary is shared brand green (#3F9366)", () => {
      expect(getScheme("redwoods").tokens["accent-primary"]).toBe("#3F9366");
    });

    it("activity-active is green, not accent-primary", () => {
      const tokens = getScheme("redwoods").tokens;
      expect(tokens["activity-active"]).not.toBe(tokens["accent-primary"]);
      expect(tokens["activity-active"]).toBe("#22c55e");
    });

    it("activity-active matches activity-working (same green family)", () => {
      const tokens = getScheme("redwoods").tokens;
      expect(tokens["activity-active"]).toBe(tokens["activity-working"]);
    });

    it("activity-working differs from status-success (in-progress vs completed)", () => {
      const tokens = getScheme("redwoods").tokens;
      expect(tokens["activity-working"]).not.toBe(tokens["status-success"]);
    });
  });

  describe("semantic alias invariants — serengeti scheme", () => {
    it("activity-working is green, not accent-primary", () => {
      const tokens = getScheme("serengeti").tokens;
      expect(tokens["activity-working"]).not.toBe(tokens["accent-primary"]);
      expect(tokens["activity-working"]).toBe("#22c55e");
    });

    it("activity-active matches activity-working (same green family)", () => {
      const tokens = getScheme("serengeti").tokens;
      expect(tokens["activity-active"]).toBe(tokens["activity-working"]);
    });

    it("activity-working differs from status-success (in-progress vs completed)", () => {
      const tokens = getScheme("serengeti").tokens;
      expect(tokens["activity-working"]).not.toBe(tokens["status-success"]);
    });

    it("accent-primary is brand eucalyptus green", () => {
      expect(getScheme("serengeti").tokens["accent-primary"]).toBe("#3F9366");
    });
  });

  describe("WCAG AA contrast — primary button", () => {
    it.each(BUILT_IN_APP_SCHEMES.map((s) => [s.id, s]))(
      'scheme "%s": accent-foreground on accent-primary passes WCAG AA (≥4.5:1)',
      (_id, scheme) => {
        const bg = scheme.tokens["accent-primary"];
        const fg = scheme.tokens["accent-foreground"];
        if (!bg.startsWith("#") || !fg.startsWith("#")) return;
        const ratio = contrastRatio(bg, fg);
        expect(
          ratio,
          `${_id}: accent-foreground "${fg}" on accent-primary "${bg}" = ${ratio.toFixed(2)}:1, needs ≥4.5:1`
        ).toBeGreaterThanOrEqual(4.5);
      }
    );
  });

  describe("WCAG AA contrast — info button", () => {
    it.each(BUILT_IN_APP_SCHEMES.map((s) => [s.id, s]))(
      'scheme "%s": surface-canvas (info button text) on status-info passes WCAG AA (≥4.5:1)',
      (_id, scheme) => {
        const bg = scheme.tokens["status-info"];
        const fg = scheme.tokens["surface-canvas"];
        if (!bg.startsWith("#") || !fg.startsWith("#")) return;
        const ratio = contrastRatio(bg, fg);
        expect(
          ratio,
          `${_id}: surface-canvas "${fg}" on status-info "${bg}" = ${ratio.toFixed(2)}:1, needs ≥4.5:1`
        ).toBeGreaterThanOrEqual(4.5);
      }
    );
  });
});
