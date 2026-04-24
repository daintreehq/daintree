import type { BuiltInAgentId } from "@shared/config/agentIds";
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
 * Agent capability for Fleet actions — live-detection only.
 *
 * Fleet only acts on terminals that are *currently* hosting an agent. Launch
 * intent doesn't matter; a plain shell that spawned Claude is a valid fleet
 * member, and a cold-launched Claude panel whose Claude exited to shell is
 * not. See `docs/architecture/terminal-identity.md`.
 */
export function resolveFleetAgentCapabilityId(
  t: TerminalInstance | undefined
): BuiltInAgentId | undefined {
  return t?.detectedAgentId;
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
