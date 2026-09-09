import type { AgentState, WaitingReason } from "./agent.js";
import type { TerminalCheckResult } from "./checkResult.js";

/**
 * Which surface answered a `terminal.getStatus` call (#12316).
 *
 * `renderer` answers from the panel store: where a terminal sits, whether it is
 * armed for fleet broadcast, and what its last parsed check result was. `pty`
 * is what main can give when the bound workspace has no live view — read
 * straight off the pty-host records, so it carries agent state and process
 * facts but nothing panel-shaped.
 *
 * Neither strictly contains the other, so a client must not prefer one wholesale
 * (#12336): `hasPty` is computed in the pty-host and only the `pty` answer
 * reports it. Read `unavailableFields` on each response rather than assuming a
 * ranking, and treat a field that drops out when a view opens as unknown, not as
 * a value that stayed true.
 */
export type TerminalStatusSource = "renderer" | "pty";

/**
 * Entry fields the answering surface could not observe at all, as opposed to
 * observed-and-absent. Without this a `pty` answer's missing `armed` reads as
 * "not armed", which is an interpretation main has no evidence for.
 *
 * It cuts both ways. `hasPty` is the one field the reduced `pty` answer reports
 * and the richer `renderer` answer cannot, so a surface listing nothing is not
 * the same as a surface that saw everything.
 */
export type TerminalStatusUnavailableField = "armed" | "lastCheckResult" | "exitCode" | "hasPty";

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
  hasPty?: boolean;
  error?: string;
}

export interface TerminalStatusResult {
  terminals: TerminalStatusEntry[];
  source: TerminalStatusSource;
  unavailableFields: TerminalStatusUnavailableField[];
}
