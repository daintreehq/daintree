import type { AgentState, WaitingReason } from "./agent.js";
import type { TerminalCheckResult } from "./checkResult.js";

/**
 * Which surface answered a `terminal.getStatus` call (#12316).
 *
 * `renderer` is the full answer: the panel store knows where a terminal sits,
 * whether it is armed for fleet broadcast, and what its last parsed check
 * result was. `pty` is the reduced answer main can give when the bound
 * workspace has no live view — read straight off the pty-host records, so it
 * carries agent state and process facts but nothing panel-shaped.
 */
export type TerminalStatusSource = "renderer" | "pty";

/**
 * Entry fields the answering surface could not observe at all, as opposed to
 * observed-and-absent. Without this a `pty` answer's missing `armed` reads as
 * "not armed", which is an interpretation main has no evidence for.
 */
export type TerminalStatusUnavailableField = "armed" | "lastCheckResult";

/** One terminal's status, in the shape `TerminalStatusEntrySchema` publishes. */
export interface TerminalStatusEntry {
  terminalId: string;
  agentId: string | null;
  agentState: AgentState | null;
  waitingReason?: WaitingReason;
  lastTransitionAt?: number;
  exitCode?: number | null;
  spawnedAt?: number;
  lastCheckResult?: TerminalCheckResult;
  recentOutput?: string | null;
  armed?: boolean;
  error?: string;
}

export interface TerminalStatusResult {
  terminals: TerminalStatusEntry[];
  source: TerminalStatusSource;
  unavailableFields: TerminalStatusUnavailableField[];
}
