import type { ContextMenuContribution } from "../../shared/types/plugin.js";

const PLUGIN_CONTEXT_MENUS = new Map<string, ContextMenuContribution[]>();

export function registerPluginContextMenuItem(
  pluginId: string,
  item: ContextMenuContribution
): void {
  const items = PLUGIN_CONTEXT_MENUS.get(pluginId) ?? [];
  items.push(item);
  PLUGIN_CONTEXT_MENUS.set(pluginId, items);
}

export function getPluginContextMenuItems(): Array<{
  pluginId: string;
  item: ContextMenuContribution;
}> {
  const result: Array<{ pluginId: string; item: ContextMenuContribution }> = [];
  for (const [pluginId, items] of PLUGIN_CONTEXT_MENUS) {
    for (const item of items) {
      result.push({ pluginId, item });
    }
  }
  return result;
}

export function unregisterPluginContextMenuItems(pluginId: string): void {
  PLUGIN_CONTEXT_MENUS.delete(pluginId);
}

export function clearPluginContextMenuRegistry(): void {
  PLUGIN_CONTEXT_MENUS.clear();
}
