import { CHANNELS } from "../ipc/channels.js";
import { typedBroadcast } from "../ipc/utils.js";
import { events } from "./events.js";
import { classifyRun } from "./projectAgentCounts.js";
import { getAgentAvailabilityStore } from "./AgentAvailabilityStore.js";
import type { PtyClient } from "./PtyClient.js";
import type { FleetRunRow, FleetSnapshot } from "../../shared/types/ipc/fleet.js";
import { MutableDisposable, toDisposable, type IDisposable } from "../utils/lifecycle.js";
import { setAlignedInterval } from "../utils/setAlignedInterval.js";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEBOUNCE_MS = 200;

/**
 * The fleet's live run list, pushed to every view.
 *
 * A deliberate structural sibling of {@link ProjectStatsService}: same aligned
 * 5s poll, same 200ms debounce on the same three events, same unchanged-payload
 * suppression, same cold-start replay. The two differ only in projection —
 * that one reduces `getAllTerminalsAsync()` to per-project counts, this one
 * keeps the runs. They read the same source on the same cadence, so a surface
 * built on either sees the same fleet at the same moment.
 *
 * Main is the only process that can answer this question. Each project renders
 * in its own `WebContentsView` with its own V8 context and is LRU-evicted under
 * memory pressure, so no renderer can read another project's stores — but
 * `PtyClient` is a global singleton whose terminal records survive eviction
 * entirely. A parked project's agents keep running and keep appearing here.
 */
export class FleetSnapshotService {
  private intervalSlot = new MutableDisposable<IDisposable>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private eventUnsubscribes: Array<() => void> = [];
  private started = false;
  private lastBroadcast: FleetSnapshot | null = null;
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

    // The same three events `ProjectStatsService` subscribes to, for the same
    // reason: `terminal:exited` is emitted inside the PTY host and is not in
    // the `PtyHostEvent` union, so it never crosses into main and subscribing
    // would be dead code. Direct kills already arrive as `agent:state-changed`.
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
    if (this.started) this.armPollInterval();
  }

  refresh(): void {
    void this.computeAndBroadcast();
  }

  getLastBroadcast(): FleetSnapshot | null {
    return this.lastBroadcast;
  }

  /**
   * Replay the retained snapshot to a single freshly-loaded view (cold start,
   * LRU restore, crash reload, DevTools refresh), mirroring
   * `ProjectStatsService.pushSnapshotTo`.
   *
   * Without this a view that attaches while the fleet is static would never
   * receive a first payload at all: `computeAndBroadcast` suppresses unchanged
   * results, and waiting, blocked and completed-awaiting-review are precisely
   * the states that stop transitioning. The fleet being quiet is exactly when
   * a new view most needs to be told what is in it.
   *
   * A null snapshot is skipped — nothing computed yet is not the same claim as
   * an empty fleet, and only the latter is safe to render.
   */
  pushSnapshotTo(webContents: Electron.WebContents): void {
    if (webContents.isDestroyed()) return;
    if (this.lastBroadcast === null) return;
    try {
      webContents.send(CHANNELS.FLEET_SNAPSHOT_UPDATED, this.lastBroadcast);
    } catch {
      // Silently ignore send failures during window initialization/disposal.
    }
  }

  stop(): void {
    // Always bump the generation so an in-flight compute — including one a
    // pre-start refresh() kicked off — is invalidated before it can broadcast.
    this.generation++;
    if (!this.started) return;
    this.started = false;

    this.intervalSlot.clear();

    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    for (const unsubscribe of this.eventUnsubscribes) unsubscribe();
    this.eventUnsubscribes = [];
  }

  private armPollInterval(): void {
    const clear = setAlignedInterval(() => {
      void this.computeAndBroadcast();
    }, this.pollIntervalMs);
    this.intervalSlot.value = toDisposable(clear);
  }

  private debouncedCompute(): void {
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.computeAndBroadcast();
    }, DEBOUNCE_MS);
  }

  /**
   * Payload equality, ignoring `changedAt`.
   *
   * The timestamp is stamped per broadcast, so comparing it would defeat
   * suppression entirely and push an identical run list to every view every
   * five seconds. Excluding it is what makes `changedAt` mean "when the fleet
   * last changed" rather than "when we last looked".
   */
  private runsEqual(a: readonly FleetRunRow[], b: readonly FleetRunRow[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      const y = b[i];
      if (
        x.runId !== y.runId ||
        x.workspaceId !== y.workspaceId ||
        x.worktreeId !== y.worktreeId ||
        x.agentId !== y.agentId ||
        x.agentState !== y.agentState ||
        x.waitingReason !== y.waitingReason ||
        x.since !== y.since ||
        x.spawnedAt !== y.spawnedAt ||
        x.title !== y.title ||
        x.cwd !== y.cwd
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
      const { terminals: allTerminals, degraded } =
        await this.ptyClient.getAllTerminalsWithCompletenessAsync();
      if (this.generation !== gen) return;

      // A shard that failed to answer contributed an empty list, not a true
      // zero. Publishing that would tell every view the fleet is clear because
      // the host stopped talking — the one reading a supervision surface must
      // never produce. Hold the last known-good snapshot instead and let its
      // age speak; the next healthy poll supersedes it.
      if (degraded) return;

      const availability = getAgentAvailabilityStore();
      const runs: FleetRunRow[] = [];

      for (const terminal of allTerminals) {
        // Unowned terminals have no workspace to attribute a demand to, so they
        // can be listed by no surface — the same guard the count path applies.
        if (!terminal.projectId) continue;
        if (classifyRun(terminal, (id) => availability.isHelpTerminal(id)) !== null) continue;

        runs.push({
          runId: terminal.id,
          workspaceId: terminal.projectId,
          ...(terminal.worktreeId !== undefined ? { worktreeId: terminal.worktreeId } : {}),
          ...(terminal.detectedAgentId !== undefined ? { agentId: terminal.detectedAgentId } : {}),
          ...(terminal.agentState !== undefined ? { agentState: terminal.agentState } : {}),
          ...(terminal.waitingReason !== undefined
            ? { waitingReason: terminal.waitingReason }
            : {}),
          ...(typeof terminal.lastStateChange === "number" && terminal.lastStateChange > 0
            ? { since: terminal.lastStateChange }
            : {}),
          spawnedAt: terminal.spawnedAt,
          // The last OSC title the agent set is what the agent calls its own
          // work; `title` may still be the launch label. Prefer the former.
          ...(terminal.lastObservedTitle !== undefined || terminal.title !== undefined
            ? { title: terminal.lastObservedTitle ?? terminal.title }
            : {}),
          cwd: terminal.cwd,
        });
      }

      // Stable order on the wire so `runsEqual` compares like with like and a
      // reordering from the host can't masquerade as a fleet change.
      runs.sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));

      if (this.generation !== gen) return;

      if (this.lastBroadcast !== null && this.runsEqual(runs, this.lastBroadcast.runs)) return;

      const snapshot: FleetSnapshot = { runs, changedAt: Date.now() };
      this.lastBroadcast = snapshot;
      typedBroadcast<"fleet:snapshot-updated">(CHANNELS.FLEET_SNAPSHOT_UPDATED, snapshot);
    } catch (error) {
      console.error("[FleetSnapshotService] Failed to compute fleet snapshot:", error);
    }
  }
}
