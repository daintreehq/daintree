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

// Read-only snapshot of one plugin's managed child processes (#9234). Scoped
// STRICTLY to the requested pluginId — a missing/empty id returns an empty list
// rather than dumping every plugin's process command lines (args can carry
// tokens). Cross-plugin spoofing of `pluginId` from an untrusted renderer is
// the deferred per-sender ownership work (D2 / freeze finding #7); this handler
// only removes the trivial "omit the arg to see everything" disclosure.
async function handleList(pluginId?: string): Promise<PluginProcessInfo[]> {
  if (typeof pluginId !== "string" || pluginId.length === 0) return [];
  return (await getPluginService()).listManagedProcesses(pluginId);
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
