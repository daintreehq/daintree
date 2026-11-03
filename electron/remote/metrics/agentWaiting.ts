import type { DaintreeEventMap } from "../../services/events.js";
import type { AgentWaitingPayload } from "./linkMethods.js";

/** What this machine's pty client says of a terminal, read with no screen. */
export interface WaitingTerminalFacts {
  getTerminalProjectId(id: string): string | null;
  getTerminalLaunchAttribution(id: string): { worktreeId?: string } | null;
  getLiveGeneration(id: string): number | null;
}

/**
 * An agent's transition into waiting, or a change of its reason while it
 * already waited, as observations only (#16188); null for any other
 * transition. Both generations are kept: the PTY launch the agent directory
 * names, and the agent run inside it that `terminal.getStatus` answers.
 */
export function agentWaitingOf(
  payload: DaintreeEventMap["agent:state-changed"],
  facts: WaitingTerminalFacts | null | undefined
): AgentWaitingPayload | null {
  if (payload.state !== "waiting") return null;
  const terminalId = payload.terminalId;
  if (!terminalId) return null;
  return {
    terminalId,
    projectId: facts?.getTerminalProjectId(terminalId) ?? null,
    worktreeId:
      payload.worktreeId || facts?.getTerminalLaunchAttribution(terminalId)?.worktreeId || null,
    incarnation: facts?.getLiveGeneration(terminalId) ?? null,
    agentIncarnation: typeof payload.agentIncarnation === "number" ? payload.agentIncarnation : null,
    waitingReason: payload.waitingReason ?? null,
    refined: payload.previousState === "waiting",
    seenAt: payload.timestamp,
  };
}

/**
 * One agent's wait as this Shell heard it. `event`: the host's own report, or
 * this machine's. `attention`: the person's attention notice from a host too
 * old to send that, which names no reason, run or time.
 */
export interface AgentWaitingHeard extends Omit<AgentWaitingPayload, "seenAt"> {
  source: "event" | "attention";
  seenAt: number | null;
}

export type AgentWaitingListener = (hostId: string, heard: AgentWaitingHeard) => void;
