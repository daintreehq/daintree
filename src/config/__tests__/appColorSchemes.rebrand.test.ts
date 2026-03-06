import { describe, it, expect } from "vitest";
import { BUILT_IN_APP_SCHEMES } from "../appColorSchemes";
import type { AppColorSchemeTokens } from "@shared/types/appTheme";

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
    const requiredKeys: (keyof AppColorSchemeTokens)[] = [
      "canopy-bg",
      "canopy-sidebar",
      "canopy-border",
      "canopy-text",
      "canopy-accent",
      "surface",
      "surface-highlight",
      "grid-bg",
      "canopy-focus",
      "status-success",
      "status-warning",
      "status-error",
      "status-info",
      "state-active",
      "state-idle",
      "state-working",
      "state-waiting",
      "server-running",
      "server-stopped",
      "server-starting",
      "server-error",
      "terminal-selection",
    ];

    it.each(BUILT_IN_APP_SCHEMES.map((s) => [s.id, s]))(
      'scheme "%s" has all required token keys',
      (_id, scheme) => {
        for (const key of requiredKeys) {
          expect(scheme.tokens).toHaveProperty(key, expect.any(String));
        }
      }
    );
  });

  describe("semantic alias invariants — canopy scheme", () => {
    it("status-warning is softened warm amber (#d4a043)", () => {
      expect(getScheme("canopy").tokens["status-warning"]).toBe("#d4a043");
    });

    it("status-error is soft coral (#d97979)", () => {
      expect(getScheme("canopy").tokens["status-error"]).toBe("#d97979");
    });

    it("status-info is blue-gray (#7f8ea3)", () => {
      expect(getScheme("canopy").tokens["status-info"]).toBe("#7f8ea3");
    });

    it("state-working is green, not canopy-accent blue", () => {
      const tokens = getScheme("canopy").tokens;
      expect(tokens["state-working"]).not.toBe(tokens["canopy-accent"]);
      expect(tokens["state-working"]).toBe("#22c55e");
    });

    it("state-active is green, not canopy-accent blue", () => {
      const tokens = getScheme("canopy").tokens;
      expect(tokens["state-active"]).not.toBe(tokens["canopy-accent"]);
      expect(tokens["state-active"]).toBe("#22c55e");
    });

    it("server-running matches status-success", () => {
      const tokens = getScheme("canopy").tokens;
      expect(tokens["server-running"]).toBe(tokens["status-success"]);
    });

    it("server-stopped matches state-idle", () => {
      const tokens = getScheme("canopy").tokens;
      expect(tokens["server-stopped"]).toBe(tokens["state-idle"]);
    });

    it("server-starting matches status-warning", () => {
      const tokens = getScheme("canopy").tokens;
      expect(tokens["server-starting"]).toBe(tokens["status-warning"]);
    });

    it("server-error matches status-error", () => {
      const tokens = getScheme("canopy").tokens;
      expect(tokens["server-error"]).toBe(tokens["status-error"]);
    });
  });

  describe("semantic alias invariants — canopy-slate scheme", () => {
    it("state-working is green, not canopy-accent blue", () => {
      const tokens = getScheme("canopy-slate").tokens;
      expect(tokens["state-working"]).not.toBe(tokens["canopy-accent"]);
      expect(tokens["state-working"]).toBe("#22c55e");
    });

    it("state-active is green, not canopy-accent blue", () => {
      const tokens = getScheme("canopy-slate").tokens;
      expect(tokens["state-active"]).not.toBe(tokens["canopy-accent"]);
      expect(tokens["state-active"]).toBe("#22c55e");
    });

    it("server-running matches status-success", () => {
      const tokens = getScheme("canopy-slate").tokens;
      expect(tokens["server-running"]).toBe(tokens["status-success"]);
    });

    it("server-stopped matches state-idle", () => {
      const tokens = getScheme("canopy-slate").tokens;
      expect(tokens["server-stopped"]).toBe(tokens["state-idle"]);
    });

    it("server-starting matches status-warning", () => {
      const tokens = getScheme("canopy-slate").tokens;
      expect(tokens["server-starting"]).toBe(tokens["status-warning"]);
    });

    it("server-error matches status-error", () => {
      const tokens = getScheme("canopy-slate").tokens;
      expect(tokens["server-error"]).toBe(tokens["status-error"]);
    });
  });
});
