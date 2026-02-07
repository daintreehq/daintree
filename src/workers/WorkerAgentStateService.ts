/**
 * Browser-compatible agent state service for Web Worker.
 * Replaces EventEmitter with return values for postMessage pattern.
 */

import type { AgentState, AgentStateChangeTrigger } from "../../shared/types/domain.js";
import type { WorkerTerminalState } from "../../shared/types/worker-messages.js";

/** Event types for agent state transitions */
export type AgentEvent =
  | { type: "start" }
  | { type: "output"; data: string }
  | { type: "busy" }
  | { type: "prompt" }
  | { type: "input" }
  | { type: "exit"; code: number }
  | { type: "error"; error: string };

/** Result of a state change calculation */
export interface StateChangeResult {
  agentId: string;
  state: AgentState;
  previousState: AgentState;
  timestamp: number;
  trigger: AgentStateChangeTrigger;
  confidence: number;
  terminalId: string;
  worktreeId?: string;
  traceId?: string;
}

/** Calculate the next agent state based on current state and event */
function nextAgentState(current: AgentState, event: AgentEvent): AgentState {
  if (event.type === "error") {
    return "failed";
  }

  switch (event.type) {
    case "start":
      if (current === "idle") {
        return "working";
      }
      break;

    case "busy":
      if (current === "waiting" || current === "idle") {
        return "working";
      }
      break;

    case "output":
      // Output events no longer trigger state changes directly
      break;

    case "prompt":
      if (current === "working") {
        return "waiting";
      }
      break;

    case "input":
      if (current === "waiting" || current === "idle") {
        return "working";
      }
      break;

    case "exit":
      if (current === "working" || current === "waiting") {
        return event.code === 0 ? "completed" : "failed";
      }
      break;
  }

  return current;
}

/**
 * Infer the trigger type from an agent event.
 */
function inferTrigger(event: AgentEvent): AgentStateChangeTrigger {
  switch (event.type) {
    case "input":
      return "input";
    case "output":
      return "output";
    case "busy":
      return "activity";
    case "prompt":
      return "activity";
    case "exit":
      return "exit";
    case "start":
      return "activity";
    case "error":
      return "activity";
    default:
      return "output";
  }
}

/**
 * Infer confidence level based on event type and trigger.
 */
function inferConfidence(event: AgentEvent, trigger: AgentStateChangeTrigger): number {
  if (trigger === "input" || trigger === "exit") {
    return 1.0;
  }

  if (trigger === "output") {
    return 1.0;
  }

  if (trigger === "activity") {
    return 1.0;
  }

  if (trigger === "heuristic") {
    if (event.type === "busy") {
      return 0.9;
    }
    if (event.type === "prompt") {
      return 0.75;
    }
    if (event.type === "start") {
      return 0.7;
    }
    if (event.type === "error") {
      return 0.65;
    }
  }

  if (trigger === "ai-classification") {
    return 0.85;
  }

  if (trigger === "timeout") {
    return 0.6;
  }

  return 0.5;
}

/**
 * Calculate state change for a terminal based on an event.
 * Returns StateChangeResult if state changed, null otherwise.
 */
export function calculateStateChange(
  terminalState: WorkerTerminalState,
  event: AgentEvent
): StateChangeResult | null {
  if (!terminalState.agentId) {
    return null;
  }

  const previousState = terminalState.agentState || "idle";
  const newState = nextAgentState(previousState, event);

  if (newState === previousState) {
    return null;
  }

  const trigger = inferTrigger(event);
  const confidence = inferConfidence(event, trigger);

  return {
    agentId: terminalState.agentId,
    state: newState,
    previousState,
    timestamp: Date.now(),
    trigger,
    confidence,
    terminalId: terminalState.terminalId,
    worktreeId: terminalState.worktreeId,
    traceId: terminalState.traceId,
  };
}

const MAX_SEEN_ARTIFACTS = 1000;

/**
 * Prune oldest artifact IDs if set exceeds max size.
 * Uses a simple FIFO approach by converting to array, slicing, and recreating set.
 */
export function pruneSeenArtifacts(seenIds: Set<string>): void {
  if (seenIds.size > MAX_SEEN_ARTIFACTS) {
    const idsArray = Array.from(seenIds);
    const keepIds = idsArray.slice(-MAX_SEEN_ARTIFACTS);
    seenIds.clear();
    keepIds.forEach((id) => seenIds.add(id));
  }
}

/**
 * Create initial terminal state for tracking.
 */
export function createTerminalState(
  terminalId: string,
  agentId?: string,
  worktreeId?: string,
  traceId?: string,
  initialState: AgentState = "idle"
): WorkerTerminalState {
  return {
    terminalId,
    agentId,
    worktreeId,
    traceId,
    agentState: initialState,
    analysisBuffer: "",
    seenArtifactIds: new Set(),
  };
}
