import { beforeEach, describe, expect, it } from "vitest";
import type { MenuItemContribution } from "../../../shared/types/plugin.js";
import {
  clearPluginMenuRegistry,
  getPluginMenuItems,
  registerPluginMenuItem,
  unregisterPluginMenuItems,
} from "../pluginMenuRegistry.js";

beforeEach(() => {
  clearPluginMenuRegistry();
});

const makeItem = (label: string): MenuItemContribution => ({
  label,
  actionId: `test.${label.toLowerCase().replace(/\s+/g, "-")}`,
  location: "terminal",
});

describe("pluginMenuRegistry", () => {
  it("registers items under a plugin and retrieves them", () => {
    registerPluginMenuItem("plugin-a", makeItem("Open"));
    registerPluginMenuItem("plugin-a", makeItem("Close"));

    const items = getPluginMenuItems();
    expect(items).toHaveLength(2);
    expect(items.every((entry) => entry.pluginId === "plugin-a")).toBe(true);
  });

  it("unregisters only the target plugin's items", () => {
    registerPluginMenuItem("plugin-a", makeItem("A1"));
    registerPluginMenuItem("plugin-a", makeItem("A2"));
    registerPluginMenuItem("plugin-b", makeItem("B1"));

    unregisterPluginMenuItems("plugin-a");

    const items = getPluginMenuItems();
    expect(items).toHaveLength(1);
    expect(items[0].pluginId).toBe("plugin-b");
    expect(items[0].item.label).toBe("B1");
  });

  it("is a no-op when unregistering an unknown pluginId", () => {
    registerPluginMenuItem("plugin-a", makeItem("A1"));
    expect(() => unregisterPluginMenuItems("never-loaded")).not.toThrow();
    expect(getPluginMenuItems()).toHaveLength(1);
  });

  it("is a no-op for empty or non-string pluginId (defensive input guard)", () => {
    registerPluginMenuItem("plugin-a", makeItem("A1"));
    expect(() => unregisterPluginMenuItems("")).not.toThrow();
    expect(() => unregisterPluginMenuItems(undefined as unknown as string)).not.toThrow();
    expect(getPluginMenuItems()).toHaveLength(1);
  });

  it("is a no-op when unregistering the same plugin twice", () => {
    registerPluginMenuItem("plugin-a", makeItem("A1"));
    unregisterPluginMenuItems("plugin-a");
    expect(() => unregisterPluginMenuItems("plugin-a")).not.toThrow();
    expect(getPluginMenuItems()).toHaveLength(0);
  });

  it("supports register → unregister → re-register round-trip", () => {
    registerPluginMenuItem("plugin-a", makeItem("Initial"));
    unregisterPluginMenuItems("plugin-a");
    expect(getPluginMenuItems()).toHaveLength(0);

    registerPluginMenuItem("plugin-a", makeItem("Fresh"));
    const items = getPluginMenuItems();
    expect(items).toHaveLength(1);
    expect(items[0].item.label).toBe("Fresh");
  });

  it("clearPluginMenuRegistry removes all plugins' items", () => {
    registerPluginMenuItem("plugin-a", makeItem("A"));
    registerPluginMenuItem("plugin-b", makeItem("B"));

    clearPluginMenuRegistry();
    expect(getPluginMenuItems()).toHaveLength(0);
  });
});
