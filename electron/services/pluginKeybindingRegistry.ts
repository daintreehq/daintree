import type { KeybindingContribution } from "../../shared/types/plugin.js";

const PLUGIN_KEYBINDINGS = new Map<string, KeybindingContribution[]>();

export function registerPluginKeybinding(pluginId: string, item: KeybindingContribution): void {
  const items = PLUGIN_KEYBINDINGS.get(pluginId) ?? [];
  items.push(item);
  PLUGIN_KEYBINDINGS.set(pluginId, items);
}

export function getPluginKeybindings(): Array<{ pluginId: string; item: KeybindingContribution }> {
  const result: Array<{ pluginId: string; item: KeybindingContribution }> = [];
  for (const [pluginId, items] of PLUGIN_KEYBINDINGS) {
    for (const item of items) {
      result.push({ pluginId, item });
    }
  }
  return result;
}

export function unregisterPluginKeybindings(pluginId: string): void {
  PLUGIN_KEYBINDINGS.delete(pluginId);
}

export function clearPluginKeybindingRegistry(): void {
  PLUGIN_KEYBINDINGS.clear();
}
