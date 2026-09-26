import type { AgentState, WaitingReason } from "./agent.js";
import type { TerminalCheckResult } from "./checkResult.js";
import type { TerminalHandback } from "./handback.js";
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
 * saw everything. The renderer reads `lastOutputChangeAt` only when the call
 * asked for output (#12495), so it drops out of this list for those calls.
 * `lastTypedInputAt` rides the same read (#12718) and drops out with it.
 */
export type TerminalStatusUnavailableField =
  "armed" | "lastCheckResult" | "exitCode" | "hasPty" | "lastOutputChangeAt" | "lastTypedInputAt";

/**
 * Model-facing description of `lastOutputChangeAt`, shared by the status and
 * wait output schemas so the three copies cannot drift apart.
 */
export const LAST_OUTPUT_CHANGE_AT_DESCRIPTION =
  "Epoch ms the screen last changed, ignoring spinner and timer redraws. Absent if unobserved. Not a hang verdict.";

/** Model-facing description of `lastTypedInputAt`. */
export const LAST_TYPED_INPUT_AT_DESCRIPTION =
  "Epoch ms of the last raw PTY input (keys, paste, broadcast; not sends). Before `lastTransitionAt` means none since. Not proof of delivery or authorship.";

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
   * Read in the pty-host, so the `renderer` answer reports it only when the
   * call asked for output (#12495).
   */
  lastOutputChangeAt?: number;
  /**
   * When Daintree last recorded raw input for this PTY (#12718) — keystrokes
   * including control keys, pastes, staging, broadcast — excluding the submit
   * lane's own writes and the reports xterm sends by itself. Stamped as the
   * write is attempted, so it proves neither delivery nor what the composer
   * holds. A CLI can pre-fill its own suggested prompt, which nothing here
   * records, so a caller can compare this against `lastTransitionAt` to see
   * whether any input came through since the terminal settled — never a
   * verdict on who authored what the screen shows. Read in the pty-host, so
   * the `renderer` answer reports it only when the call asked for output.
   */
  lastTypedInputAt?: number;
  exitCode?: number | null;
  spawnedAt?: number;
  /**
   * How many new agent sessions this terminal's PTY has been observed taking on
   * after a prior one exited (#12535).
   *
   * `spawnedAt` is the PTY generation and cannot move when an agent exits and
   * the user relaunches one in the shell it left behind — the PTY, its pid and
   * its restart count all hold. This is the field that moves for that, so a
   * caller holding an earlier reading can tell the session it saw from its
   * successor. An observation of boundaries the detector caught, never proof of
   * process identity: a relaunch it never classified leaves this unchanged.
   *
   * Zero is a real reading — none observed in this PTY generation. Absent means
   * the surface could not observe it, which is not zero — except on the
   * `renderer` answer, which reports zero for any pane it holds, including one
   * it adopted without ever being told the count. One counter exists and the
   * pty-host owns it; the `renderer` answer is a cache of what the host has
   * told this view, so it can lag a `pty` answer for the same terminal and can
   * read zero before the first reading reaches it. Compare readings from one
   * source rather than across a `pty`/`renderer` switch.
   */
  agentIncarnation?: number;
  lastCheckResult?: TerminalCheckResult;
  /**
   * The handback marker the agent most recently printed for a submission that
   * asked for one (#12488). Read on both surfaces: the renderer from its panel
   * record, main from the pty-host record.
   */
  lastHandback?: TerminalHandback;
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

/**
 * One terminal's `lastOutputChangeAt` as read for the renderer's
 * `terminal.getStatus` (#12495).
 *
 * `read` with no timestamp says the terminal was read and no content change has
 * been observed yet; `unreadable` says nothing was observed at all — gone, not
 * owned by the caller, or its backend query failed. Folding the second into the
 * first would present a failed read as a screen that was watched and never
 * changed.
 */
export type TerminalOutputActivityLookup =
  | { status: "read"; lastOutputChangeAt?: number; lastTypedInputAt?: number }
  | { status: "unreadable" };

export interface TerminalStatusResult {
  terminals: TerminalStatusEntry[];
  source: TerminalStatusSource;
  unavailableFields: TerminalStatusUnavailableField[];
}
