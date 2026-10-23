/**
 * What a host saw when an agent launch asked to start (#14221): figures, never
 * a forecast. Any null is unknown, and an unknown never holds a launch.
 */
export interface AgentLaunchObservation {
  /** The kernel reports critical memory pressure (macOS only; false elsewhere). */
  kernelCritical: boolean;
  /** Live agent terminals across every project on this host; null when not every shard answered. */
  runningAgents: number | null;
  /** Launches this host admitted that have not shown up as live terminals yet. */
  startingAgents: number;
  /** Agents this host starts before launches wait, from its memory; null when memory is unknown. */
  agentLaunchLimit: number | null;
  /** The memory the limit was worked out from: the machine's, or a tighter cgroup limit. */
  memoryTotalBytes: number | null;
}

export type AgentLaunchHoldReason = "kernel-critical" | "agent-capacity";

export interface AgentLaunchAdmission {
  /** Null when the launch may start now. */
  holdReason: AgentLaunchHoldReason | null;
  observation: AgentLaunchObservation;
}
