import type { BuiltInAgentId } from "@shared/config/agentIds";
import type { TerminalInstance } from "@shared/types";
import { getBuiltInRuntimeAgentId } from "@/utils/terminalType";

/**
 * Fleet membership/broadcast predicate: the terminal has a writable PTY and is
 * in a location where Fleet should address it. Dock terminals are excluded —
 * the collapsed dock surface has no room to render the armed/follower visual
 * state that warns a user their keystrokes are being broadcast.
 */
export function isTerminalFleetEligible(t: TerminalInstance | undefined): t is TerminalInstance {
  if (!t) return false;
  if (t.location === "trash" || t.location === "background" || t.location === "dock") return false;
  if (t.hasPty === false) return false;
  // `runtimeStatus` is the renderer's authoritative liveness signal. `hasPty`
  // can lag after backend snapshots/reconnect for panels preserved after exit.
  if (t.runtimeStatus === "exited" || t.runtimeStatus === "error") return false;
  return true;
}

/**
 * Cluster-error predicate: the terminal is in a valid location and not
 * snapshot-stale, but post-exit `runtimeStatus` is *expected* — these are the
 * terminals the error cluster is meant to surface. Used by the agent-cluster
 * hook in place of `isTerminalFleetEligible` for the "exited with errors"
 * bucket only; `prompt` and `completion` buckets keep the full eligibility
 * gate because their downstream actions assume a live PTY.
 */
export function isTerminalErrorClusterEligible(
  t: TerminalInstance | undefined
): t is TerminalInstance {
  if (!t) return false;
  if (t.location === "trash" || t.location === "background" || t.location === "dock") return false;
  if (t.hasPty === false) return false;
  return true;
}

/**
 * Agent capability for agent-specific Fleet actions.
 *
 * Broadcast can target any live terminal. Accept/reject/interrupt/restart
 * still require an agent identity because those actions depend on agent state.
 */
export function resolveFleetAgentCapabilityId(
  t: TerminalInstance | undefined
): BuiltInAgentId | undefined {
  return getBuiltInRuntimeAgentId(t);
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
