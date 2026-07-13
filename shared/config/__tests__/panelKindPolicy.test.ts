import { describe, it, expect } from "vitest";
import {
  DEFAULT_PANEL_KIND_POLICY,
  getPanelKindConfig,
  resolvePanelKindPolicy,
  type PanelKindConfig,
} from "../panelKindRegistry.js";

describe("DEFAULT_PANEL_KIND_POLICY", () => {
  it("captures today's universal behavior so the additive descriptor is a strict superset", () => {
    expect(DEFAULT_PANEL_KIND_POLICY).toEqual({
      dockFallbackTarget: "first-grid",
      defaultFocusOnCreate: true,
      dockPopoverOnSpawn: true,
      closeBehavior: "trash",
    });
  });
});

describe("resolvePanelKindPolicy", () => {
  it("returns the default policy when called with undefined", () => {
    expect(resolvePanelKindPolicy(undefined)).toEqual(DEFAULT_PANEL_KIND_POLICY);
  });

  it("returns the default policy for a kind that omits the policy block", () => {
    expect(resolvePanelKindPolicy("terminal")).toEqual(DEFAULT_PANEL_KIND_POLICY);
    expect(resolvePanelKindPolicy("dev-preview")).toEqual(DEFAULT_PANEL_KIND_POLICY);
  });

  it("layers a kind's declared policy over the default", () => {
    // Review and browser are reading surfaces: focus returns to what the user
    // was last viewing when the panel leaves the grid.
    for (const kind of ["review", "browser"] as const) {
      expect(getPanelKindConfig(kind)).toBeDefined();
      expect(resolvePanelKindPolicy(kind)).toEqual({
        ...DEFAULT_PANEL_KIND_POLICY,
        dockFallbackTarget: "previous-focused",
      });
    }
  });

  it("accepts a PanelKindConfig directly to skip the registry lookup", () => {
    const config: PanelKindConfig = {
      id: "synthetic",
      name: "Synthetic",
      iconId: "test",
      color: "#000",
      hasPty: false,
      canRestart: false,
      canConvert: false,
      policy: { dockPopoverOnSpawn: false, defaultFocusOnCreate: false },
    };
    expect(resolvePanelKindPolicy(config)).toEqual({
      ...DEFAULT_PANEL_KIND_POLICY,
      dockPopoverOnSpawn: false,
      defaultFocusOnCreate: false,
    });
  });

  it("treats an unknown kind id as undefined (default policy)", () => {
    expect(resolvePanelKindPolicy("does-not-exist")).toEqual(DEFAULT_PANEL_KIND_POLICY);
  });

  it("treats a config with an empty policy object as equivalent to omitting policy", () => {
    const config: PanelKindConfig = {
      id: "synthetic",
      name: "Synthetic",
      iconId: "test",
      color: "#000",
      hasPty: false,
      canRestart: false,
      canConvert: false,
      policy: {},
    };
    expect(resolvePanelKindPolicy(config)).toEqual(DEFAULT_PANEL_KIND_POLICY);
  });

  it("preserves unknown dockFallbackTarget strings on the resolved object (caller decides how to degrade)", () => {
    // Open union — plugins may declare custom strategies. Resolver doesn't
    // sanitize; downstream call sites silently degrade unknown values to
    // first-grid behavior. Verify the field round-trips so a plugin can
    // detect its own strategy.
    const config: PanelKindConfig = {
      id: "synthetic",
      name: "Synthetic",
      iconId: "test",
      color: "#000",
      hasPty: false,
      canRestart: false,
      canConvert: false,
      policy: { dockFallbackTarget: "plugin-custom-strategy" },
    };
    expect(resolvePanelKindPolicy(config).dockFallbackTarget).toBe("plugin-custom-strategy");
  });
});
