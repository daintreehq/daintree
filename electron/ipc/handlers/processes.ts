import { defineIpcNamespace, op } from "../define.js";
import { PROCESSES_METHOD_CHANNELS } from "./processes.preload.js";
import type { HandlerDependencies } from "../types.js";
import type { ProcessInventorySnapshot } from "../../../shared/types/processes.js";
import type * as PluginServiceModule from "../../services/PluginService.js";
import { collectProcessInventory } from "../../services/processInventory.js";
import { projectStore } from "../../services/ProjectStore.js";
import { scratchStore } from "../../services/ScratchStore.js";
import { getAppMetricsSnapshot } from "../../utils/appMetricsSnapshot.js";

type PluginServiceSingleton = typeof PluginServiceModule.pluginService;

// Lazy (mirrors pluginProcess.ts): a static import would put PluginService on
// the eager startup path.
let cachedPluginService: PluginServiceSingleton | null = null;
async function getPluginService(): Promise<PluginServiceSingleton> {
  if (!cachedPluginService) {
    const mod = await import("../../services/PluginService.js");
    cachedPluginService = mod.pluginService;
  }
  return cachedPluginService;
}

/**
 * The processes view (#13175). Its own namespace and deliberately not an
 * action: the list is global across projects, and the action manifest is the
 * MCP tool surface.
 */
export function createProcessesNamespace(deps: Pick<HandlerDependencies, "ptyClient">) {
  return defineIpcNamespace({
    name: "processes",
    ops: {
      getSnapshot: op(
        PROCESSES_METHOD_CHANNELS.getSnapshot,
        async (): Promise<ProcessInventorySnapshot> =>
          collectProcessInventory({
            getHostInventory: async (extraPids) =>
              deps.ptyClient
                ? deps.ptyClient.getProcessInventory(extraPids)
                : { inventories: [], shardsTotal: 1, shardsFailed: 1 },
            getWorkspaceNames: () => [
              ...projectStore.getAllProjectIdentities(),
              ...scratchStore.getAllScratches(),
            ],
            getPluginProcesses: async () => {
              const pluginService = await getPluginService();
              return {
                children: pluginService.listManagedProcesses(),
                workers: pluginService.getWorkerGovernanceSnapshots(),
              };
            },
            getAppMetrics: () => getAppMetricsSnapshot(),
          })
      ),
    },
  });
}

export function registerProcessesHandlers(deps: HandlerDependencies): () => void {
  return createProcessesNamespace(deps).register();
}
