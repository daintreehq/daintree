import type { PluginLayoutConfig } from "../types/plugin.js";

/**
 * Main's registry of plugin layouts (#13780), keyed by the runtime layout id
 * `{pluginId}.{layout id}`. Filled from `loadPlugin()` and emptied from
 * `unloadPlugin()`; the renderer receives it per project through the
 * contribution broadcaster.
 */
const LAYOUT_REGISTRY = new Map<string, PluginLayoutConfig>();

export function registerPluginLayout(config: PluginLayoutConfig): void {
  if (LAYOUT_REGISTRY.has(config.id)) {
    console.warn(`Layout "${config.id}" already registered, overwriting`);
  }
  LAYOUT_REGISTRY.set(config.id, config);
}

export function getAllPluginLayouts(): PluginLayoutConfig[] {
  return [...LAYOUT_REGISTRY.values()];
}

export function unregisterPluginLayouts(pluginId: string): void {
  if (typeof pluginId !== "string" || pluginId.length === 0) return;
  for (const [id, config] of LAYOUT_REGISTRY) {
    if (config.pluginId === pluginId) LAYOUT_REGISTRY.delete(id);
  }
}

export function clearPluginLayoutRegistry(): void {
  LAYOUT_REGISTRY.clear();
}
