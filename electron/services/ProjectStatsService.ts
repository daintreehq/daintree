import { CHANNELS } from "../ipc/channels.js";
import { typedBroadcast } from "../ipc/utils.js";
import { events } from "./events.js";
import { projectStore } from "./ProjectStore.js";
import type { PtyClient } from "./PtyClient.js";
import type { ProjectStatusMap } from "../../shared/types/ipc/project.js";
import { MutableDisposable, toDisposable, type IDisposable } from "../utils/lifecycle.js";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEBOUNCE_MS = 200;

export class ProjectStatsService {
  private intervalSlot = new MutableDisposable<IDisposable>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeAgentState: (() => void) | null = null;
  private started = false;
  private lastBroadcast: ProjectStatusMap = {};
  private pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;

  constructor(private ptyClient: PtyClient | undefined | null) {}

  start(): void {
    if (this.started) return;
    this.started = true;

    void this.computeAndBroadcast();
    this.armPollInterval();

    this.unsubscribeAgentState = events.on("agent:state-changed", () => {
      this.debouncedCompute();
    });
  }

  updatePollInterval(ms: number): void {
    if (this.pollIntervalMs === ms) return;
    this.pollIntervalMs = ms;
    if (this.started) {
      this.armPollInterval();
    }
  }

  refresh(): void {
    void this.computeAndBroadcast();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;

    this.intervalSlot.clear();

    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.unsubscribeAgentState) {
      this.unsubscribeAgentState();
      this.unsubscribeAgentState = null;
    }
  }

  private armPollInterval(): void {
    const id = setInterval(() => {
      void this.computeAndBroadcast();
    }, this.pollIntervalMs);
    this.intervalSlot.value = toDisposable(() => clearInterval(id));
  }

  private debouncedCompute(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.computeAndBroadcast();
    }, DEBOUNCE_MS);
  }

  private shallowEqual(a: ProjectStatusMap, b: ProjectStatusMap): boolean {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const key of keysA) {
      const ea = a[key];
      const eb = b[key];
      if (
        !eb ||
        ea.processCount !== eb.processCount ||
        ea.activeAgentCount !== eb.activeAgentCount ||
        ea.waitingAgentCount !== eb.waitingAgentCount
      ) {
        return false;
      }
    }
    return true;
  }

  private async computeAndBroadcast(): Promise<void> {
    if (!this.ptyClient) return;

    try {
      const allProjects = projectStore.getAllProjects();
      const projectIds = allProjects.map((p) => p.id);
      if (projectIds.length === 0) {
        typedBroadcast<"project:stats-updated">(CHANNELS.PROJECT_STATS_UPDATED, {});
        return;
      }

      const [allTerminals, statsResults] = await Promise.all([
        this.ptyClient.getAllTerminalsAsync(),
        Promise.allSettled(
          projectIds.map((id) => this.ptyClient!.getProjectStats(id).then((s) => [id, s] as const))
        ),
      ]);

      const agentCounts = new Map<string, { active: number; waiting: number }>();
      for (const id of projectIds) {
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

      const statusMap: ProjectStatusMap = {};
      for (const entry of statsResults) {
        if (entry.status === "fulfilled") {
          const [id, ptyStats] = entry.value;
          const counts = agentCounts.get(id) ?? { active: 0, waiting: 0 };
          statusMap[id] = {
            processCount: ptyStats.terminalCount,
            activeAgentCount: counts.active,
            waitingAgentCount: counts.waiting,
          };
        }
      }

      if (!this.shallowEqual(statusMap, this.lastBroadcast)) {
        this.lastBroadcast = statusMap;
        typedBroadcast<"project:stats-updated">(CHANNELS.PROJECT_STATS_UPDATED, statusMap);
      }
    } catch (error) {
      console.error("[ProjectStatsService] Failed to compute stats:", error);
    }
  }
}
