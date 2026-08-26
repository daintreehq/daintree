/**
 * Read-only view of the subagent threads a live Codex CLI session spawned.
 *
 * Sourced from the Codex app-server protocol (`thread/list`, `thread/read`,
 * `thread/turns/list`) rather than `~/.codex/sessions/**\/rollout-*.jsonl`:
 * Codex calls those "legacy local sessions" and its own migration leaves
 * subagent threads with empty projected history (openai/codex#38762).
 *
 * Protocol timestamps are Unix SECONDS; everything below is milliseconds,
 * converted once at the main-process boundary.
 */

/** Mirrors the protocol's `ThreadActiveFlag`. */
export type CodexSubagentActiveFlag = "waitingOnApproval" | "waitingOnUserInput";

/**
 * Mirrors the protocol's `ThreadStatus` tagged union — deliberately not
 * flattened to a string, because `active` carries the flags that say *why*.
 *
 * Daintree queries through its own short-lived app-server process, which sees
 * only persisted state, so in practice this is `notLoaded` for every child.
 * The other arms are kept because the protocol can return them and a status
 * renderer that silently drops them would show a live child as dormant.
 */
export type CodexSubagentStatus =
  | { type: "notLoaded" }
  | { type: "idle" }
  | { type: "systemError" }
  | { type: "active"; activeFlags: CodexSubagentActiveFlag[] };

export interface CodexSubagent {
  threadId: string;
  parentThreadId: string | null;
  /** Random nickname Codex assigns a spawned sub-agent ("Meitner", "Kant"). */
  nickname: string | null;
  /** Role the parent gave the sub-agent, when it named one. */
  role: string | null;
  /** Usually the first user message — the task the parent delegated. */
  preview: string;
  cwd: string;
  status: CodexSubagentStatus;
  createdAt: number;
  updatedAt: number;
  /**
   * Fail-closed projection of the protocol's `canAcceptDirectInput`, which is
   * `null` (capability unavailable) for unloaded threads and `false` for
   * parent-owned subagents. Only a literal `true` maps to `true` here, so an
   * unloaded child can never be mistaken for one that accepts input.
   */
  acceptsDirectInput: boolean;
}

/** A root Codex thread in the terminal's cwd that could be its parent session. */
export interface CodexSessionCandidate {
  threadId: string;
  preview: string;
  createdAt: number;
}

/**
 * Why the subagent view has nothing to show. Stable slugs, not prose: the
 * renderer maps them to microcopy, and `detail` (scrubbed) is diagnostics only.
 */
export type CodexSubagentUnavailableReason =
  "not-codex" | "terminal-unknown" | "cli-missing" | "no-session" | "timeout" | "protocol-error";

export type CodexSubagentMatch = "session-id" | "cwd-recency";

export interface CodexSubagentsOk {
  status: "ok";
  parentThreadId: string;
  /** How the parent was resolved — `cwd-recency` is a heuristic, and says so. */
  matchedBy: CodexSubagentMatch;
  subagents: CodexSubagent[];
  /**
   * Populated only when more than one root thread in this cwd could be the
   * parent. Empty means the match was unambiguous.
   */
  candidates: CodexSessionCandidate[];
}

export interface CodexSubagentsUnavailable {
  status: "unavailable";
  reason: CodexSubagentUnavailableReason;
  detail?: string;
}

export type CodexSubagentsResult = CodexSubagentsOk | CodexSubagentsUnavailable;

export interface CodexSubagentMessage {
  role: "user" | "agent";
  text: string;
}

export interface CodexSubagentTurn {
  turnId: string;
  /** Protocol turn status ("completed", "failed", ...) when reported. */
  status: string | null;
  startedAt: number | null;
  completedAt: number | null;
  messages: CodexSubagentMessage[];
}

export interface CodexSubagentTranscriptOk {
  status: "ok";
  threadId: string;
  /** Newest turn first, matching the protocol's default ordering. */
  turns: CodexSubagentTurn[];
}

export type CodexSubagentTranscriptResult = CodexSubagentTranscriptOk | CodexSubagentsUnavailable;

/** Turns fetched per transcript read. Bounded so one child can't flood IPC. */
export const CODEX_SUBAGENT_TRANSCRIPT_TURN_LIMIT = 12;

/** Per-message character cap applied before a transcript crosses IPC. */
export const CODEX_SUBAGENT_MESSAGE_MAX_CHARS = 4000;
