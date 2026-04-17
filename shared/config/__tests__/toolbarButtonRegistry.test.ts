import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  registerToolbarButton,
  getToolbarButtonConfig,
  getPluginToolbarButtonIds,
  isRegisteredPluginButton,
  unregisterPluginToolbarButtons,
  clearToolbarButtonRegistry,
  type ToolbarButtonConfig,
} from "../toolbarButtonRegistry.js";

beforeEach(() => {
  clearToolbarButtonRegistry();
});

const makeConfig = (id: string, overrides?: Partial<ToolbarButtonConfig>): ToolbarButtonConfig => ({
  id: id as ToolbarButtonConfig["id"],
  label: "Test Button",
  iconId: "puzzle",
  actionId: "test.action",
  priority: 3,
  pluginId: "test-plugin",
  ...overrides,
});

describe("toolbarButtonRegistry", () => {
  it("registers a button and retrieves it by ID", () => {
    const config = makeConfig("plugin.test-plugin.viewer");
    registerToolbarButton(config);

    expect(getToolbarButtonConfig("plugin.test-plugin.viewer")).toEqual(config);
    expect(getPluginToolbarButtonIds()).toEqual(["plugin.test-plugin.viewer"]);
  });

  it("returns undefined for unregistered IDs", () => {
    expect(getToolbarButtonConfig("plugin.unknown.button")).toBeUndefined();
  });

  it("returns empty array when no buttons registered", () => {
    expect(getPluginToolbarButtonIds()).toEqual([]);
  });

  it("warns and overwrites on duplicate registration", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = makeConfig("plugin.test-plugin.btn", { label: "First" });
    const second = makeConfig("plugin.test-plugin.btn", { label: "Second" });

    registerToolbarButton(first);
    registerToolbarButton(second);

    expect(spy).toHaveBeenCalledWith(
      'Toolbar button "plugin.test-plugin.btn" already registered, overwriting'
    );
    expect(getToolbarButtonConfig("plugin.test-plugin.btn")?.label).toBe("Second");
    expect(getPluginToolbarButtonIds()).toHaveLength(1);

    spy.mockRestore();
  });

  it("isRegisteredPluginButton returns true for registered plugin buttons", () => {
    registerToolbarButton(makeConfig("plugin.my-plugin.action"));
    expect(isRegisteredPluginButton("plugin.my-plugin.action")).toBe(true);
  });

  it("isRegisteredPluginButton returns false for built-in IDs", () => {
    expect(isRegisteredPluginButton("terminal")).toBe(false);
    expect(isRegisteredPluginButton("settings")).toBe(false);
  });

  it("isRegisteredPluginButton returns false for unregistered plugin IDs", () => {
    expect(isRegisteredPluginButton("plugin.unknown.button")).toBe(false);
  });

  it("clearToolbarButtonRegistry removes all entries", () => {
    registerToolbarButton(makeConfig("plugin.a.btn"));
    registerToolbarButton(makeConfig("plugin.b.btn"));
    expect(getPluginToolbarButtonIds()).toHaveLength(2);

    clearToolbarButtonRegistry();
    expect(getPluginToolbarButtonIds()).toHaveLength(0);
  });
});

describe("unregisterPluginToolbarButtons", () => {
  it("removes only buttons owned by the target plugin", () => {
    registerToolbarButton(makeConfig("plugin.owner-a.one", { pluginId: "owner-a" }));
    registerToolbarButton(makeConfig("plugin.owner-a.two", { pluginId: "owner-a" }));
    registerToolbarButton(makeConfig("plugin.owner-b.three", { pluginId: "owner-b" }));

    unregisterPluginToolbarButtons("owner-a");

    const remaining = getPluginToolbarButtonIds();
    expect(remaining).toEqual(["plugin.owner-b.three"]);
    expect(getToolbarButtonConfig("plugin.owner-a.one")).toBeUndefined();
    expect(getToolbarButtonConfig("plugin.owner-a.two")).toBeUndefined();
    expect(getToolbarButtonConfig("plugin.owner-b.three")?.pluginId).toBe("owner-b");
  });

  it("is a no-op when unregistering an unknown pluginId", () => {
    registerToolbarButton(makeConfig("plugin.owner-a.btn", { pluginId: "owner-a" }));
    expect(() => unregisterPluginToolbarButtons("never-loaded")).not.toThrow();
    expect(getPluginToolbarButtonIds()).toHaveLength(1);
  });

  it("is a no-op for empty or non-string pluginId (defensive input guard)", () => {
    registerToolbarButton(makeConfig("plugin.owner-a.btn", { pluginId: "owner-a" }));
    expect(() => unregisterPluginToolbarButtons("")).not.toThrow();
    expect(() => unregisterPluginToolbarButtons(undefined as unknown as string)).not.toThrow();
    expect(getPluginToolbarButtonIds()).toHaveLength(1);
  });

  it("is a no-op when unregistering the same plugin twice", () => {
    registerToolbarButton(makeConfig("plugin.owner-a.btn", { pluginId: "owner-a" }));
    unregisterPluginToolbarButtons("owner-a");
    expect(() => unregisterPluginToolbarButtons("owner-a")).not.toThrow();
    expect(getPluginToolbarButtonIds()).toHaveLength(0);
  });

  it("supports register → unregister → re-register round-trip", () => {
    registerToolbarButton(makeConfig("plugin.owner-a.btn", { pluginId: "owner-a", label: "V1" }));
    unregisterPluginToolbarButtons("owner-a");
    expect(getPluginToolbarButtonIds()).toHaveLength(0);

    registerToolbarButton(makeConfig("plugin.owner-a.btn", { pluginId: "owner-a", label: "V2" }));
    expect(getToolbarButtonConfig("plugin.owner-a.btn")?.label).toBe("V2");
  });
});
