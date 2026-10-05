/**
 * The agent a terminal is running now, for deciding whose subagents it may read.
 *
 * Live detection wins over the launch hint: a pane relaunched onto another agent
 * keeps its original `launchAgentId`, and an `||` would let a direct IPC call
 * read the previous agent's children. The launch hint still counts on its own,
 * because a restored pane has no detection until the detector rehydrates — but
 * only until an exit signal arrives. `launchAgentId` and `agentSessionId` are
 * durable and outlive the agent, so without this a pane dropped back to its
 * shell keeps answering for the session that ended there (#13200).
 */
export function subagentTerminalAgentId(info: {
  detectedAgentId?: string;
  launchAgentId?: string;
  agentState?: string;
  isExited?: boolean;
  hasPty?: boolean;
}): string | undefined {
  if (info.isExited === true || info.hasPty === false) return undefined;
  if (info.detectedAgentId) return info.detectedAgentId;
  if (info.agentState === "exited") return undefined;
  return info.launchAgentId;
}
