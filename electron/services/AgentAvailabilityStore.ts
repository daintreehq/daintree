/**
 * AgentAvailabilityStore - Runtime availability tracking for agents.
 *
 * Subscribes to agent state changes and tracks:
 * - Availability status (idle/waiting vs working)
 * - Real-time state updates
 */

import { events } from "./events.js";
import type { AgentState, WaitingReason } from "../../shared/types/agent.js";

export interface AgentAvailabilityInfo {
  agentId: string;
  available: boolean;
  state: AgentState;
  lastStateChange: number;
}

/**
 * Check if an agent state indicates availability for new tasks.
 * An agent is available if it's idle or waiting for user input.
 */
function isAvailableState(state: AgentState): boolean {
  return state === "idle" || state === "waiting";
}

/**
 * Cap on remembered closed terminals. Evicting the oldest only ever degrades a
 * `"closed"` answer to `"unknown"` — from "we saw it end" to "we have no
 * record" — never to "live", so the bound cannot manufacture a false alive.
 * Sized to match the batched wait's own terminal cap.
 */
export const MAX_CLOSED_TERMINALS = 256;

export class AgentAvailabilityStore {
  private agentStates: Map<string, AgentState> = new Map();
  private waitingReasons: Map<string, WaitingReason> = new Map();
  private lastStateChange: Map<string, number> = new Map();
  // Exit metadata captured from the "completed"/"exited" state transition so MCP
  // read paths (waitUntilIdle, the agentState resource) can report pass/fail
  // without scraping output. `exitCode` is null when the process died from a
  // signal with no numeric code; `exitSignal` is the raw node-pty signal number.
  private exitCodes: Map<string, number | null> = new Map();
  private exitSignals: Map<string, number> = new Map();
  // Spawn timestamp captured from agent:spawned so supervisors can reason about
  // run duration in the same read as state.
  private spawnedAt: Map<string, number> = new Map();
  private terminalToAgent: Map<string, string> = new Map();
  private agentToTerminal: Map<string, string> = new Map();
  // Terminals whose agent we observed being killed. Insertion-ordered and
  // bounded (see MAX_CLOSED_TERMINALS) — this is a tombstone set, not a
  // registry, so it exists only to answer "was this id closed, or have we
  // simply never seen it".
  private closedTerminals: Set<string> = new Set();
  private trashedTerminals: Set<string> = new Set();
  private trashedAgentIds: Set<string> = new Set();
  private helpTerminalIds: Set<string> = new Set();
  private helpAgentIds: Set<string> = new Set();
  private unsubscribers: Array<() => void> = [];

  constructor() {
    this.unsubscribers.push(
      events.on("agent:state-changed", (payload) => {
        this.updateAvailability(payload);
      })
    );

    this.unsubscribers.push(
      events.on("agent:spawned", (payload) => {
        this.terminalToAgent.set(payload.terminalId, payload.agentId);
        this.agentToTerminal.set(payload.agentId, payload.terminalId);
        this.spawnedAt.set(payload.agentId, payload.timestamp);
        // A respawn under the same terminal id revives it, so drop any
        // tombstone from the previous session rather than reporting the live
        // terminal as closed forever.
        this.closedTerminals.delete(payload.terminalId);
        // A fresh spawn resets the tracked state to "working" so a stale state
        // from a prior session under the same agentId can't outlive a respawn.
        // Without this, a previous "waiting" persists and waitUntilIdle settles
        // immediately as already-idle, dropping its listener before the new
        // session's crash "exited" event arrives (issue #10816).
        this.agentStates.set(payload.agentId, "working");
        this.lastStateChange.set(payload.agentId, payload.timestamp);
        this.waitingReasons.delete(payload.agentId);
        // A fresh spawn clears any exit metadata from a prior session under the
        // same agentId so a stale exit code can't outlive a respawn.
        this.exitCodes.delete(payload.agentId);
        this.exitSignals.delete(payload.agentId);
        if (this.trashedTerminals.has(payload.terminalId)) {
          this.trashedAgentIds.add(payload.agentId);
        }
        if (this.helpTerminalIds.has(payload.terminalId)) {
          this.helpAgentIds.add(payload.agentId);
        }
      })
    );

    // The only signal that a specific terminal's agent is gone AND that
    // reaches the main process. `terminal:exited` is emitted on the pty-host's
    // own bus and is not in the `PtyHostEvent` union, so it never crosses the
    // bridge — subscribing to it here would be dead code (same reason
    // ProjectStatsService and FleetSnapshotService skip it). A kill maps
    // straight to `idle` in `nextAgentState`, so without this the mapping
    // outlives the panel and a closed terminal is indistinguishable from an
    // agent at rest (#12339).
    this.unsubscribers.push(
      events.on("agent:killed", (payload) => {
        if (!payload.terminalId) return;
        this.releaseTerminal(payload.terminalId);
      })
    );

    this.unsubscribers.push(
      events.on("terminal:trashed", (payload) => {
        this.trashedTerminals.add(payload.id);
        const agentId = this.terminalToAgent.get(payload.id);
        if (agentId) {
          this.trashedAgentIds.add(agentId);
        }
      })
    );

    this.unsubscribers.push(
      events.on("terminal:restored", (payload) => {
        this.trashedTerminals.delete(payload.id);
        const agentId = this.terminalToAgent.get(payload.id);
        if (agentId) {
          this.trashedAgentIds.delete(agentId);
        }
      })
    );
  }

  private updateAvailability(payload: {
    agentId?: string;
    state: AgentState;
    timestamp: number;
    waitingReason?: WaitingReason;
    exitCode?: number | null;
    exitSignal?: number;
  }): void {
    if (!payload.agentId) return;

    this.agentStates.set(payload.agentId, payload.state);
    this.lastStateChange.set(payload.agentId, payload.timestamp);
    if (payload.state === "waiting" && payload.waitingReason) {
      this.waitingReasons.set(payload.agentId, payload.waitingReason);
    } else {
      this.waitingReasons.delete(payload.agentId);
    }
    // Cache exit metadata when the transition carries it (completed/exited from
    // a PTY exit event). `exitCode` may legitimately be null (signal kill), so
    // gate on the field being present rather than truthy.
    if (payload.state === "completed" || payload.state === "exited") {
      if (payload.exitCode !== undefined) {
        this.exitCodes.set(payload.agentId, payload.exitCode);
      }
      if (payload.exitSignal !== undefined) {
        this.exitSignals.set(payload.agentId, payload.exitSignal);
      }
    }
  }

  /**
   * Check if an agent is available to receive a new task.
   */
  isAvailable(agentId: string): boolean {
    const state = this.agentStates.get(agentId);
    if (!state) return false;
    return isAvailableState(state);
  }

  /**
   * Get the current state of an agent.
   */
  getState(agentId: string): AgentState | undefined {
    return this.agentStates.get(agentId);
  }

  /**
   * Get the most recent waitingReason for an agent, if it is currently waiting.
   * Returns undefined if the agent is not in waiting state or has no classified reason.
   * Note: keyed by agentId; for terminals that share an agentId (e.g. two "claude"
   * panels) this reflects whichever waiting agent emitted last — same limitation as
   * agentToTerminal mapping.
   */
  getWaitingReason(agentId: string): WaitingReason | undefined {
    return this.waitingReasons.get(agentId);
  }

  /**
   * Resolve the agentId associated with a terminal, if any.
   * Returns undefined for terminals that have never spawned an agent (e.g. plain shells).
   */
  getAgentIdForTerminal(terminalId: string): string | undefined {
    return this.terminalToAgent.get(terminalId);
  }

  /**
   * Resolve the latest terminal associated with an agent id.
   *
   * Agent ids identify the agent type today (for example "claude"), so multiple
   * terminals can temporarily share one id. Terminal-scoped waiters use this as
   * a guard before trusting agent-level snapshot state.
   */
  getTerminalIdForAgent(agentId: string): string | undefined {
    return this.agentToTerminal.get(agentId);
  }

  /**
   * Timestamp (ms) of the most recent state transition for an agent, sourced from the
   * canonical event payload rather than wall-clock time.
   */
  getLastStateChange(agentId: string): number | undefined {
    return this.lastStateChange.get(agentId);
  }

  /**
   * Process exit code from the agent's last "completed"/"exited" transition.
   * Returns `null` when the process was signal-terminated without a numeric
   * code, or `undefined` when the agent has not exited (or never spawned).
   */
  getExitCode(agentId: string): number | null | undefined {
    return this.exitCodes.get(agentId);
  }

  /**
   * Raw OS signal number that terminated the agent process, if one was reported.
   * Returns `undefined` when the agent exited normally or has not exited.
   */
  getExitSignal(agentId: string): number | undefined {
    return this.exitSignals.get(agentId);
  }

  /**
   * Wall-clock spawn timestamp (ms) captured from agent:spawned, for duration
   * reasoning. Returns `undefined` for agents registered before a spawn event.
   */
  getSpawnedAt(agentId: string): number | undefined {
    return this.spawnedAt.get(agentId);
  }

  /**
   * Get all agents with their availability status.
   */
  getAgentsByAvailability(): AgentAvailabilityInfo[] {
    const agents: AgentAvailabilityInfo[] = [];

    for (const [agentId, state] of this.agentStates) {
      if (this.trashedAgentIds.has(agentId)) continue;
      if (this.helpAgentIds.has(agentId)) continue;
      agents.push({
        agentId,
        available: isAvailableState(state),
        state,
        lastStateChange: this.lastStateChange.get(agentId) ?? 0,
      });
    }

    return agents;
  }

  /**
   * Get only available agents.
   */
  getAvailableAgents(): AgentAvailabilityInfo[] {
    return this.getAgentsByAvailability().filter((a) => a.available);
  }

  /**
   * Register an agent's initial state.
   * Called when a new agent terminal is spawned.
   */
  registerAgent(agentId: string, initialState: AgentState = "idle"): void {
    if (!this.agentStates.has(agentId)) {
      this.agentStates.set(agentId, initialState);
      this.lastStateChange.set(agentId, Date.now());
    }
  }

  /**
   * Mark a terminal (and its associated agent) as a help terminal.
   * Help terminals are excluded from availability counts and quit warnings.
   */
  markAsHelp(terminalId: string): void {
    this.helpTerminalIds.add(terminalId);
    const agentId = this.terminalToAgent.get(terminalId);
    if (agentId) {
      this.helpAgentIds.add(agentId);
    }
  }

  /**
   * Check if a terminal is marked as a help terminal.
   */
  isHelpTerminal(terminalId: string): boolean {
    return this.helpTerminalIds.has(terminalId);
  }

  /**
   * Remove the help terminal mark from a terminal.
   */
  unmarkAsHelp(terminalId: string): void {
    this.helpTerminalIds.delete(terminalId);
    const agentId = this.terminalToAgent.get(terminalId);
    if (agentId) {
      this.helpAgentIds.delete(agentId);
    }
  }

  /**
   * Release one terminal's mapping and remember that it closed.
   *
   * Terminal-scoped on purpose, and deliberately NOT `unregisterAgent`: agent
   * ids name the agent *type* ("claude"), so several terminals share one, and
   * unregistering by agent id would erase `agentStates`/`exitCodes`/`spawnedAt`
   * that a different, still-live terminal of the same type is relying on. Only
   * the two per-terminal maps are touched, and the reverse entry only when it
   * still points back here.
   */
  releaseTerminal(terminalId: string): void {
    this.markTerminalClosed(terminalId);

    const agentId = this.terminalToAgent.get(terminalId);
    if (agentId === undefined) return;

    this.terminalToAgent.delete(terminalId);
    // `agentToTerminal` holds only the most recent terminal for an agent id, so
    // a newer terminal of the same type may already own this entry. Dropping it
    // unconditionally would un-map a live sibling.
    if (this.agentToTerminal.get(agentId) === terminalId) {
      this.agentToTerminal.delete(agentId);
    }
    this.trashedTerminals.delete(terminalId);
  }

  /**
   * Whether this terminal's agent was observed being killed. False for a
   * terminal we still track and for one we have no record of — the caller
   * separates those two by whether a mapping exists.
   */
  isTerminalClosed(terminalId: string): boolean {
    return this.closedTerminals.has(terminalId);
  }

  /** Record a closed terminal, evicting the oldest entry past the bound. */
  private markTerminalClosed(terminalId: string): void {
    // Re-insert so a repeat close refreshes recency rather than aging out early.
    this.closedTerminals.delete(terminalId);
    this.closedTerminals.add(terminalId);
    while (this.closedTerminals.size > MAX_CLOSED_TERMINALS) {
      const oldest = this.closedTerminals.values().next().value;
      if (oldest === undefined) break;
      this.closedTerminals.delete(oldest);
    }
  }

  /**
   * Unregister an agent when its terminal is removed.
   */
  unregisterAgent(agentId: string): void {
    this.agentStates.delete(agentId);
    this.waitingReasons.delete(agentId);
    this.lastStateChange.delete(agentId);
    this.exitCodes.delete(agentId);
    this.exitSignals.delete(agentId);
    this.spawnedAt.delete(agentId);
    const terminalId = this.agentToTerminal.get(agentId);
    if (terminalId) {
      this.terminalToAgent.delete(terminalId);
      this.trashedTerminals.delete(terminalId);
      this.helpTerminalIds.delete(terminalId);
      this.agentToTerminal.delete(agentId);
    }
    this.trashedAgentIds.delete(agentId);
    this.helpAgentIds.delete(agentId);
  }

  /**
   * Clear all tracked state.
   */
  clear(): void {
    this.agentStates.clear();
    this.waitingReasons.clear();
    this.lastStateChange.clear();
    this.exitCodes.clear();
    this.exitSignals.clear();
    this.spawnedAt.clear();
    this.terminalToAgent.clear();
    this.agentToTerminal.clear();
    this.closedTerminals.clear();
    this.trashedTerminals.clear();
    this.trashedAgentIds.clear();
    this.helpTerminalIds.clear();
    this.helpAgentIds.clear();
  }

  /**
   * Dispose of the store and clean up event subscriptions.
   */
  dispose(): void {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
    this.clear();
  }
}

let storeInstance: AgentAvailabilityStore | null = null;

/**
 * Get the singleton AgentAvailabilityStore instance.
 */
export function getAgentAvailabilityStore(): AgentAvailabilityStore {
  if (!storeInstance) {
    storeInstance = new AgentAvailabilityStore();
  }
  return storeInstance;
}

/**
 * Initialize a new AgentAvailabilityStore instance.
 * Disposes any existing instance.
 */
export function initializeAgentAvailabilityStore(): AgentAvailabilityStore {
  if (storeInstance) {
    storeInstance.dispose();
  }
  storeInstance = new AgentAvailabilityStore();
  return storeInstance;
}

/**
 * Dispose the AgentAvailabilityStore singleton.
 */
export function disposeAgentAvailabilityStore(): void {
  if (storeInstance) {
    storeInstance.dispose();
    storeInstance = null;
  }
}
