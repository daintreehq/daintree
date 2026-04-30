import type { MenuItemContribution } from "../../shared/types/plugin.js";

const PLUGIN_MENU_ITEMS = new Map<string, MenuItemContribution[]>();

export function registerPluginMenuItem(pluginId: string, item: MenuItemContribution): void {
  const items = PLUGIN_MENU_ITEMS.get(pluginId) ?? [];
  items.push(item);
  PLUGIN_MENU_ITEMS.set(pluginId, items);
}

export function getPluginMenuItems(): Array<{ pluginId: string; item: MenuItemContribution }> {
  const result: Array<{ pluginId: string; item: MenuItemContribution }> = [];
  for (const [pluginId, items] of PLUGIN_MENU_ITEMS) {
    for (const item of items) {
      result.push({ pluginId, item });
    }
  }
  return result;
}

export function unregisterPluginMenuItems(pluginId: string): void {
  if (typeof pluginId !== "string" || pluginId.length === 0) return;
  PLUGIN_MENU_ITEMS.delete(pluginId);
}

export function clearPluginMenuRegistry(): void {
  PLUGIN_MENU_ITEMS.clear();
}
