import type { PluginManifest } from "../../electron/schemas/plugin.js";

export interface LoadedPluginInfo {
  manifest: PluginManifest;
  dir: string;
  resolvedRenderer?: string;
  loadedAt: number;
}
