/**
 * AgentAvailabilityStore - Runtime availability tracking for agents.
 *
 * Subscribes to agent state changes and tracks, per terminal:
 * - Availability status (idle/waiting vs working)
 * - Real-time state updates
 */

import { events } from "./events.js";
import type { AgentState, WaitingReason } from "../../shared/types/agent.js";

export interface AgentAvailabilityInfo {
  terminalId: string;
  agentId: string;
  available: boolean;
  state: AgentState;
  lastStateChange: number;
}

/**
 * Everything observed about the agent in one terminal. Replaced whole on every
 * write, so a reader holding one never sees a later transition's fields mixed
 * into an earlier one's.
 */
export interface TerminalAgentSnapshot {
  terminalId: string;
  /** The agent *type* ("claude"), shared by every terminal running it. */
  agentId: string;
  state: AgentState;
  /** Timestamp (ms) of the most recent transition, from the event payload. */
  lastStateChange: number;
  /** Present only while `state` is `waiting` and the reason was classified. */
  waitingReason?: WaitingReason;
  /**
   * Carried by the `completed`/`exited` transition that is the current state.
   * `null` when the process died from a signal with no numeric code.
   */
  exitCode?: number | null;
  /** Raw node-pty signal number carried by the current `completed`/`exited` transition. */
  exitSignal?: number;
  /**
   * From `agent:spawned`. Absent for an agent the user started by hand in a
   * plain shell, which is detected at runtime and never announces a spawn.
   */
  spawnedAt?: number;
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
  // Keyed by terminal id, never agent id: an agent id names the agent type, so
  // several terminals share one, and a slot keyed by it lets one terminal's
  // transition answer for its sibling (#12494). Insertion order is update
  // order — every write re-inserts — which is what lets the type-addressed
  // resource pick the most recent observation without a separate clock.
  private terminals: Map<string, TerminalAgentSnapshot> = new Map();
  // Terminals whose agent we observed being killed. Insertion-ordered and
  // bounded (see MAX_CLOSED_TERMINALS) — this is a tombstone set, not a
  // registry, so it exists only to answer "was this id closed, or have we
  // simply never seen it".
  private closedTerminals: Set<string> = new Set();
  private trashedTerminals: Set<string> = new Set();
  private helpTerminalIds: Set<string> = new Set();
  private unsubscribers: Array<() => void> = [];

  constructor() {
    this.unsubscribers.push(
      events.on("agent:state-changed", (payload) => {
        this.updateAvailability(payload);
      })
    );

    this.unsubscribers.push(
      events.on("agent:spawned", (payload) => {
        // A respawn under the same terminal id revives it (`write` drops the
        // tombstone) and starts it over at "working", so nothing from a prior
        // session in it can outlive the respawn. Without this, a previous
        // "waiting" persists and waitUntilIdle settles immediately as
        // already-idle, dropping its listener before the new session's crash
        // "exited" event arrives (issue #10816). Only this terminal is reset —
        // a sibling of the same type keeps its own state.
        this.write({
          terminalId: payload.terminalId,
          agentId: payload.agentId,
          state: "working",
          lastStateChange: payload.timestamp,
          spawnedAt: payload.timestamp,
        });
      })
    );

    // The only signal that a specific terminal's agent is gone AND that
    // reaches the main process. `terminal:exited` is emitted on the pty-host's
    // own bus and is not in the `PtyHostEvent` union, so it never crosses the
    // bridge — subscribing to it here would be dead code (same reason
    // ProjectStatsService and FleetSnapshotService skip it). A kill maps
    // straight to `idle` in `nextAgentState`, so without this the record
    // outlives the panel and a closed terminal is indistinguishable from an
    // agent at rest (#12339).
    this.unsubscribers.push(
      events.on("agent:killed", (payload) => {
        if (!payload.terminalId) return;
        this.releaseTerminal(payload.terminalId);
      })
    );

    // An agent started by hand in a plain shell has no spawn, and once it quits
    // back to the prompt the shell has no live agent, so closing the pane later
    // emits no `agent:killed` either — nothing would ever release its record.
    // Dropped here instead, which leaves the terminal as untracked as it was
    // before the agent ran. A launched terminal keeps its record: its kill
    // still arrives, and until then its final state is what a wait reports.
    this.unsubscribers.push(
      events.on("agent:exited", (payload) => {
        if (payload.exitKind !== "subcommand") return;
        const snapshot = this.terminals.get(payload.terminalId);
        if (snapshot !== undefined && snapshot.spawnedAt === undefined) {
          this.terminals.delete(payload.terminalId);
        }
      })
    );

    this.unsubscribers.push(
      events.on("terminal:trashed", (payload) => {
        this.trashedTerminals.add(payload.id);
      })
    );

    this.unsubscribers.push(
      events.on("terminal:restored", (payload) => {
        this.trashedTerminals.delete(payload.id);
      })
    );
  }

  private updateAvailability(payload: {
    agentId?: string;
    terminalId?: string;
    state: AgentState;
    timestamp: number;
    waitingReason?: WaitingReason;
    exitCode?: number | null;
    exitSignal?: number;
  }): void {
    // Without a terminal id there is no slot to attribute the transition to,
    // and resolving one through the agent type is exactly the conflation this
    // store exists to avoid.
    if (!payload.agentId || !payload.terminalId) return;

    const previous = this.terminals.get(payload.terminalId);
    const next: TerminalAgentSnapshot = {
      terminalId: payload.terminalId,
      agentId: payload.agentId,
      state: payload.state,
      lastStateChange: payload.timestamp,
    };
    if (payload.state === "waiting" && payload.waitingReason) {
      next.waitingReason = payload.waitingReason;
    }
    // Exit metadata belongs to the transition that carries it (completed/exited
    // from a PTY exit event), never inherited: a pane can run a second agent by
    // hand after the first exits, with no spawn in between, and a later
    // pattern-detected `completed` must not report the earlier run's code.
    // `exitCode` may legitimately be null (signal kill), so gate on the field
    // being present rather than truthy.
    if (payload.state === "completed" || payload.state === "exited") {
      if (payload.exitCode !== undefined) next.exitCode = payload.exitCode;
      if (payload.exitSignal !== undefined) next.exitSignal = payload.exitSignal;
    }
    if (previous?.spawnedAt !== undefined && previous.agentId === payload.agentId) {
      next.spawnedAt = previous.spawnedAt;
    }
    this.write(next);
  }

  private write(snapshot: TerminalAgentSnapshot): void {
    // A kill emits nothing for its terminal after `agent:killed`, so a live
    // observation means the id is in use again — e.g. a restarted pane whose
    // agent was started by hand and so never announced a spawn.
    this.closedTerminals.delete(snapshot.terminalId);
    this.terminals.delete(snapshot.terminalId);
    this.terminals.set(snapshot.terminalId, snapshot);
  }

  /**
   * Everything observed about one terminal's agent, or `undefined` for a
   * terminal that never ran one (e.g. a plain shell) or has since closed.
   */
  getTerminalSnapshot(terminalId: string): Readonly<TerminalAgentSnapshot> | undefined {
    return this.terminals.get(terminalId);
  }

  /**
   * Resolve the agentId associated with a terminal, if any.
   * Returns undefined for terminals that have never spawned an agent (e.g. plain shells).
   */
  getAgentIdForTerminal(terminalId: string): string | undefined {
    return this.terminals.get(terminalId)?.agentId;
  }

  /**
   * The most recently updated terminal running this agent type.
   *
   * Only for a surface that is addressed by agent type and cannot name a
   * terminal — the `daintree://agent/{id}/state` resource. It returns one
   * terminal's whole snapshot, never fields merged across siblings, and the
   * snapshot names its terminal so a reader can tell which one it describes.
   */
  getLatestSnapshotForAgent(agentId: string): Readonly<TerminalAgentSnapshot> | undefined {
    let latest: TerminalAgentSnapshot | undefined;
    for (const snapshot of this.terminals.values()) {
      if (snapshot.agentId === agentId) latest = snapshot;
    }
    return latest;
  }

  /**
   * One row per terminal running an agent, excluding trashed and help
   * terminals. Two terminals running the same agent type are two rows.
   */
  getAgentsByAvailability(): AgentAvailabilityInfo[] {
    const agents: AgentAvailabilityInfo[] = [];

    for (const snapshot of this.terminals.values()) {
      if (this.trashedTerminals.has(snapshot.terminalId)) continue;
      if (this.helpTerminalIds.has(snapshot.terminalId)) continue;
      agents.push({
        terminalId: snapshot.terminalId,
        agentId: snapshot.agentId,
        available: isAvailableState(snapshot.state),
        state: snapshot.state,
        lastStateChange: snapshot.lastStateChange,
      });
    }

    return agents;
  }

  /**
   * Mark a terminal as a help terminal.
   * Help terminals are excluded from availability counts and quit warnings.
   */
  markAsHelp(terminalId: string): void {
    this.helpTerminalIds.add(terminalId);
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
  }

  /**
   * Release one terminal's record and remember that it closed. A sibling
   * running the same agent type is untouched.
   */
  releaseTerminal(terminalId: string): void {
    this.markTerminalClosed(terminalId);
    this.terminals.delete(terminalId);
    this.trashedTerminals.delete(terminalId);
  }

  /**
   * Whether this terminal's agent was observed being killed. False for a
   * terminal we still track and for one we have no record of — the caller
   * separates those two by whether a record exists.
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
   * Clear all tracked state.
   */
  clear(): void {
    this.terminals.clear();
    this.closedTerminals.clear();
    this.trashedTerminals.clear();
    this.helpTerminalIds.clear();
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
