import { defineIpcNamespace, op } from "../define.js";
import { PLUGIN_PROCESS_METHOD_CHANNELS } from "./pluginProcess.preload.js";
import type * as PluginServiceModule from "../../services/PluginService.js";
import type { PluginProcessInfo } from "../../../shared/types/ipc/pluginProcess.js";

type PluginServiceSingleton = typeof PluginServiceModule.pluginService;

// Lazy accessor (mirrors plugin.ts): PluginService is large and pulls
// semver/ajv/yauzl — a static import here would re-anchor it on the eager
// startup path.
let cachedPluginService: PluginServiceSingleton | null = null;
async function getPluginService(): Promise<PluginServiceSingleton> {
  if (!cachedPluginService) {
    const mod = await import("../../services/PluginService.js");
    cachedPluginService = mod.pluginService;
  }
  return cachedPluginService;
}

// Read-only snapshot of plugin-managed child processes (#9234) for a renderer
// process/task dashboard. `pluginId` is an optional scope filter; an invalid
// value yields the full list rather than throwing — this is observability, not
// a control surface (lifecycle is driven by the plugin's own host.process API).
async function handleList(pluginId?: string): Promise<PluginProcessInfo[]> {
  const scope = typeof pluginId === "string" && pluginId.length > 0 ? pluginId : undefined;
  return (await getPluginService()).listManagedProcesses(scope);
}

export const pluginProcessNamespace = defineIpcNamespace({
  name: "pluginProcess",
  ops: {
    list: op(PLUGIN_PROCESS_METHOD_CHANNELS.list, handleList),
  },
});

export function registerPluginProcessHandlers(): () => void {
  return pluginProcessNamespace.register();
}
