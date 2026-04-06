import { describe, it, expect } from "vitest";
import {
  getPanelKindConfig,
  getExtensionFallbackDefaults,
  panelKindUsesTerminalUi,
} from "../panelKindRegistry.js";

describe("panelKindRegistry metadata", () => {
  it("extension fallback returns base non-PTY fields", () => {
    const result = getExtensionFallbackDefaults();
    expect(result.type).toBe("terminal");
    expect(result.cwd).toBe("");
    expect(result.cols).toBe(80);
    expect(result.rows).toBe(24);
  });

  it("dev-preview does not use terminal UI", () => {
    expect(panelKindUsesTerminalUi("dev-preview")).toBe(false);
  });

  it("terminal and agent use terminal UI", () => {
    expect(panelKindUsesTerminalUi("terminal")).toBe(true);
    expect(panelKindUsesTerminalUi("agent")).toBe(true);
  });

  it("browser and notes do not use terminal UI", () => {
    expect(panelKindUsesTerminalUi("browser")).toBe(false);
    expect(panelKindUsesTerminalUi("notes")).toBe(false);
  });

  it("returns config for all built-in kinds", () => {
    for (const kind of ["terminal", "agent", "browser", "notes", "dev-preview"]) {
      const config = getPanelKindConfig(kind);
      expect(config).toBeDefined();
      expect(config!.id).toBe(kind);
    }
  });

  it("returns undefined for unknown kind", () => {
    expect(getPanelKindConfig("unknown-kind")).toBeUndefined();
  });
});
