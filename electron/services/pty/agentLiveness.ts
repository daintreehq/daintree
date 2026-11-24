import type { TerminalPublicState } from "./types.js";

/**
 * True when an agent is observed in this PTY. Detection wins, and durable
 * launch affinity keeps a cold-launched or restored agent counted until an
 * explicit exit signal arrives. Such a terminal's frontend xterm is the sole
 * responder to its terminal queries, so its output must reach that xterm.
 */
export function isTerminalAgentLive(
  t: Pick<TerminalPublicState, "detectedAgentId" | "agentState" | "isExited" | "launchAgentId">
): boolean {
  if (t.detectedAgentId !== undefined) return true;
  if (t.agentState === "exited" || t.isExited) return false;
  return t.launchAgentId !== undefined;
}
