import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  getPanelKindConfig,
  getExtensionFallbackDefaults,
  getPanelKindIds,
  getPluginPanelKinds,
  onPanelKindRegistered,
  onPanelKindUnregistered,
  panelKindUsesTerminalUi,
  registerPanelKind,
  unregisterPluginPanelKinds,
  clearPanelKindRegistry,
  getBuiltInPanelKinds,
  type PanelKindConfig,
} from "../panelKindRegistry.js";

describe("panelKindRegistry metadata", () => {
  it("extension fallback returns empty object", () => {
    const result = getExtensionFallbackDefaults();
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("dev-preview does not use terminal UI", () => {
    expect(panelKindUsesTerminalUi("dev-preview")).toBe(false);
  });

  it("terminal uses terminal UI", () => {
    expect(panelKindUsesTerminalUi("terminal")).toBe(true);
  });

  it("browser does not use terminal UI", () => {
    expect(panelKindUsesTerminalUi("browser")).toBe(false);
  });

  it('legacy "agent" kind is unregistered (collapsed into terminal)', () => {
    expect(getPanelKindConfig("agent")).toBeUndefined();
  });

  it("returns config for all built-in kinds", () => {
    for (const kind of ["terminal", "browser", "dev-preview"]) {
      const config = getPanelKindConfig(kind);
      expect(config).toBeDefined();
      expect(config!.id).toBe(kind);
    }
  });

  it("returns undefined for unknown kind", () => {
    expect(getPanelKindConfig("unknown-kind")).toBeUndefined();
  });
});

const BUILT_IN_KINDS = ["terminal", "browser", "dev-preview"] as const;

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

describe("clearPanelKindRegistry", () => {
  afterEach(() => {
    clearPanelKindRegistry();
  });

  it("removes extension-contributed panel kinds", () => {
    registerPanelKind({
      id: "ext-plugin.viewer",
      name: "Viewer",
      iconId: "eye",
      color: "#ff0000",
      hasPty: false,
      canRestart: false,
      canConvert: false,
      extensionId: "ext-plugin",
    });
    expect(getPanelKindConfig("ext-plugin.viewer")).toBeDefined();

    clearPanelKindRegistry();

    expect(getPanelKindConfig("ext-plugin.viewer")).toBeUndefined();
  });

  it("preserves all built-in panel kinds", () => {
    registerPanelKind({
      id: "ext-plugin.tmp",
      name: "Tmp",
      iconId: "eye",
      color: "#000",
      hasPty: false,
      canRestart: false,
      canConvert: false,
      extensionId: "ext-plugin",
    });

    clearPanelKindRegistry();

    for (const kind of getBuiltInPanelKinds()) {
      const config = getPanelKindConfig(kind);
      expect(config).toBeDefined();
      expect(config!.id).toBe(kind);
    }
  });

  it("is a no-op when no extension entries are registered", () => {
    expect(() => clearPanelKindRegistry()).not.toThrow();
    for (const kind of getBuiltInPanelKinds()) {
      expect(getPanelKindConfig(kind)).toBeDefined();
    }
  });
});

describe("getPluginPanelKinds", () => {
  afterEach(() => {
    clearPanelKindRegistry();
  });

  it("returns only entries with an extensionId", () => {
    expect(getPluginPanelKinds()).toEqual([]);

    registerPanelKind(makeExtensionConfig("ext-a.viewer", "ext-a"));
    registerPanelKind(makeExtensionConfig("ext-b.viewer", "ext-b"));

    const kinds = getPluginPanelKinds();
    expect(kinds.map((k) => k.id).sort()).toEqual(["ext-a.viewer", "ext-b.viewer"]);
    for (const kind of kinds) {
      expect(kind.extensionId).toBeDefined();
    }
  });

  it("never returns built-in kinds even when no plugins are registered", () => {
    expect(getPluginPanelKinds()).toEqual([]);
    for (const builtIn of BUILT_IN_KINDS) {
      expect(getPluginPanelKinds().some((k) => k.id === builtIn)).toBe(false);
    }
  });
});

describe("registry event listeners", () => {
  let unsubscribers: Array<() => void> = [];

  beforeEach(() => {
    unsubscribers = [];
  });

  afterEach(() => {
    for (const off of unsubscribers) off();
    unsubscribers = [];
    clearPanelKindRegistry();
  });

  it("onPanelKindRegistered fires for plugin kinds", () => {
    const listener = vi.fn();
    unsubscribers.push(onPanelKindRegistered(listener));

    const config = makeExtensionConfig("ext-a.viewer", "ext-a");
    registerPanelKind(config);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(config);
  });

  it("onPanelKindRegistered does NOT fire for re-registering a built-in", () => {
    const listener = vi.fn();
    unsubscribers.push(onPanelKindRegistered(listener));

    // Re-register the terminal built-in (no extensionId) — must not emit
    registerPanelKind({
      id: "terminal",
      name: "Terminal",
      iconId: "terminal",
      color: "#fff",
      hasPty: true,
      canRestart: true,
      canConvert: true,
    });

    expect(listener).not.toHaveBeenCalled();
  });

  it("onPanelKindUnregistered fires once per removed kind", () => {
    const listener = vi.fn();
    unsubscribers.push(onPanelKindUnregistered(listener));

    registerPanelKind(makeExtensionConfig("ext-a.one", "ext-a"));
    registerPanelKind(makeExtensionConfig("ext-a.two", "ext-a"));
    registerPanelKind(makeExtensionConfig("ext-b.three", "ext-b"));

    unregisterPluginPanelKinds("ext-a");

    expect(listener).toHaveBeenCalledTimes(2);
    const calledIds = listener.mock.calls.map((call) => call[0]).sort();
    expect(calledIds).toEqual(["ext-a.one", "ext-a.two"]);
  });

  it("onPanelKindUnregistered does not fire when no kinds are removed", () => {
    const listener = vi.fn();
    unsubscribers.push(onPanelKindUnregistered(listener));

    unregisterPluginPanelKinds("never-loaded");

    expect(listener).not.toHaveBeenCalled();
  });

  it("unsubscribe stops further notifications", () => {
    const listener = vi.fn();
    const unsubscribe = onPanelKindRegistered(listener);
    unsubscribe();

    registerPanelKind(makeExtensionConfig("ext-a.viewer", "ext-a"));

    expect(listener).not.toHaveBeenCalled();
  });

  it("double-unsubscribe is safe", () => {
    const listener = vi.fn();
    const unsubscribe = onPanelKindRegistered(listener);
    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();
  });

  it("clearPanelKindRegistry fires unregister listeners for removed plugin kinds", () => {
    const listener = vi.fn();
    unsubscribers.push(onPanelKindUnregistered(listener));

    registerPanelKind(makeExtensionConfig("ext-a.viewer", "ext-a"));
    registerPanelKind(makeExtensionConfig("ext-b.viewer", "ext-b"));

    clearPanelKindRegistry();

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("a listener that throws does not block other listeners", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const throwingListener = vi.fn(() => {
      throw new Error("boom");
    });
    const goodListener = vi.fn();
    unsubscribers.push(onPanelKindRegistered(throwingListener));
    unsubscribers.push(onPanelKindRegistered(goodListener));

    registerPanelKind(makeExtensionConfig("ext-a.viewer", "ext-a"));

    expect(throwingListener).toHaveBeenCalledTimes(1);
    expect(goodListener).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
