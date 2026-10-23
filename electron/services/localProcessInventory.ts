import type { ProcessInventorySnapshot } from "../../shared/types/processes.js";
import type * as PluginServiceModule from "./PluginService.js";
import type { PtyClient } from "./PtyClient.js";
import { collectProcessInventory } from "./processInventory.js";
import { getLineageReapReport } from "./TerminalLineageLedger.js";
import { projectStore } from "./ProjectStore.js";
import { scratchStore } from "./ScratchStore.js";
import { getAppMetricsSnapshot } from "../utils/appMetricsSnapshot.js";

type PluginServiceSingleton = typeof PluginServiceModule.pluginService;

// Lazy (mirrors pluginProcess.ts): a static import would put PluginService on
// the eager startup path.
let cachedPluginService: PluginServiceSingleton | null = null;
async function getPluginService(): Promise<PluginServiceSingleton> {
  if (!cachedPluginService) {
    const mod = await import("./PluginService.js");
    cachedPluginService = mod.pluginService;
  }
  return cachedPluginService;
}

type InventoryPtyClient = Pick<PtyClient, "getProcessInventory">;

/**
 * This machine's process inventory, as the processes view and a Shell asking
 * this host over its link both read it. The PTY client is resolved per read.
 */
export function readLocalProcessInventory(
  getPtyClient: () => InventoryPtyClient | null | undefined
): Promise<ProcessInventorySnapshot> {
  return collectProcessInventory({
    getHostInventory: async (extraPids) => {
      const ptyClient = getPtyClient();
      return ptyClient
        ? ptyClient.getProcessInventory(extraPids)
        : { inventories: [], shardsTotal: 1, shardsFailed: 1 };
    },
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
    getCleanupReport: () => getLineageReapReport(),
  });
}
