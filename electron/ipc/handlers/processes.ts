import { defineIpcNamespace, op } from "../define.js";
import { PROCESSES_METHOD_CHANNELS } from "./processes.preload.js";
import type { HandlerDependencies } from "../types.js";
import type {
  ClosedProcessKillResult,
  ClosedProcessKillTarget,
  ProcessInventorySnapshot,
} from "../../../shared/types/processes.js";
import type * as PluginServiceModule from "../../services/PluginService.js";
import { collectProcessInventory } from "../../services/processInventory.js";
import { getLineageReapReport } from "../../services/TerminalLineageLedger.js";
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
            getCleanupReport: () => getLineageReapReport(),
          })
      ),
      killClosedTerminalProcesses: op(
        PROCESSES_METHOD_CHANNELS.killClosedTerminalProcesses,
        async (targets: ClosedProcessKillTarget[]): Promise<ClosedProcessKillResult> => {
          if (!Array.isArray(targets)) throw new Error("Expected a list of processes to kill");
          const valid = targets.filter(
            (target): target is ClosedProcessKillTarget =>
              typeof target === "object" &&
              target !== null &&
              Number.isInteger(target.pid) &&
              target.pid > 1 &&
              typeof target.startTime === "string" &&
              target.startTime.length > 0
          );
          if (!deps.ptyClient) {
            return { ended: 0, stillRunning: 0, unchecked: valid.length, notTracked: 0 };
          }
          return deps.ptyClient.killClosedTerminalProcesses(valid);
        }
      ),
    },
  });
}

export function registerProcessesHandlers(deps: HandlerDependencies): () => void {
  return createProcessesNamespace(deps).register();
}
