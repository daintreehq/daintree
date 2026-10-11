import { defineIpcNamespace, op } from "../define.js";
import { PROCESSES_METHOD_CHANNELS } from "./processes.preload.js";
import type { HandlerDependencies, IpcContext } from "../types.js";
import { peekDriveLeaseService } from "../../services/DriveLeaseService.js";
import { AppError } from "../../utils/errorTypes.js";
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
 * A closed terminal's leftovers still belong to the project the ledger
 * recorded them under, so while drive leases are in force (Host mode) only
 * that project's driver may end them. One recorded with no project has no
 * lease to consult.
 */
async function assertDrivesRecordedProjects(
  ctx: IpcContext,
  ptyClient: NonNullable<HandlerDependencies["ptyClient"]>,
  targets: readonly ClosedProcessKillTarget[]
): Promise<void> {
  const lease = peekDriveLeaseService();
  if (!lease || targets.length === 0) return;
  const owners = new Map<string, string | null>();
  const { inventories, shardsFailed } = await ptyClient.getProcessInventory();
  for (const inventory of inventories) {
    for (const recorded of inventory.closedTerminalProcesses ?? []) {
      owners.set(`${recorded.pid}@${recorded.startTime}`, recorded.origin?.projectId ?? null);
    }
  }
  for (const { pid, startTime } of targets) {
    const key = `${pid}@${startTime}`;
    // Fail closed: a target the census can't place right now (a shard that
    // didn't answer, the listing's cap, a survivor too new to list) might be
    // any project's, so it is refused rather than assumed free.
    if (!owners.has(key)) {
      throw new AppError({
        code: "DRIVEN_ELSEWHERE",
        message: `processes:kill-closed-terminal-processes can't place ${key}${shardsFailed > 0 ? " (a terminal host didn't answer)" : ""} while drive leases are in force`,
        userMessage:
          "Couldn't confirm which project these processes belong to. Refresh the list and try again.",
        context: { pid },
      });
    }
    const projectId = owners.get(key);
    if (projectId && !lease.isDriving(projectId, ctx.endpoint)) {
      throw new AppError({
        code: "DRIVEN_ELSEWHERE",
        message: `processes:kill-closed-terminal-processes ends processes of ${projectId}, which another window drives`,
        userMessage:
          "These processes belong to a project driven from another screen. Take it over first.",
        context: { projectId },
      });
    }
  }
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
        async (
          ctx: IpcContext,
          targets: ClosedProcessKillTarget[]
        ): Promise<ClosedProcessKillResult> => {
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
          await assertDrivesRecordedProjects(ctx, deps.ptyClient, valid);
          return deps.ptyClient.killClosedTerminalProcesses(valid);
        },
        { withContext: true }
      ),
    },
  });
}

export function registerProcessesHandlers(deps: HandlerDependencies): () => void {
  return createProcessesNamespace(deps).register();
}
