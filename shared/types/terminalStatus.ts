import type { AgentState, WaitingReason } from "./agent.js";
import type { TerminalCheckResult } from "./checkResult.js";
import type { TerminalSubmissionRecord } from "./terminalSubmission.js";

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
 * It cuts both ways. `hasPty` and `lastOutputChangeAt` are read in the
 * pty-host, so the reduced `pty` answer reports them and the richer `renderer`
 * answer cannot — a surface listing nothing is not the same as a surface that
 * saw everything.
 */
export type TerminalStatusUnavailableField =
  "armed" | "lastCheckResult" | "exitCode" | "hasPty" | "lastOutputChangeAt";

/**
 * Model-facing description of `lastOutputChangeAt`, shared by the status and
 * wait output schemas so the three copies cannot drift apart.
 */
export const LAST_OUTPUT_CHANGE_AT_DESCRIPTION =
  "Epoch ms the visible screen last changed, ignoring recognized spinner/timer redraws. Absent if unobserved. Not a hang verdict.";

/** One terminal's status, in the shape `TerminalStatusEntrySchema` publishes. */
export interface TerminalStatusEntry {
  terminalId: string;
  agentId: string | null;
  agentState: AgentState | null;
  waitingReason?: WaitingReason;
  lastTransitionAt?: number;
  /**
   * When the terminal's visible content last changed, ignoring recognised
   * spinner and timer redraws (#12428). An observation for the caller to act
   * on, never a hang verdict: long reasoning leaves the screen just as still.
   * Read in the pty-host, so only the `pty` answer reports it.
   */
  lastOutputChangeAt?: number;
  exitCode?: number | null;
  spawnedAt?: number;
  lastCheckResult?: TerminalCheckResult;
  recentOutput?: string | null;
  /**
   * `true` when older output was left out of `recentOutput`, by the requested
   * line count or by the shared response budget (#12450). Never sent as
   * `false`: absent beside a string `recentOutput` means the tail is complete.
   */
  recentOutputTruncated?: boolean;
  armed?: boolean;
  hasPty?: boolean;
  /**
   * The record for the `submissionToken` the query named (#12337). Present only
   * on entries the surface could read, and only when a token was asked for.
   */
  submission?: TerminalSubmissionRecord;
  error?: string;
}

export interface TerminalStatusResult {
  terminals: TerminalStatusEntry[];
  source: TerminalStatusSource;
  unavailableFields: TerminalStatusUnavailableField[];
}
