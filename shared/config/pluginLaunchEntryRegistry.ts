import type { PluginLaunchEntryConfig } from "../types/plugin.js";

/**
 * Main's registry of plugin launch entries (#13788), keyed by the runtime entry
 * id `{pluginId}.{entry id}`. Filled from `loadPlugin()` and emptied from
 * `unloadPlugin()`; the renderer receives it per project through the
 * contribution broadcaster.
 */
const LAUNCH_ENTRY_REGISTRY = new Map<string, PluginLaunchEntryConfig>();

export function registerPluginLaunchEntry(config: PluginLaunchEntryConfig): void {
  if (LAUNCH_ENTRY_REGISTRY.has(config.id)) {
    console.warn(`Launch entry "${config.id}" already registered, overwriting`);
  }
  LAUNCH_ENTRY_REGISTRY.set(config.id, config);
}

export function getAllPluginLaunchEntries(): PluginLaunchEntryConfig[] {
  return [...LAUNCH_ENTRY_REGISTRY.values()];
}

export function unregisterPluginLaunchEntries(pluginId: string): void {
  if (typeof pluginId !== "string" || pluginId.length === 0) return;
  for (const [id, config] of LAUNCH_ENTRY_REGISTRY) {
    if (config.pluginId === pluginId) LAUNCH_ENTRY_REGISTRY.delete(id);
  }
}

export function clearPluginLaunchEntryRegistry(): void {
  LAUNCH_ENTRY_REGISTRY.clear();
}
