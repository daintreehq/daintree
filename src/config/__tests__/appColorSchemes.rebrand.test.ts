import { describe, it, expect } from "vitest";
import { BUILT_IN_APP_SCHEMES } from "../appColorSchemes";
import { APP_THEME_TOKEN_KEYS } from "@shared/theme";

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

  describe("semantic alias invariants — canopy scheme", () => {
    it("status-warning is pollen amber (#C59A4E)", () => {
      expect(getScheme("canopy").tokens["status-warning"]).toBe("#C59A4E");
    });

    it("status-danger is clay coral (#C8746C)", () => {
      expect(getScheme("canopy").tokens["status-danger"]).toBe("#C8746C");
    });

    it("status-info is river slate (#7B8C96)", () => {
      expect(getScheme("canopy").tokens["status-info"]).toBe("#7B8C96");
    });

    it("activity-working is green, not accent-primary", () => {
      const tokens = getScheme("canopy").tokens;
      expect(tokens["activity-working"]).not.toBe(tokens["accent-primary"]);
      expect(tokens["activity-working"]).toBe("#22c55e");
    });

    it("activity-active is green, not accent-primary", () => {
      const tokens = getScheme("canopy").tokens;
      expect(tokens["activity-active"]).not.toBe(tokens["accent-primary"]);
      expect(tokens["activity-active"]).toBe("#22c55e");
    });

    it("activity-active matches activity-working (same green family)", () => {
      const tokens = getScheme("canopy").tokens;
      expect(tokens["activity-active"]).toBe(tokens["activity-working"]);
    });

    it("activity-working differs from status-success (in-progress vs completed)", () => {
      const tokens = getScheme("canopy").tokens;
      expect(tokens["activity-working"]).not.toBe(tokens["status-success"]);
    });
  });

  describe("semantic alias invariants — canopy-slate scheme", () => {
    it("activity-working is green, not accent-primary", () => {
      const tokens = getScheme("canopy-slate").tokens;
      expect(tokens["activity-working"]).not.toBe(tokens["accent-primary"]);
      expect(tokens["activity-working"]).toBe("#22c55e");
    });

    it("activity-active is green, not accent-primary", () => {
      const tokens = getScheme("canopy-slate").tokens;
      expect(tokens["activity-active"]).not.toBe(tokens["accent-primary"]);
      expect(tokens["activity-active"]).toBe("#22c55e");
    });

    it("activity-active matches activity-working (same green family)", () => {
      const tokens = getScheme("canopy-slate").tokens;
      expect(tokens["activity-active"]).toBe(tokens["activity-working"]);
    });

    it("activity-working differs from status-success (in-progress vs completed)", () => {
      const tokens = getScheme("canopy-slate").tokens;
      expect(tokens["activity-working"]).not.toBe(tokens["status-success"]);
    });
  });
});
