import { CHANNELS } from "../../channels.js";
import { checkRateLimit, typedHandle } from "../../utils.js";
import type { HandlerDependencies } from "../../types.js";
import type { BulkProjectStats } from "../../../../shared/types/ipc/project.js";
import type { MemoryRollup, MemoryRollupProject } from "../../../../shared/types/pty-host.js";
import { ProjectStatsService } from "../../../services/ProjectStatsService.js";
import { registerDeferredTask } from "../../../window/deferredInitQueue.js";

let projectStatsServiceInstance: ProjectStatsService | null = null;

export function getProjectStatsService(): ProjectStatsService | null {
  return projectStatsServiceInstance;
}

export function registerProjectStatsHandlers(deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const projectStatsService = new ProjectStatsService(deps.ptyClient);
  projectStatsServiceInstance = projectStatsService;
  projectStatsService.start();
  // Defer the initial compute off the first-interactive critical path. The
  // 5s aligned poll and agent-state debounce armed in start() continue to
  // fire normally; this just keeps cold-start work off first paint.
  registerDeferredTask({
    name: "project-stats-initial-compute",
    run: () => {
      if (projectStatsService.isStarted) projectStatsService.refresh();
    },
  });
  handlers.push(() => {
    projectStatsService.stop();
    projectStatsServiceInstance = null;
  });

  const handleProjectGetStats = async (projectId: string) => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }

    const ptyStats = await deps.ptyClient!.getProjectStats(projectId);

    const MEMORY_PER_TERMINAL_MB = 50;

    const estimatedMemoryMB = ptyStats.terminalCount * MEMORY_PER_TERMINAL_MB;

    return {
      processCount: ptyStats.terminalCount,
      terminalCount: ptyStats.terminalCount,
      estimatedMemoryMB,
      terminalTypes: ptyStats.terminalTypes,
      processIds: ptyStats.processIds,
    };
  };
  handlers.push(typedHandle(CHANNELS.PROJECT_GET_STATS, handleProjectGetStats));

  const handleProjectGetBulkStats = async (projectIds: string[]): Promise<BulkProjectStats> => {
    checkRateLimit(CHANNELS.PROJECT_GET_BULK_STATS, 10, 10_000);
    if (!Array.isArray(projectIds)) {
      throw new Error("Invalid projectIds: must be an array");
    }

    const uniqueIds = [...new Set(projectIds.filter((id) => typeof id === "string" && id))];
    const MEMORY_PER_TERMINAL_MB = 50;

    // Fetch all terminals, per-project stats, and the measured terminal-tree
    // memory rollup in parallel (eliminates N+1 per-terminal IPC).
    const [allTerminals, statsResults, memoryRollup] = await Promise.all([
      deps.ptyClient!.getAllTerminalsAsync(),
      Promise.allSettled(
        uniqueIds.map((id) => deps.ptyClient!.getProjectStats(id).then((s) => [id, s] as const))
      ),
      uniqueIds.length > 0
        ? deps.ptyClient!.getMemoryRollup()
        : Promise.resolve<MemoryRollup>({
            byProject: [],
            totalMemoryKb: 0,
            totalProcessCount: 0,
            terminalCount: 0,
            available: false,
            sampledAt: 0,
          }),
    ]);

    // Index measured per-project terminal memory; only trust it when the OS
    // process table read succeeded, else fall back to the per-terminal estimate.
    const measuredByProject = new Map<string, MemoryRollupProject>();
    if (memoryRollup.available) {
      for (const entry of memoryRollup.byProject) {
        if (entry.projectId) measuredByProject.set(entry.projectId, entry);
      }
    }

    // Group agent counts by projectId from the bulk terminal list
    const agentCounts = new Map<string, { active: number; waiting: number }>();
    for (const id of uniqueIds) {
      agentCounts.set(id, { active: 0, waiting: 0 });
    }
    for (const terminal of allTerminals) {
      if (!terminal.projectId) continue;
      const counts = agentCounts.get(terminal.projectId);
      if (!counts) continue;
      if (terminal.isTrashed) continue;
      if (terminal.kind === "dev-preview") continue;
      if (terminal.hasPty === false) continue;
      // Runtime identity wins; launch intent is only a boot-window fallback
      // before detection has ever committed. Demoted ex-agents must not
      // inflate active/waiting counts just because they were launched as agents.
      const hasLiveOrBootAgent =
        Boolean(terminal.detectedAgentId) ||
        (Boolean(terminal.launchAgentId) && terminal.everDetectedAgent !== true);
      if (!hasLiveOrBootAgent) continue;

      if (terminal.agentState === "waiting") {
        counts.waiting += 1;
      } else if (terminal.agentState === "working") {
        counts.active += 1;
      }
    }

    const result: BulkProjectStats = {};
    for (const entry of statsResults) {
      if (entry.status === "fulfilled") {
        const [id, ptyStats] = entry.value;
        const counts = agentCounts.get(id) ?? { active: 0, waiting: 0 };
        const measured = measuredByProject.get(id);
        // Trust the measurement only once at least one process resolved — a
        // just-spawned shell may not be in the process table yet, and reporting
        // a measured "0MB" then would be worse than the estimate.
        const hasMeasured = measured !== undefined && measured.processCount > 0;
        const top = hasMeasured ? measured!.topProcesses[0] : undefined;
        result[id] = {
          processCount: ptyStats.terminalCount,
          terminalCount: ptyStats.terminalCount,
          estimatedMemoryMB: ptyStats.terminalCount * MEMORY_PER_TERMINAL_MB,
          terminalTypes: ptyStats.terminalTypes,
          processIds: ptyStats.processIds,
          activeAgentCount: counts.active,
          waitingAgentCount: counts.waiting,
          terminalMemoryMB: hasMeasured ? Math.round(measured!.memoryKb / 1024) : undefined,
          topProcess: top
            ? { name: top.comm, memoryMB: Math.round(top.memoryKb / 1024) }
            : undefined,
        };
      }
    }
    return result;
  };
  handlers.push(typedHandle(CHANNELS.PROJECT_GET_BULK_STATS, handleProjectGetBulkStats));

  return () => handlers.forEach((cleanup) => cleanup());
}
