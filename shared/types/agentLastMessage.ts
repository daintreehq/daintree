import type {
  AgentSubagentUnavailableReason,
  SubagentProvider,
} from "./ipc/agentSubagents.js";

/**
 * What an agent last wrote to its own transcript, read by the host for a panel
 * the caller created (#12479).
 *
 * Everything here is an observation of a file, never a conclusion about the
 * agent. `stopReason` is whatever the transcript recorded, an unanswered tool
 * use does not prove the CLI is waiting on it right now, and a permission
 * prompt is not in the file at all — scrollback stays the source for those.
 */

/**
 * The subagent taxonomy, minus the one arm that names a child this tool never
 * takes, plus three only a transcript read can reach.
 */
export type AgentLastMessageUnavailableReason =
  | Exclude<AgentSubagentUnavailableReason, "subagent-not-found">
  /** The pane's store could not be pinned down, so no file was trusted to be its. */
  | "store-unknown"
  /** Nothing the agent wrote is on record yet. */
  | "no-message"
  /**
   * The bounded read ran out before reaching any reply. One huge tool-result
   * line can hide the latest one, and an older reply is not handed back as if
   * it were current.
   */
  | "search-cap-reached";

export const AGENT_LAST_MESSAGE_UNAVAILABLE_REASONS = [
  "provider-mismatch",
  "terminal-unknown",
  "no-session",
  "cli-missing",
  "ambiguous-session",
  "timeout",
  "protocol-error",
  "store-unreadable",
  "store-unknown",
  "no-message",
  "search-cap-reached",
] as const satisfies readonly AgentLastMessageUnavailableReason[];

export interface AgentLastMessage {
  /** The provider's id for the message, when the record carried one. */
  id: string | null;
  /** Its text blocks in order, joined by blank lines. */
  text: string;
  /** The head was cut to fit, or some of the message's records were beyond the read. */
  truncated: boolean;
  recordedAt: number | null;
  /** Raw from the transcript; not a verdict on whether the turn finished. */
  stopReason: string | null;
}

export interface AgentUnansweredToolUse {
  id: string;
  name: string;
  /** Only for a question to the user, and omitted whole when too large to return intact. */
  input?: Record<string, unknown>;
}

export interface AgentLastMessageOk {
  status: "ok";
  provider: SubagentProvider;
  /** Null when no reply with text was on record but an unanswered tool use was. */
  message: AgentLastMessage | null;
  /**
   * Calls made in or after `message` — or anywhere, when there is none — with
   * no result later in the file. Oldest first.
   */
  unansweredToolUses: AgentUnansweredToolUse[];
  /**
   * A prompt, a tool result or another message follows the text of `message`,
   * or the last line was still being written.
   */
  newerRecordsFollow: boolean;
  fileUpdatedAt: number;
}

export interface AgentLastMessageUnavailable {
  status: "unavailable";
  reason: AgentLastMessageUnavailableReason;
}

export type AgentLastMessageResult = AgentLastMessageOk | AgentLastMessageUnavailable;

/** Cap on `message.text`, measured as the bytes it costs once JSON-escaped, keeping the tail. */
export const LAST_MESSAGE_TEXT_MAX_BYTES = 24 * 1024;

/** Unanswered tool uses returned, newest kept. */
export const LAST_MESSAGE_TOOL_USE_LIMIT = 8;

/** Cap on one question's serialized input; a larger one is omitted rather than cut. */
export const LAST_MESSAGE_TOOL_INPUT_MAX_BYTES = 8 * 1024;

/** Cap on every returned input together. */
export const LAST_MESSAGE_TOOL_INPUTS_TOTAL_MAX_BYTES = 16 * 1024;

/** The one tool whose input is returned: its questions and choices are the whole point. */
export const ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion";
