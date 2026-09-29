/**
 * Agent-state cache for ProjectViewManager's synchronous `hasActiveAgent()`
 * eviction/freeze guard. Extracted from ProjectViewManager (#11004).
 *
 * The main-process getPtyManager() singleton is never populated (#10054), so
 * the real terminal registry lives in the pty-host and is read async via
 * PtyClient. Eviction scoring is synchronous, so `host.projectByTerminal` /
 * `host.agentStateByTerminal` maintain instance-level maps seeded from the
 * host and kept fresh via the typed event bus. Instance-level (not
 * module-level) so each window's manager scopes to its own terminals
 * (lesson #8607).
 */

import { events } from "../services/events.js";
import { unfreezeWebContents } from "../utils/webContentsLifecycle.js";
import { ACTIVE_AGENT_STATES, type AgentState } from "../../shared/types/agent.js";
import type { PtyClient } from "../services/PtyClient.js";
import type { ProjectViewManager } from "./ProjectViewManager.js";

const RECONCILE_DEBOUNCE_MS = 250;
const RECONCILE_MAX_WAIT_MS = 1_000;

/**
 * Seed and maintain the agent-state cache used by the synchronous
 * `hasActiveAgent()` eviction guard. Fire-and-forget: until the first seed
 * resolves the maps are empty and `hasActiveAgent()` returns false (the
 * conservative pre-regression behavior — an in-flight view is never wrongly
 * treated as protected). Idempotent listener wiring: cleanup callbacks are
 * cleared first so re-invocation doesn't double-subscribe.
 */
export function initAgentStateCache(host: ProjectViewManager, ptyClient: PtyClient): Promise<void> {
  for (const cleanup of host.agentCacheCleanup) cleanup();
  host.agentCacheCleanup = [];

  // Replies still in flight when this wiring is torn down (dispose, or a
  // re-invocation) must not write into maps a newer wiring now owns.
  let retired = false;
  const stale = () => retired || host.disposed;

  // Every mutation stamps the terminal with a monotonic sequence number, so a
  // host reply that left before the mutation can't roll it back: a slower
  // snapshot must not resurrect an exited terminal or overwrite a newer
  // agent:state-changed. Stamps only matter while a reply is in flight, so
  // they are dropped whenever nothing is outstanding.
  let seq = 0;
  let inFlight = 0;
  const stateStamp = new Map<string, number>();
  const lifeStamp = new Map<string, number>();
  const begin = () => {
    inFlight++;
    return seq;
  };
  const end = () => {
    if (--inFlight > 0) return;
    stateStamp.clear();
    lifeStamp.clear();
  };
  const stamp = (map: Map<string, number>, id: string) => {
    if (inFlight > 0) map.set(id, ++seq);
  };
  const changedSince = (map: Map<string, number>, id: string, since: number) =>
    (map.get(id) ?? 0) > since;

  const fullSeed = async () => {
    const since = begin();
    try {
      const terminals = await ptyClient.getAllTerminalsAsync();
      if (stale()) return;
      const keptProjects = new Map<string, string>();
      const keptStates = new Map<string, AgentState>();
      for (const [id, stamped] of lifeStamp) {
        if (stamped <= since) continue;
        const projectId = host.projectByTerminal.get(id);
        if (projectId) keptProjects.set(id, projectId);
      }
      for (const id of new Set([...lifeStamp.keys(), ...stateStamp.keys()])) {
        if (!changedSince(lifeStamp, id, since) && !changedSince(stateStamp, id, since)) continue;
        const state = host.agentStateByTerminal.get(id);
        if (state) keptStates.set(id, state);
      }
      host.projectByTerminal.clear();
      host.agentStateByTerminal.clear();
      for (const t of terminals) {
        if (changedSince(lifeStamp, t.id, since)) continue;
        if (t.projectId) host.projectByTerminal.set(t.id, t.projectId);
        if (t.agentState && !changedSince(stateStamp, t.id, since)) {
          host.agentStateByTerminal.set(t.id, t.agentState);
        }
      }
      for (const [id, projectId] of keptProjects) host.projectByTerminal.set(id, projectId);
      for (const [id, state] of keptStates) host.agentStateByTerminal.set(id, state);
      // A background agent may have gone active (or been spawned) after the
      // debounced freeze fired but before it was mapped here, so its view was
      // frozen with hasActiveAgent() still false. Now that the maps are fresh,
      // wake any such view so its queued state event applies.
      host.unfreezeActiveAgentViews();
    } catch {
      // Host unavailable — leave maps as-is; hasActiveAgent stays conservative.
    } finally {
      end();
    }
  };

  // Coalesced: a request during an in-flight seed queues exactly one rerun, so
  // a burst of triggers costs two full-list round trips rather than one each.
  let seedRunning: Promise<void> | null = null;
  let seedAgain = false;
  const seed = (): Promise<void> => {
    if (seedRunning) {
      seedAgain = true;
      return seedRunning;
    }
    seedRunning = (async () => {
      do {
        seedAgain = false;
        await fullSeed();
      } while (seedAgain && !stale());
      seedRunning = null;
    })();
    return seedRunning;
  };

  // A successful spawn adds exactly one terminal, so map just that record
  // right away instead of re-listing every terminal on every shard — restoring
  // N terminals would otherwise cost N full-list round trips (~N² records).
  // The full list still runs once the burst settles (see scheduleReconcile).
  const seedOne = async (id: string) => {
    let localProjectId: string | null = null;
    try {
      localProjectId = ptyClient.getTerminalProjectId(id);
    } catch {
      // Fall through to the host lookup.
    }
    if (localProjectId) {
      host.projectByTerminal.set(id, localProjectId);
      stamp(lifeStamp, id);
    }
    const since = begin();
    try {
      const t = await ptyClient.getTerminalAsync(id);
      if (stale()) return;
      if (t && !changedSince(lifeStamp, id, since)) {
        const projectId = t.projectId || localProjectId;
        if (projectId) host.projectByTerminal.set(id, projectId);
        if (!changedSince(stateStamp, id, since)) {
          if (t.agentState) host.agentStateByTerminal.set(id, t.agentState);
          else host.agentStateByTerminal.delete(id);
        }
        stamp(lifeStamp, id);
      }
    } catch {
      // Lookup failed — the trailing reconcile repairs the entry.
    } finally {
      end();
    }
    if (!stale()) host.unfreezeActiveAgentViews();
  };

  // The full list also repairs what no single-terminal event reports: an exit
  // lost to a shard restart, ownership inferred after spawn, a late exit from a
  // killed predecessor that dropped its same-id successor. Debounced so a
  // restore burst costs one reconcile, and capped so a steady stream of spawns
  // can't postpone it indefinitely.
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  let reconcileDeadline = 0;
  const scheduleReconcile = () => {
    const now = performance.now();
    if (reconcileTimer) clearTimeout(reconcileTimer);
    else reconcileDeadline = now + RECONCILE_MAX_WAIT_MS;
    reconcileTimer = setTimeout(
      () => {
        reconcileTimer = null;
        if (!stale()) void seed();
      },
      Math.max(0, Math.min(RECONCILE_DEBOUNCE_MS, reconcileDeadline - now))
    );
  };

  const onStateChanged = (payload: { terminalId?: string; state: AgentState }) => {
    // No projectId on this event — the seed map owns the terminal→project
    // link, filled per terminal by its spawn-result. On terminal exit the state
    // machine emits exited/completed (neither in ACTIVE_AGENT_STATES), so a
    // killed terminal self-heals to unprotected here; a missed final event is
    // corrected by the next spawn-result reconcile or host-crash reseed.
    if (!payload.terminalId) return;
    host.agentStateByTerminal.set(payload.terminalId, payload.state);
    stamp(stateStamp, payload.terminalId);
    // Wake a view that was frozen before its agent became active: the freeze
    // blocks the renderer from ever applying this very event, so unfreeze the
    // owning project's cached view now. If the terminal isn't mapped to a
    // project yet (pre-seed race), the spawn-result lookup's
    // unfreezeActiveAgentViews() pass catches it.
    if (host.efficiencyFreezeEnabled && ACTIVE_AGENT_STATES.has(payload.state)) {
      const projectId = host.projectByTerminal.get(payload.terminalId);
      if (projectId && projectId !== host.activeProjectId) {
        const entry = host.views.get(projectId);
        if (entry && !entry.view.webContents.isDestroyed()) {
          void unfreezeWebContents(entry.view.webContents);
        }
      }
    }
  };
  const offStateChanged = events.on("agent:state-changed", onStateChanged);

  const onSpawnResult = (id?: string, result?: { success?: boolean }) => {
    if (typeof id === "string" && result?.success === true) {
      void seedOne(id);
      scheduleReconcile();
    } else {
      void seed();
    }
  };
  const onHostCrash = () => void seed();
  // Drop a terminal from the freeze-seed maps when it exits, so a dead
  // terminal can't leave a stale project/agent-state entry that keeps
  // hasActiveAgent() reporting a phantom active agent for its project.
  const onTerminalExit = (id: string) => {
    host.projectByTerminal.delete(id);
    host.agentStateByTerminal.delete(id);
    stamp(lifeStamp, id);
  };
  ptyClient.on("spawn-result", onSpawnResult);
  ptyClient.on("host-crash", onHostCrash);
  ptyClient.on("exit", onTerminalExit);

  host.agentCacheCleanup.push(() => {
    retired = true;
    if (reconcileTimer) clearTimeout(reconcileTimer);
    reconcileTimer = null;
  });
  host.agentCacheCleanup.push(offStateChanged);
  host.agentCacheCleanup.push(() => ptyClient.off("spawn-result", onSpawnResult));
  host.agentCacheCleanup.push(() => ptyClient.off("host-crash", onHostCrash));
  host.agentCacheCleanup.push(() => ptyClient.off("exit", onTerminalExit));

  return seed();
}

export function hasActiveAgent(host: ProjectViewManager, projectId: string): boolean {
  for (const [terminalId, termProjectId] of host.projectByTerminal) {
    if (termProjectId !== projectId) continue;
    const state = host.agentStateByTerminal.get(terminalId);
    if (state != null && ACTIVE_AGENT_STATES.has(state)) return true;
  }
  return false;
}
