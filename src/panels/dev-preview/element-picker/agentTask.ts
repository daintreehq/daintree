import type { AgentState } from "@shared/types/agent";

/** An agent terminal the task can be delivered to. */
export interface AgentTarget {
  terminalId: string;
  title: string;
  agentState: AgentState | null;
  /** Which CLI is running there, for the destination's own mark. Unknown is possible. */
  agentId: string | null;
}

export const MAX_INSTRUCTION_CHARS = 4000;

/** Agents that are mid-turn must not receive a second prompt on top of it. */
export function isAgentBusy(state: AgentState | null): boolean {
  return state === "working" || state === "directing";
}
