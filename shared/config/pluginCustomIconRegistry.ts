import type { PluginCustomIconAsset } from "./pluginCustomIcon.js";

/**
 * Main-process registry of the custom SVG icons each loaded plugin ships
 * (#13143). One entry per plugin instance, replaced wholesale on reload and
 * dropped on unload; the renderer receives the flattened, project-filtered
 * list over `plugin.icons` / `plugin:icons-changed`.
 */
const byPlugin = new Map<string, PluginCustomIconAsset[]>();

/** Replace `pluginId`'s icon set. An empty list clears it. */
export function registerPluginCustomIcons(
  pluginId: string,
  assets: readonly PluginCustomIconAsset[]
): void {
  if (assets.length === 0) {
    byPlugin.delete(pluginId);
    return;
  }
  byPlugin.set(pluginId, [...assets]);
}

/** Drop every icon `pluginId` registered. Returns whether anything was removed. */
export function unregisterPluginCustomIcons(pluginId: string): boolean {
  return byPlugin.delete(pluginId);
}

export function getPluginCustomIcons(): PluginCustomIconAsset[] {
  return [...byPlugin.values()].flat();
}

/** Test-isolation helper. */
export function clearPluginCustomIconsForTests(): void {
  byPlugin.clear();
}
