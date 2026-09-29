import { CHANNELS } from "../ipc/channels.js";
import { typedBroadcast } from "../ipc/utils.js";
import { events } from "./events.js";
import { projectStore } from "./ProjectStore.js";
import { scratchStore } from "./ScratchStore.js";
import { computeProjectAgentCounts } from "./projectAgentCounts.js";
import { helpSessionService } from "./HelpSessionService.js";
import {
  getSharedTerminalSnapshot,
  invalidateSharedTerminalSnapshot,
} from "./sharedTerminalSnapshot.js";
import type { PtyClient } from "./PtyClient.js";
import type { RunAttentionService } from "./RunAttentionService.js";
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

  /**
   * `runAttention` is optional so the harness and any caller that only wants
   * raw tallies can omit it — without it, snooze simply never suppresses
   * anything, which is the correct reading of "no attention service".
   */
  constructor(
    private ptyClient: PtyClient | undefined | null,
    private runAttention?: RunAttentionService | null
  ) {}

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
      this.eventUnsubscribes.push(
        events.on(event, () => {
          invalidateSharedTerminalSnapshot(this.ptyClient);
          this.debouncedCompute();
        })
      );
    };
    subscribe("agent:state-changed");
    subscribe("terminal:trashed");
    subscribe("terminal:restored");
    // Snoozing changes what a project's counts SAY without changing what any
    // agent is doing, so no other event covers it. Only the taking and lifting
    // of a snooze needs this — expiry rides the poll, since a lapsed snooze
    // simply stops being returned by `getActiveSnoozes()`.
    subscribe("terminal:snooze-changed");
  }

  updatePollInterval(ms: number): void {
    if (this.pollIntervalMs === ms) return;
    this.pollIntervalMs = ms;
    if (this.started) {
      this.armPollInterval();
    }
  }

  /** An explicit recompute, so it reads the host afresh rather than a sibling's snapshot. */
  refresh(): void {
    invalidateSharedTerminalSnapshot(this.ptyClient);
    void this.computeAndBroadcast();
  }

  /**
   * The most recent pushed status map. The completion acknowledger reads this
   * to decide whether the observed project has anything left to acknowledge —
   * cheaper than re-tallying terminals on its sampling tick, and any lag is
   * self-healing (the stamp waits one tick behind the broadcast).
   */
  getLastBroadcast(): ProjectStatusMap {
    return this.lastBroadcast;
  }

  /**
   * Replay the retained status map to a single freshly-loaded view (cold start,
   * LRU restore, crash reload, DevTools refresh), mirroring
   * `pushRunHistorySnapshotTo`. `computeAndBroadcast` suppresses unchanged
   * payloads, so a view that attaches while the fleet is static — waiting,
   * blocked and completed-unreviewed agents are exactly the states that stop
   * transitioning — would otherwise never receive a first broadcast at all.
   *
   * An empty map is skipped: the initial compute is deferred off the
   * first-interactive path, so `lastBroadcast` is `{}` for a window after boot,
   * and "nothing computed yet" is indistinguishable on the wire from "no
   * projects". Sending it carries no information and can only clobber a store
   * the renderer's own bulk seed already filled.
   *
   * Best-effort, not durable transport: the renderer attaches its listener from
   * a React effect, so this send can land first and be dropped. The palette's
   * open-time bulk pull remains the guaranteed hydration path.
   */
  pushSnapshotTo(webContents: Electron.WebContents): void {
    if (webContents.isDestroyed()) return;
    if (Object.keys(this.lastBroadcast).length === 0) return;
    try {
      webContents.send(CHANNELS.PROJECT_STATS_UPDATED, this.lastBroadcast);
    } catch {
      // Silently ignore send failures during window initialization/disposal.
    }
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
        ea.oldestWaitingSince !== eb.oldestWaitingSince ||
        ea.completedAgentCount !== eb.completedAgentCount ||
        ea.unacknowledgedCompletedAgentCount !== eb.unacknowledgedCompletedAgentCount ||
        ea.oldestUnacknowledgedCompletionAt !== eb.oldestUnacknowledgedCompletionAt ||
        ea.latestUnacknowledgedCompletionAt !== eb.latestUnacknowledgedCompletionAt ||
        ea.latestCompletionAt !== eb.latestCompletionAt ||
        ea.latestWorkingSince !== eb.latestWorkingSince ||
        ea.snoozedAgentCount !== eb.snoozedAgentCount ||
        ea.nextSnoozeWakeAt !== eb.nextSnoozeWakeAt ||
        // Assistant presence is compared here for the same reason every count
        // above is: this gate decides whether a broadcast happens at all, so a
        // field it doesn't know about can change without anyone hearing. An
        // assistant that started working would sit invisible in an already-open
        // switcher until some unrelated worker tally moved (#11806).
        ea.assistantState !== eb.assistantState ||
        ea.assistantWaitingReason !== eb.assistantWaitingReason ||
        ea.assistantStateSince !== eb.assistantStateSince
      ) {
        return false;
      }
    }
    return true;
  }

  /**
   * Live (not exited, not trashed) terminals per workspace — what the host's
   * `get-project-stats` counts — tallied from the snapshot already in hand
   * instead of one RPC per workspace.
   *
   * The one case still asked of the host per workspace is a live terminal with
   * no `projectId`. The host attributes it by cwd and stamps the id onto it as a
   * side effect of the very query being skipped; only the host can resolve it,
   * and once it has, the snapshot carries the id. Trashed terminals count here
   * because the host's matcher runs on them before the trash filter does.
   *
   * A degraded snapshot is NOT a reason to fall back: the shard that just timed
   * out on the fan-out would time out again per workspace, after it, and two
   * back-to-back timeouts outlast the poll that would supersede this compute —
   * starving every workspace's stats for the length of the outage. A missing
   * shard reads as zero, which is what its failed per-workspace reads resolved
   * to before.
   */
  private async getTerminalCounts(
    projectIds: readonly string[],
    terminals: ReadonlyArray<{ projectId?: string; isExited?: boolean; isTrashed?: boolean }>
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (terminals.some((t) => !t.projectId && !t.isExited)) {
      const results = await Promise.allSettled(
        projectIds.map((id) => this.ptyClient!.getProjectStats(id).then((s) => [id, s] as const))
      );
      for (const result of results) {
        if (result.status === "fulfilled") {
          counts.set(result.value[0], result.value[1].terminalCount);
        }
      }
      return counts;
    }
    for (const id of projectIds) counts.set(id, 0);
    for (const terminal of terminals) {
      if (terminal.isExited || terminal.isTrashed || !terminal.projectId) continue;
      const count = counts.get(terminal.projectId);
      if (count !== undefined) counts.set(terminal.projectId, count + 1);
    }
    return counts;
  }

  private async computeAndBroadcast(): Promise<void> {
    if (!this.ptyClient) return;

    const gen = ++this.generation;

    try {
      // Scratches ride the same map: a scratch terminal is already stamped with
      // the scratch id as its `projectId` (#11079), the counting helper treats
      // ids as opaque, and the two id formats are disjoint (64-hex vs UUID), so
      // a scratch row can never shadow a project's entry (#11518).
      const allProjects = projectStore.getAllProjects();
      const allScratches = scratchStore.getAllScratches();
      const projectIds = [...allProjects.map((p) => p.id), ...allScratches.map((s) => s.id)];
      if (projectIds.length === 0) {
        if (this.generation !== gen) return;
        // Track the empty broadcast so a later non-empty result with the
        // same shape as the prior non-empty broadcast still fires
        // (shallowEqual would otherwise suppress it).
        this.lastBroadcast = {};
        typedBroadcast<"project:stats-updated">(CHANNELS.PROJECT_STATS_UPDATED, {});
        return;
      }

      const { terminals: allTerminals } = await getSharedTerminalSnapshot(this.ptyClient);
      if (this.generation !== gen) return;
      const terminalCounts = await this.getTerminalCounts(projectIds, allTerminals);
      if (this.generation !== gen) return;

      // Acknowledgement watermarks ride the same rows already fetched.
      const seenMap = new Map<string, number>();
      for (const workspace of [...allProjects, ...allScratches]) {
        if (
          typeof workspace.lastCompletionSeenAt === "number" &&
          workspace.lastCompletionSeenAt > 0
        ) {
          seenMap.set(workspace.id, workspace.lastCompletionSeenAt);
        }
      }
      // Snooze expiry is resolved here, once, against a single clock reading —
      // the counting helper stays pure and never asks what time it is. This is
      // also the whole of the feature's "timer": a lapsed snooze stops being
      // returned, and the next poll (5s) recomputes without it.
      const activeSnoozes = this.runAttention?.getActiveSnoozes();
      const agentCounts = computeProjectAgentCounts(
        projectIds,
        allTerminals,
        seenMap,
        activeSnoozes,
        // Same visibility gate the pull path applies. Omitting it on either
        // side is the drift the shared helper exists to prevent: the push
        // suppresses unchanged payloads, so a row hydrated with a hidden
        // assistant would keep reporting it until agent state next moved.
        (id) => helpSessionService.isPanelVisible(id),
        // Lets concurrent assistants be ranked by who needs the user,
        // rather than by whichever started last (#12108).
        (terminalId) => helpSessionService.getSlotForTerminal(terminalId)
      );

      const statusMap: ProjectStatusMap = {};
      for (const [id, terminalCount] of terminalCounts) {
        const counts = agentCounts.get(id);
        if (!counts) continue;
        statusMap[id] = {
          // Net out the assistant help PTY the host counted but the switcher
          // must not show; clamp in case stats momentarily lag (#10989).
          processCount: Math.max(0, terminalCount - counts.helpTerminals),
          activeAgentCount: counts.active,
          waitingAgentCount: counts.waiting,
          blockedAgentCount: counts.blocked,
          ...(counts.oldestWaitingSince !== null
            ? { oldestWaitingSince: counts.oldestWaitingSince }
            : {}),
          completedAgentCount: counts.completed,
          unacknowledgedCompletedAgentCount: counts.unacknowledgedCompleted,
          ...(counts.oldestUnacknowledgedCompletionAt !== null
            ? { oldestUnacknowledgedCompletionAt: counts.oldestUnacknowledgedCompletionAt }
            : {}),
          ...(counts.latestUnacknowledgedCompletionAt !== null
            ? { latestUnacknowledgedCompletionAt: counts.latestUnacknowledgedCompletionAt }
            : {}),
          ...(counts.latestCompletionAt !== null
            ? { latestCompletionAt: counts.latestCompletionAt }
            : {}),
          ...(counts.latestWorkingSince !== null
            ? { latestWorkingSince: counts.latestWorkingSince }
            : {}),
          snoozedAgentCount: counts.snoozed,
          ...(counts.nextSnoozeWakeAt !== null
            ? { nextSnoozeWakeAt: counts.nextSnoozeWakeAt }
            : {}),
          // Presence, carried beside the tallies and never inside them
          // (#11806). The bulk stats handler projects these identically —
          // the two paths answering differently is exactly #10989.
          ...(counts.assistantState !== null ? { assistantState: counts.assistantState } : {}),
          ...(counts.assistantWaitingReason !== null
            ? { assistantWaitingReason: counts.assistantWaitingReason }
            : {}),
          ...(counts.assistantStateSince !== null
            ? { assistantStateSince: counts.assistantStateSince }
            : {}),
        };
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
