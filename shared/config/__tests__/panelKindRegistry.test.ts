import { afterEach, describe, it, expect } from "vitest";
import {
  getPanelKindConfig,
  getExtensionFallbackDefaults,
  getPanelKindIds,
  panelKindUsesTerminalUi,
  registerPanelKind,
  unregisterPluginPanelKinds,
  type PanelKindConfig,
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

const BUILT_IN_KINDS = ["terminal", "agent", "browser", "notes", "dev-preview"] as const;

const makeExtensionConfig = (id: string, extensionId: string): PanelKindConfig => ({
  id,
  name: `${extensionId}:${id}`,
  iconId: "puzzle",
  color: "#123456",
  hasPty: false,
  canRestart: false,
  canConvert: false,
  extensionId,
});

describe("unregisterPluginPanelKinds", () => {
  // Use afterEach so cleanup still runs when a test fails.
  afterEach(() => {
    unregisterPluginPanelKinds("ext-a");
    unregisterPluginPanelKinds("ext-b");
  });

  it("removes only entries owned by the target plugin", () => {
    registerPanelKind(makeExtensionConfig("ext-a.one", "ext-a"));
    registerPanelKind(makeExtensionConfig("ext-a.two", "ext-a"));
    registerPanelKind(makeExtensionConfig("ext-b.three", "ext-b"));

    unregisterPluginPanelKinds("ext-a");

    expect(getPanelKindConfig("ext-a.one")).toBeUndefined();
    expect(getPanelKindConfig("ext-a.two")).toBeUndefined();
    expect(getPanelKindConfig("ext-b.three")?.extensionId).toBe("ext-b");
  });

  it("never removes built-in panel kinds", () => {
    registerPanelKind(makeExtensionConfig("ext-a.viewer", "ext-a"));

    // Calling with any plugin ID (even matching no entries, empty string, or
    // a typecast undefined) must preserve built-ins. The input guard blocks the
    // dangerous `undefined` case where built-ins' extensionId is also undefined.
    unregisterPluginPanelKinds("ext-a");
    unregisterPluginPanelKinds("never-loaded");
    unregisterPluginPanelKinds("");
    unregisterPluginPanelKinds(undefined as unknown as string);

    for (const kind of BUILT_IN_KINDS) {
      const config = getPanelKindConfig(kind);
      expect(config, `built-in panel kind "${kind}" must survive unregister`).toBeDefined();
      expect(config!.id).toBe(kind);
      expect(config!.extensionId).toBeUndefined();
    }
  });

  it("is a no-op when unregistering an unknown pluginId", () => {
    const before = getPanelKindIds().length;
    expect(() => unregisterPluginPanelKinds("never-loaded")).not.toThrow();
    expect(getPanelKindIds()).toHaveLength(before);
  });

  it("is a no-op when unregistering the same plugin twice", () => {
    registerPanelKind(makeExtensionConfig("ext-a.viewer", "ext-a"));
    unregisterPluginPanelKinds("ext-a");
    expect(() => unregisterPluginPanelKinds("ext-a")).not.toThrow();
    expect(getPanelKindConfig("ext-a.viewer")).toBeUndefined();
  });

  it("supports register → unregister → re-register round-trip", () => {
    registerPanelKind(makeExtensionConfig("ext-a.viewer", "ext-a"));
    unregisterPluginPanelKinds("ext-a");
    expect(getPanelKindConfig("ext-a.viewer")).toBeUndefined();

    registerPanelKind({ ...makeExtensionConfig("ext-a.viewer", "ext-a"), name: "Refreshed" });
    expect(getPanelKindConfig("ext-a.viewer")?.name).toBe("Refreshed");
  });

  it("leaves other plugins' entries intact when one plugin is unregistered", () => {
    registerPanelKind(makeExtensionConfig("ext-a.panel", "ext-a"));
    registerPanelKind(makeExtensionConfig("ext-b.panel", "ext-b"));

    unregisterPluginPanelKinds("ext-a");

    expect(getPanelKindConfig("ext-a.panel")).toBeUndefined();
    expect(getPanelKindConfig("ext-b.panel")?.extensionId).toBe("ext-b");
  });
});
