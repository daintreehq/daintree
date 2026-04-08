import { describe, it, expect, vi } from "vitest";
import { getPanelKindConfig } from "@shared/config/panelKindRegistry";
import { initBuiltInPanelKinds } from "../registry";

describe("initBuiltInPanelKinds", () => {
  it("registers serialize and createDefaults on built-in kinds", () => {
    initBuiltInPanelKinds();

    for (const kind of ["terminal", "agent", "browser", "notes", "dev-preview"]) {
      const config = getPanelKindConfig(kind);
      expect(config?.serialize, `${kind} should have serialize`).toBeTypeOf("function");
      expect(config?.createDefaults, `${kind} should have createDefaults`).toBeTypeOf("function");
    }
  });

  it("calling twice does not trigger overwrite warnings", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    initBuiltInPanelKinds();
    initBuiltInPanelKinds();

    const panelKindWarnings = warnSpy.mock.calls.filter(
      (args) => typeof args[0] === "string" && args[0].includes("already registered")
    );
    expect(panelKindWarnings).toHaveLength(0);

    warnSpy.mockRestore();
  });

  it("preserves config identity across calls", () => {
    initBuiltInPanelKinds();
    const first = getPanelKindConfig("browser");

    initBuiltInPanelKinds();
    const second = getPanelKindConfig("browser");

    expect(first?.serialize).toBe(second?.serialize);
  });
});
