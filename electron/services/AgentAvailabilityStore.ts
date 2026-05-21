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

export class AgentAvailabilityStore {
  private agentStates: Map<string, AgentState> = new Map();
  private waitingReasons: Map<string, WaitingReason> = new Map();
  private lastStateChange: Map<string, number> = new Map();
  private terminalToAgent: Map<string, string> = new Map();
  private agentToTerminal: Map<string, string> = new Map();
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
        if (this.trashedTerminals.has(payload.terminalId)) {
          this.trashedAgentIds.add(payload.agentId);
        }
        if (this.helpTerminalIds.has(payload.terminalId)) {
          this.helpAgentIds.add(payload.agentId);
        }
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
  }): void {
    if (!payload.agentId) return;

    this.agentStates.set(payload.agentId, payload.state);
    this.lastStateChange.set(payload.agentId, payload.timestamp);
    if (payload.state === "waiting" && payload.waitingReason) {
      this.waitingReasons.set(payload.agentId, payload.waitingReason);
    } else {
      this.waitingReasons.delete(payload.agentId);
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
   * Timestamp (ms) of the most recent state transition for an agent, sourced from the
   * canonical event payload rather than wall-clock time.
   */
  getLastStateChange(agentId: string): number | undefined {
    return this.lastStateChange.get(agentId);
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
   * Unregister an agent when its terminal is removed.
   */
  unregisterAgent(agentId: string): void {
    this.agentStates.delete(agentId);
    this.waitingReasons.delete(agentId);
    this.lastStateChange.delete(agentId);
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
    this.terminalToAgent.clear();
    this.agentToTerminal.clear();
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
