import { CHANNELS } from "../ipc/channels.js";
import { typedBroadcast } from "../ipc/utils.js";
import { events } from "./events.js";
import { projectStore } from "./ProjectStore.js";
import { computeProjectAgentCounts } from "./projectAgentCounts.js";
import type { PtyClient } from "./PtyClient.js";
import type { ProjectStatusMap } from "../../shared/types/ipc/project.js";
import { MutableDisposable, toDisposable, type IDisposable } from "../utils/lifecycle.js";
import { setAlignedInterval } from "../utils/setAlignedInterval.js";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEBOUNCE_MS = 200;

export class ProjectStatsService {
  private intervalSlot = new MutableDisposable<IDisposable>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private eventUnsubscribes: Array<() => void> = [];
  private started = false;
  private lastBroadcast: ProjectStatusMap = {};
  private pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  private generation = 0;

  constructor(private ptyClient: PtyClient | undefined | null) {}

  get isStarted(): boolean {
    return this.started;
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    this.armPollInterval();

    // Recompute on agent state transitions and on the lifecycle events that
    // actually cross the PTY-host → main bridge. `terminal:exited` is emitted
    // inside the PTY host but is NOT in the `PtyHostEvent` union, so it never
    // reaches the main process — subscribing here would be dead code.
    // Direct-kill flows are already covered by `agent:state-changed` because
    // `TerminalProcess.kill()` calls `updateAgentState({type:"kill"})` whenever
    // `getLiveAgentId(terminal)` is set (i.e. any counted terminal).
    const subscribe = (event: Parameters<typeof events.on>[0]) => {
      this.eventUnsubscribes.push(events.on(event, () => this.debouncedCompute()));
    };
    subscribe("agent:state-changed");
    subscribe("terminal:trashed");
    subscribe("terminal:restored");
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
    // Always bump generation so an in-flight computeAndBroadcast — including
    // one started by a pre-start refresh() — is invalidated before any
    // post-stop write or broadcast can fire.
    this.generation++;
    if (!this.started) return;
    this.started = false;

    this.intervalSlot.clear();

    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    for (const unsubscribe of this.eventUnsubscribes) {
      unsubscribe();
    }
    this.eventUnsubscribes = [];
  }

  private armPollInterval(): void {
    const clear = setAlignedInterval(() => {
      void this.computeAndBroadcast();
    }, this.pollIntervalMs);
    this.intervalSlot.value = toDisposable(clear);
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
        ea.waitingAgentCount !== eb.waitingAgentCount ||
        ea.blockedAgentCount !== eb.blockedAgentCount ||
        ea.oldestWaitingSince !== eb.oldestWaitingSince
      ) {
        return false;
      }
    }
    return true;
  }

  private async computeAndBroadcast(): Promise<void> {
    if (!this.ptyClient) return;

    const gen = ++this.generation;

    try {
      const allProjects = projectStore.getAllProjects();
      const projectIds = allProjects.map((p) => p.id);
      if (projectIds.length === 0) {
        if (this.generation !== gen) return;
        // Track the empty broadcast so a later non-empty result with the
        // same shape as the prior non-empty broadcast still fires
        // (shallowEqual would otherwise suppress it).
        this.lastBroadcast = {};
        typedBroadcast<"project:stats-updated">(CHANNELS.PROJECT_STATS_UPDATED, {});
        return;
      }

      const [allTerminals, statsResults] = await Promise.all([
        this.ptyClient.getAllTerminalsAsync(),
        Promise.allSettled(
          projectIds.map((id) => this.ptyClient!.getProjectStats(id).then((s) => [id, s] as const))
        ),
      ]);

      if (this.generation !== gen) return;

      const agentCounts = computeProjectAgentCounts(projectIds, allTerminals);

      const statusMap: ProjectStatusMap = {};
      for (const entry of statsResults) {
        if (entry.status === "fulfilled") {
          const [id, ptyStats] = entry.value;
          const counts = agentCounts.get(id);
          if (!counts) continue;
          statusMap[id] = {
            // Net out the assistant help PTY the host counted but the switcher
            // must not show; clamp in case stats momentarily lag (#10989).
            processCount: Math.max(0, ptyStats.terminalCount - counts.helpTerminals),
            activeAgentCount: counts.active,
            waitingAgentCount: counts.waiting,
            blockedAgentCount: counts.blocked,
            ...(counts.oldestWaitingSince !== null
              ? { oldestWaitingSince: counts.oldestWaitingSince }
              : {}),
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
