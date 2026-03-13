import type { AgentState } from "@shared/types/domain";

const BLOCKING_AGENT_STATES: Set<AgentState> = new Set(["working", "waiting"]);

interface TerminalLike {
  agentId?: string;
  agentState?: AgentState;
}

export function isBlockingAgentState(terminal: TerminalLike): boolean {
  return (
    !!terminal.agentId && !!terminal.agentState && BLOCKING_AGENT_STATES.has(terminal.agentState)
  );
}

export function confirmAgentTrash(terminals: TerminalLike[]): boolean {
  const blocking = terminals.filter(isBlockingAgentState);
  if (blocking.length === 0) return true;

  const message =
    blocking.length === 1
      ? "This agent is actively working. Closing it will stop the agent mid-task and may leave files in a partially modified state. Continue?"
      : `${blocking.length} agents are actively working or waiting. Closing them will stop the agents mid-task and may leave files in a partially modified state. Continue?`;

  return window.confirm(message);
}
