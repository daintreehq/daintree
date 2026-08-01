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
 * keeps the runs. They read the same source on the same cadence but sample it
 * independently, so two surfaces can briefly disagree across one transition;
 * collapsing them into a single read with two projections is the fix, and is
 * deliberately not attempted here.
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
  private inFlight: Promise<void> | null = null;
  private rerunRequested = false;
  /**
   * When a complete read last succeeded, updated on every healthy poll whether
   * or not it produced a broadcast. Kept off the broadcast path deliberately —
   * a timestamp that advanced every five seconds would change the payload every
   * five seconds and defeat suppression entirely. It only reaches a renderer
   * when something else already justified a send.
   */
  private lastSuccessfulReadAt: number | null = null;

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
    this.scheduleCompute();
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
      this.scheduleCompute();
    }, this.pollIntervalMs);
    this.intervalSlot.value = toDisposable(clear);
  }

  private debouncedCompute(): void {
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.scheduleCompute();
    }, DEBOUNCE_MS);
  }

  /**
   * One read at a time; overlapping triggers collapse into a single re-run.
   *
   * The aligned interval, the event debounce and an explicit `refresh()` can all
   * fire while a read is outstanding, and each read fans out to every PTY shard.
   * Letting them overlap multiplied the most expensive RPC in the service and
   * made the outcome order-dependent: a slow COMPLETE read that started first
   * would be discarded by a fast DEGRADED one that started second, throwing away
   * the only healthy answer. Coalescing keeps at most one read outstanding and
   * guarantees exactly one more afterwards, so the last trigger is never lost.
   */
  private scheduleCompute(): void {
    if (this.inFlight !== null) {
      this.rerunRequested = true;
      return;
    }
    const gen = this.generation;
    this.inFlight = this.computeOnce(gen).finally(() => {
      this.inFlight = null;
      if (!this.rerunRequested) return;
      this.rerunRequested = false;
      // A `stop()` while the read was outstanding bumps the generation. Chasing
      // the coalesced trigger anyway would restart polling on a stopped service.
      if (this.generation === gen) this.scheduleCompute();
    });
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
        x.lastObservedTitle !== y.lastObservedTitle ||
        x.titleMode !== y.titleMode ||
        x.cwd !== y.cwd ||
        x.launchAgentId !== y.launchAgentId ||
        x.everDetectedAgent !== y.everDetectedAgent ||
        x.agentPresetColor !== y.agentPresetColor
      ) {
        return false;
      }
    }
    return true;
  }

  private async computeOnce(gen: number): Promise<void> {
    // No client is not "no agents" — it is the same inability to see the fleet
    // that a failed shard produces, and leaving it unpublished strands a
    // boot-time renderer on the loading path forever.
    if (!this.ptyClient) {
      this.publishDegraded();
      return;
    }

    try {
      const { terminals: allTerminals, degraded } =
        await this.ptyClient.getAllTerminalsWithCompletenessAsync();
      if (this.generation !== gen) return;

      // A shard that failed to answer contributed an empty list, not a true
      // zero. Publishing that as the run list would tell every view the fleet is
      // clear because the host stopped talking — the one claim a supervision
      // surface must never make. Retain the last known-good runs and mark them
      // stale so the renderer can say so; the next healthy poll supersedes it.
      if (degraded) {
        this.publishDegraded();
        return;
      }

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
          // Both titles ride across unmerged. `getTerminalDisplayTitle` composes
          // them in the renderer, and that decision needs each one separately.
          ...(terminal.title !== undefined ? { title: terminal.title } : {}),
          ...(terminal.lastObservedTitle !== undefined
            ? { lastObservedTitle: terminal.lastObservedTitle }
            : {}),
          ...(terminal.titleMode !== undefined ? { titleMode: terminal.titleMode } : {}),
          cwd: terminal.cwd,
          // Chrome ingredients, so a row can render the same brand icon the
          // panel header and dock do rather than a generic glyph.
          ...(terminal.launchAgentId !== undefined
            ? { launchAgentId: terminal.launchAgentId }
            : {}),
          ...(terminal.everDetectedAgent !== undefined
            ? { everDetectedAgent: terminal.everDetectedAgent }
            : {}),
          ...(terminal.agentPresetColor !== undefined
            ? { agentPresetColor: terminal.agentPresetColor }
            : {}),
        });
      }

      // Stable order on the wire so `runsEqual` compares like with like and a
      // reordering from the host can't masquerade as a fleet change.
      runs.sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));

      if (this.generation !== gen) return;

      const now = Date.now();
      this.lastSuccessfulReadAt = now;

      const previous = this.lastBroadcast;
      // Recovering from degraded is itself news even when the runs are
      // identical: the renderer is currently captioning them as stale.
      if (previous !== null && !previous.degraded && this.runsEqual(runs, previous.runs)) return;

      const unchanged = previous !== null && this.runsEqual(runs, previous.runs);
      this.publish({
        runs,
        changedAt: unchanged ? previous.changedAt : now,
        degraded: false,
        lastSuccessfulAt: now,
      });
    } catch (error) {
      console.error("[FleetSnapshotService] Failed to compute fleet snapshot:", error);
      // An unexpected rejection is one more way the fleet became unreadable.
      // Logging alone left the renderer unable to distinguish it from a read
      // that simply hadn't finished. Generation-guarded so a rejection settling
      // after `stop()` cannot broadcast from a stopped service.
      if (this.generation === gen) this.publishDegraded();
    }
  }

  /**
   * Report that the fleet can no longer be read completely, retaining whatever
   * was last known good.
   *
   * Sent once per degradation rather than every poll — the state is "stale since
   * `lastSuccessfulAt`", which does not change while it persists. With no prior
   * snapshot the runs are empty AND `lastSuccessfulAt` is null, which is the
   * renderer's cue to say it cannot tell rather than to render an empty fleet.
   */
  private publishDegraded(): void {
    const previous = this.lastBroadcast;
    if (previous?.degraded === true) return;
    this.publish({
      runs: previous?.runs ?? [],
      changedAt: previous?.changedAt ?? Date.now(),
      degraded: true,
      lastSuccessfulAt: this.lastSuccessfulReadAt,
    });
  }

  private publish(snapshot: FleetSnapshot): void {
    this.lastBroadcast = snapshot;
    typedBroadcast<"fleet:snapshot-updated">(CHANNELS.FLEET_SNAPSHOT_UPDATED, snapshot);
  }
}
