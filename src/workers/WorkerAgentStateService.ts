/**
 * Browser-compatible agent state service for Web Worker.
 * Replaces EventEmitter with return values for postMessage pattern.
 */

import type { AgentState, AgentStateChangeTrigger } from "../../shared/types/agent.js";
import type { WorkerTerminalState } from "../../shared/types/worker-messages.js";
import { type AgentEvent, nextAgentState } from "../../shared/utils/agentFsm.js";

export type { AgentEvent } from "../../shared/utils/agentFsm.js";

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

/**
 * Infer the trigger type from an agent event.
 * Mirrors `AgentStateService.inferTrigger` in the main process so worker- and
 * main-side state-change events carry consistent trigger metadata.
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
    case "kill":
      return "exit";
    case "start":
      return "activity";
    case "error":
      return "activity";
    case "completion":
      return "activity";
    case "respawn":
      return "activity";
    case "watchdog-timeout":
      return "timeout";
    default:
      return "output";
  }
}

/**
 * Infer confidence level based on trigger. The worker's `inferTrigger` never
 * returns "heuristic" or "ai-classification" (those are produced only by
 * main-process pattern/AI detection paths), so this only covers the triggers
 * the worker can actually emit.
 */
function inferConfidence(_event: AgentEvent, trigger: AgentStateChangeTrigger): number {
  if (trigger === "timeout") {
    return 0.6;
  }
  return 1.0;
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
