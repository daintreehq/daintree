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
});
