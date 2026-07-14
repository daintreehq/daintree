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

  const seed = async () => {
    try {
      const terminals = await ptyClient.getAllTerminalsAsync();
      if (host.disposed) return;
      host.projectByTerminal.clear();
      host.agentStateByTerminal.clear();
      for (const t of terminals) {
        if (t.projectId) host.projectByTerminal.set(t.id, t.projectId);
        if (t.agentState) host.agentStateByTerminal.set(t.id, t.agentState);
      }
      // A background agent may have gone active (or been spawned) after the
      // debounced freeze fired but before it was mapped here, so its view was
      // frozen with hasActiveAgent() still false. Now that the maps are fresh,
      // wake any such view so its queued state event applies.
      host.unfreezeActiveAgentViews();
    } catch {
      // Host unavailable — leave maps as-is; hasActiveAgent stays conservative.
    }
  };

  const onStateChanged = (payload: { terminalId?: string; state: AgentState }) => {
    // No projectId on this event — the seed map owns the terminal→project
    // link. Skip terminals we haven't seeded yet (a spawn-result reseed will
    // pick them up). On terminal exit the state machine emits exited/completed
    // (neither in ACTIVE_AGENT_STATES), so a killed terminal self-heals to
    // unprotected here; a missed final event is corrected by the next
    // spawn-result/host-crash reseed.
    if (!payload.terminalId) return;
    host.agentStateByTerminal.set(payload.terminalId, payload.state);
    // Wake a view that was frozen before its agent became active: the freeze
    // blocks the renderer from ever applying this very event, so unfreeze the
    // owning project's cached view now. If the terminal isn't mapped to a
    // project yet (pre-seed race), the spawn-result reseed's
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

  const onSpawnResult = () => void seed();
  const onHostCrash = () => void seed();
  // Drop a terminal from the freeze-seed maps when it exits, so a dead
  // terminal can't leave a stale project/agent-state entry that keeps
  // hasActiveAgent() reporting a phantom active agent for its project.
  const onTerminalExit = (id: string) => {
    host.projectByTerminal.delete(id);
    host.agentStateByTerminal.delete(id);
  };
  ptyClient.on("spawn-result", onSpawnResult);
  ptyClient.on("host-crash", onHostCrash);
  ptyClient.on("exit", onTerminalExit);

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

/**
 * Whether `projectId` still has a live Daintree Assistant backend — a help
 * session PTY that HelpSessionService has bound to the project AND that the
 * terminal cache still knows about (#11157).
 *
 * Both halves are load-bearing. HelpSessionService holds its project→terminal
 * binding until the session is revoked, displaced, or unbound; nothing drops it
 * when the assistant's PTY exits on its own, so the binding alone would keep
 * protecting the view of a project whose assistant quit long ago. The terminal
 * cache is the liveness half: `initAgentStateCache` deletes a terminal from
 * `projectByTerminal` on its `exit` event, so a dead assistant stops protecting
 * its view and normal LRU resumes.
 *
 * Agent state is deliberately not consulted. The assistant can dispatch a
 * sub-agent or a background shell and go idle itself while that work runs on,
 * and killing it is exactly the bug this guards against — so a bound, live
 * assistant PTY protects its view whatever the parent's FSM state.
 *
 * Conservative before the first seed resolves: the cache is empty, so this
 * returns false and the view stays evictable, matching hasActiveAgent().
 */
export function hasLiveAssistantBackend(host: ProjectViewManager, projectId: string): boolean {
  const terminalId = host.assistantTerminalIdForProject?.(projectId);
  if (!terminalId) return false;
  return host.projectByTerminal.get(terminalId) === projectId;
}
