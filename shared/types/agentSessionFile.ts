/**
 * Which session file a pane's agent is writing (#16097): the one piece of an
 * agent's conversation a plugin can't find on its own. Answered for Codex and
 * Claude Code panes, and `unknown` with a reason for everything else.
 *
 * Each answer says how it was seen, because the two agents allow different
 * strengths of evidence:
 *
 * - `open-for-writing` (Codex): the pane's own process holds the rollout file
 *   open for writing, so it is the file being written now, under whatever
 *   `CODEX_HOME` the pane runs with, whether or not Daintree knew its id.
 * - `recorded-session-id` (Claude Code): the transcript for the session id
 *   Daintree recorded for the pane, in the store the pane was launched against.
 *   Claude Code keeps no file open, so a session the CLI switched to on its own
 *   (`/clear`, a fork) is not seen.
 *
 * A path is a moment's observation. The file is the CLI's own: read it, never
 * write it, and check it again when you open it.
 */

export const AGENT_SESSION_FILE_OBSERVATIONS = ["open-for-writing", "recorded-session-id"] as const;
export type AgentSessionFileObservation = (typeof AGENT_SESSION_FILE_OBSERVATIONS)[number];

export const AGENT_SESSION_FILE_AGENT_IDS = ["codex", "claude"] as const;
export type AgentSessionFileAgentId = (typeof AGENT_SESSION_FILE_AGENT_IDS)[number];

export const AGENT_SESSION_FILE_UNKNOWN_REASONS = [
  /** No terminal of this project's has that id, or its host didn't answer. */
  "terminal-unavailable",
  /** The pane runs no agent right now: exited, held, or back at its shell. */
  "no-live-agent",
  /** The pane's agent is neither Codex nor Claude Code. */
  "unsupported-agent",
  /** Nothing on this platform can observe it (Windows). */
  "unsupported-platform",
  /** The pane runs on a remote host, whose files aren't on this machine. */
  "remote-pane",
  /** Claude Code: no session id is on record for the pane. */
  "session-id-unknown",
  /** Claude Code: the store the pane reads was never certain. */
  "store-unknown",
  /** Nothing qualifying was seen. Not proof that no file exists. */
  "not-observed",
  /** More than one file fits, so none is named. */
  "ambiguous",
  /** A file was seen but failed a check: replaced, not a regular file, or not a session's own record. */
  "unverified",
  /** The process or file listing failed, was cut short, or ran out of time. */
  "probe-failed",
  /** The pane restarted or changed agent while it was looked up. */
  "pane-changed",
  /** Too many lookups are already running. */
  "busy",
] as const;
export type AgentSessionFileUnknownReason = (typeof AGENT_SESSION_FILE_UNKNOWN_REASONS)[number];

export type AgentSessionFileResult =
  | {
      status: "observed";
      agentId: AgentSessionFileAgentId;
      sessionId: string;
      /** Absolute path on this machine. */
      path: string;
      observedBy: AgentSessionFileObservation;
    }
  | { status: "unknown"; reason: AgentSessionFileUnknownReason };

export function unknownSessionFile(reason: AgentSessionFileUnknownReason): AgentSessionFileResult {
  return { status: "unknown", reason };
}
