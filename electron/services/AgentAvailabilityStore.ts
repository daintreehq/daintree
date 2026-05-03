/**
 * AgentAvailabilityStore - Runtime availability tracking for agents.
 *
 * Subscribes to agent state changes and tracks:
 * - Availability status (idle/waiting vs working)
 * - Concurrent task count per agent
 * - Real-time state updates
 */

import { events } from "./events.js";
import type { AgentState } from "../../shared/types/agent.js";

export interface AgentAvailabilityInfo {
  agentId: string;
  available: boolean;
  state: AgentState;
  concurrentTasks: number;
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
  private concurrentTasks: Map<string, number> = new Map();
  private lastStateChange: Map<string, number> = new Map();
  private taskToAgent: Map<string, string> = new Map();
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

    this.unsubscribers.push(
      events.on("task:assigned", (payload) => {
        this.incrementConcurrentTasks(payload.agentId);
        this.taskToAgent.set(payload.taskId, payload.agentId);
      })
    );

    this.unsubscribers.push(
      events.on("task:completed", (payload) => {
        const agentId = payload.agentId || this.taskToAgent.get(payload.taskId);
        if (agentId) {
          this.decrementConcurrentTasks(agentId);
          this.taskToAgent.delete(payload.taskId);
        }
      })
    );

    this.unsubscribers.push(
      events.on("task:failed", (payload) => {
        const agentId = payload.agentId || this.taskToAgent.get(payload.taskId);
        if (agentId) {
          this.decrementConcurrentTasks(agentId);
          this.taskToAgent.delete(payload.taskId);
        }
      })
    );

    this.unsubscribers.push(
      events.on("task:state-changed", (payload) => {
        if (payload.state === "cancelled") {
          const agentId = this.taskToAgent.get(payload.taskId);
          if (agentId) {
            this.decrementConcurrentTasks(agentId);
            this.taskToAgent.delete(payload.taskId);
          }
        }
      })
    );
  }

  private updateAvailability(payload: {
    agentId?: string;
    state: AgentState;
    timestamp: number;
  }): void {
    if (!payload.agentId) return;

    this.agentStates.set(payload.agentId, payload.state);
    this.lastStateChange.set(payload.agentId, payload.timestamp);
  }

  private incrementConcurrentTasks(agentId: string): void {
    const current = this.concurrentTasks.get(agentId) ?? 0;
    this.concurrentTasks.set(agentId, current + 1);
  }

  private decrementConcurrentTasks(agentId: string): void {
    const current = this.concurrentTasks.get(agentId) ?? 0;
    this.concurrentTasks.set(agentId, Math.max(0, current - 1));
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
   * Get the number of concurrent tasks assigned to an agent.
   */
  getConcurrentTaskCount(agentId: string): number {
    return this.concurrentTasks.get(agentId) ?? 0;
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
        concurrentTasks: this.getConcurrentTaskCount(agentId),
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
      this.concurrentTasks.set(agentId, 0);
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
    this.concurrentTasks.delete(agentId);
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
    this.concurrentTasks.clear();
    this.lastStateChange.clear();
    this.taskToAgent.clear();
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
