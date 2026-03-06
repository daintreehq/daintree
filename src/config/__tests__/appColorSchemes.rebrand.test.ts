import { describe, it, expect } from "vitest";
import { BUILT_IN_APP_SCHEMES } from "../appColorSchemes";
import type { AppColorSchemeTokens } from "@shared/types/appTheme";

describe("appColorSchemes rebrand — semantic color separation", () => {
  const canopy = BUILT_IN_APP_SCHEMES.find((s) => s.id === "canopy");
  const slate = BUILT_IN_APP_SCHEMES.find((s) => s.id === "canopy-slate");

  it("canopy scheme exists", () => {
    expect(canopy).toBeDefined();
  });

  it("canopy-slate scheme exists", () => {
    expect(slate).toBeDefined();
  });

  it("no scheme contains canopy-success token", () => {
    for (const scheme of BUILT_IN_APP_SCHEMES) {
      expect(Object.keys(scheme.tokens)).not.toContain("canopy-success");
    }
  });

  it("canopy scheme has softened status-warning (#d4a043)", () => {
    expect(canopy!.tokens["status-warning"]).toBe("#d4a043");
  });

  it("canopy scheme has softened status-error (#d97979)", () => {
    expect(canopy!.tokens["status-error"]).toBe("#d97979");
  });

  it("canopy scheme has blue-gray status-info (#7f8ea3)", () => {
    expect(canopy!.tokens["status-info"]).toBe("#7f8ea3");
  });

  it("canopy scheme server-starting matches status-warning", () => {
    expect(canopy!.tokens["server-starting"]).toBe(canopy!.tokens["status-warning"]);
  });

  it("canopy scheme server-error matches status-error", () => {
    expect(canopy!.tokens["server-error"]).toBe(canopy!.tokens["status-error"]);
  });

  it("canopy scheme server-running matches status-success", () => {
    expect(canopy!.tokens["server-running"]).toBe(canopy!.tokens["status-success"]);
  });

  it("canopy scheme server-stopped matches state-idle", () => {
    expect(canopy!.tokens["server-stopped"]).toBe(canopy!.tokens["state-idle"]);
  });

  it("canopy scheme state-working matches canopy-accent (blue, not green)", () => {
    expect(canopy!.tokens["state-working"]).toBe(canopy!.tokens["canopy-accent"]);
  });

  it("canopy scheme state-active matches canopy-accent (blue)", () => {
    expect(canopy!.tokens["state-active"]).toBe(canopy!.tokens["canopy-accent"]);
  });

  it("all built-in schemes have all required token keys", () => {
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

    for (const scheme of BUILT_IN_APP_SCHEMES) {
      for (const key of requiredKeys) {
        expect(scheme.tokens).toHaveProperty(key, expect.any(String));
      }
    }
  });
});
