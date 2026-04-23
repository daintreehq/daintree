import { isBuiltInAgentId, type BuiltInAgentId } from "@shared/config/agentIds";
import type { TerminalInstance } from "@shared/types";

/**
 * Low-level liveness predicate: the terminal has a writable PTY and is not in
 * a lifecycle state where Fleet should address it. This is a building block,
 * not the Fleet membership rule.
 */
export function isTerminalFleetEligible(t: TerminalInstance | undefined): t is TerminalInstance {
  if (!t) return false;
  if (t.location === "trash" || t.location === "background") return false;
  if (t.hasPty === false) return false;
  // `runtimeStatus` is the renderer's authoritative liveness signal. `hasPty`
  // can lag after backend snapshots/reconnect for panels preserved after exit.
  if (t.runtimeStatus === "exited" || t.runtimeStatus === "error") return false;
  return true;
}

/**
 * Agent capability for Fleet actions that depend on a full agent session
 * (accept/reject/interrupt/restart). Prefers the sealed-at-spawn
 * `capabilityAgentId` (#5804); falls back to launch-time built-in `agentId`
 * for terminals reconnected from older backend payloads that predate the
 * writer.
 */
export function resolveFleetAgentCapabilityId(
  t: TerminalInstance | undefined
): BuiltInAgentId | undefined {
  if (!t) return undefined;
  if (t.capabilityAgentId) return t.capabilityAgentId;
  return isBuiltInAgentId(t.agentId) ? t.agentId : undefined;
}

export function isAgentFleetActionEligible(t: TerminalInstance | undefined): t is TerminalInstance {
  return isTerminalFleetEligible(t) && resolveFleetAgentCapabilityId(t) !== undefined;
}

export function isFleetWaitingAgentEligible(
  t: TerminalInstance | undefined
): t is TerminalInstance {
  return isAgentFleetActionEligible(t) && t.agentState === "waiting";
}

export function isFleetInterruptAgentEligible(
  t: TerminalInstance | undefined
): t is TerminalInstance {
  return (
    isAgentFleetActionEligible(t) && (t.agentState === "working" || t.agentState === "waiting")
  );
}

export function isFleetRestartAgentEligible(
  t: TerminalInstance | undefined
): t is TerminalInstance {
  return isAgentFleetActionEligible(t);
}
