import path from "node:path";
import type {
  HostProcessInventory,
  ProcessInventoryPluginProcess,
  ProcessInventorySnapshot,
  ProcessTreeSample,
} from "../../shared/types/processes.js";
import type { PluginProcessInfo } from "../../shared/types/ipc/pluginProcess.js";
import type { WorkerResourceSnapshot } from "../../shared/types/workerGovernance.js";

export interface ProcessInventoryDeps {
  getHostInventory: (extraPids: readonly number[]) => Promise<{
    inventories: HostProcessInventory[];
    shardsTotal: number;
    shardsFailed: number;
  }>;
  /** Project and scratch identities, for naming the owner of each terminal. */
  getWorkspaceNames: () => Array<{ id: string; name: string }>;
  /** Null when the plugin system is not loaded — then no plugin runs anything. */
  getPluginProcesses: () => Promise<{
    children: PluginProcessInfo[];
    workers: WorkerResourceSnapshot[];
  } | null>;
  getAppMetrics: () => Electron.ProcessMetric[];
}

function workerSample(metric: Electron.ProcessMetric | undefined): ProcessTreeSample | null {
  if (!metric) return null;
  return {
    cpuPercent: metric.cpu.percentCPUUsage,
    // Electron reports KB; workingSetSize is the one field on every platform.
    memoryKb: metric.memory.workingSetSize,
    processCount: 1,
    members: [],
  };
}

/**
 * One cross-project list of what Daintree is running, for the processes view.
 *
 * Intentionally global: it lists every project's terminals regardless of which
 * view asks. Plugin children are projected field by field — their args and env
 * can carry tokens, so only the executable's basename leaves Main.
 */
export async function collectProcessInventory(
  deps: ProcessInventoryDeps
): Promise<ProcessInventorySnapshot> {
  const pluginProcesses = await deps.getPluginProcesses().catch(() => null);
  const children = (pluginProcesses?.children ?? []).filter(
    (child) => child.status === "running" && typeof child.pid === "number" && child.pid > 0
  );
  const workers = (pluginProcesses?.workers ?? []).filter(
    (worker) => typeof worker.pid === "number" && worker.pid > 0
  );

  const host = await deps.getHostInventory(children.map((child) => child.pid as number));

  const names = new Map<string, string>();
  try {
    for (const { id, name } of deps.getWorkspaceNames()) names.set(id, name);
  } catch {
    // A failed lookup leaves rows unnamed; the ids still group them.
  }

  const pidSamples = new Map<number, ProcessTreeSample>();
  for (const inventory of host.inventories) {
    for (const [pid, sample] of Object.entries(inventory.pidSamples)) {
      pidSamples.set(Number(pid), sample);
    }
  }

  let metricsByPid = new Map<number, Electron.ProcessMetric>();
  if (workers.length > 0) {
    try {
      metricsByPid = new Map(deps.getAppMetrics().map((metric) => [metric.pid, metric]));
    } catch {
      // Workers stay listed without a sample.
    }
  }

  const plugins: ProcessInventoryPluginProcess[] = [
    ...children.map((child): ProcessInventoryPluginProcess => ({
      source: "plugin-process",
      id: child.id,
      pluginId: child.pluginId,
      label: path.basename(child.command) || null,
      pid: child.pid as number,
      spawnedAt: child.spawnedAt,
      sample: pidSamples.get(child.pid as number) ?? null,
    })),
    ...workers.map((worker): ProcessInventoryPluginProcess => ({
      source: "plugin-worker",
      id: worker.id,
      pluginId: worker.id,
      label: null,
      pid: worker.pid as number,
      spawnedAt: null,
      sample: workerSample(metricsByPid.get(worker.pid as number)),
    })),
  ];

  const answered = host.inventories.filter((inventory) => inventory.sampledAt > 0);
  return {
    terminals: host.inventories.flatMap((inventory) =>
      inventory.terminals.map((terminal) => ({
        ...terminal,
        projectName: terminal.projectId ? (names.get(terminal.projectId) ?? null) : null,
      }))
    ),
    plugins,
    complete: host.shardsFailed === 0,
    samplesAvailable: host.inventories.every((inventory) => inventory.available),
    sampledAt:
      answered.length > 0 ? Math.min(...answered.map((inventory) => inventory.sampledAt)) : 0,
  };
}
