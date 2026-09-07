/**
 * Read-only view of the child sessions an agent CLI spawned, shared by every
 * provider that can report them.
 *
 * The two providers agree on the shape and on nothing else. Codex answers a
 * protocol (`thread/list`, `thread/turns/list`) through a short-lived
 * app-server; Claude Code has no protocol at all, so its children are read out
 * of the JSONL files it already wrote. Everything below is what survives that
 * difference — the fetching is the only part allowed to diverge.
 *
 * All timestamps are milliseconds, converted once at the main-process boundary.
 */

/** Which CLI's store a result was read from. */
export type SubagentProvider = "codex" | "claude";

/** Why a child is blocked, when the provider says so. Codex reports this; Claude has no such signal. */
export type SubagentBlockedReason = "approval" | "input";

/**
 * Why nothing is known about a child. Kept as distinct arms rather than one
 * blank state because they are not the same admission: the provider declining
 * to load a thread, a half-finished step that stopped changing, and a record we
 * could not parse each mean something different to whoever is looking.
 */
export type SubagentUnknownReason =
  /** The provider holds the child but never loaded it, so it reported no state. */
  | "not-loaded"
  /** The last thing on record was an unfinished step, and it stopped changing. */
  | "stale"
  /** There was a record, but not in a shape this version recognises. */
  | "unrecognized";

/**
 * Deliberately not flattened to a string: `unknown` and `blocked` both carry
 * the reason that makes them worth showing.
 *
 * No provider emits every arm, and that is the point — each one maps only into
 * the states it can actually establish. Codex never reports `completed`,
 * because a thread it did not load has no finish to observe. Claude never
 * reports `idle`, `blocked`, or `error`, because a file on disk cannot say a
 * child is waiting on approval or that it failed. An arm a provider cannot
 * honestly reach is one it must never guess at.
 */
export type AgentSubagentStatus =
  | { type: "unknown"; reason: SubagentUnknownReason }
  | { type: "idle" }
  | { type: "working" }
  | { type: "blocked"; reason: SubagentBlockedReason }
  | { type: "completed" }
  | { type: "error" };

export interface AgentSubagent {
  /** Provider-scoped child id: a Codex thread id, a Claude agent id. */
  id: string;
  /** The handle the provider hangs on the child — Codex's nickname, Claude's description of the delegated task. */
  label: string | null;
  /** What kind of worker it is: Codex's role, Claude's agent type. */
  role: string | null;
  /** Usually the first user message — the task the parent delegated. */
  preview: string;
  /** Model the child ran on, when the provider records one. */
  model: string | null;
  /** Depth in the spawn tree. Claude records it; Codex does not. */
  depth: number | null;
  status: AgentSubagentStatus;
  createdAt: number;
  updatedAt: number;
}

/**
 * Why the subagent view has nothing to show. Stable slugs, not prose: the
 * renderer maps them to microcopy, and `detail` (scrubbed) is diagnostics only.
 *
 * Some arms only one provider can reach — `ambiguous-session` needs a provider
 * that has to guess at its parent, `store-unreadable` needs one that reads
 * files — but they share a taxonomy so the renderer handles a single set.
 */
export type AgentSubagentUnavailableReason =
  /** This terminal isn't running an agent whose children we can read. */
  | "provider-mismatch"
  | "terminal-unknown"
  | "no-session"
  /** The requested child isn't one of this terminal's. */
  | "subagent-not-found"
  | "cli-missing"
  /**
   * Two or more sessions in this folder started close enough together that
   * nothing distinguishes which one this terminal is running. Reported instead
   * of a guess: the wrong session's children look exactly like the right ones,
   * and the user has no way to tell which they got. Codex only — Claude's
   * parent is an exact id, so it is never in doubt.
   */
  | "ambiguous-session"
  | "timeout"
  | "protocol-error"
  /** The store is there but could not be read. Claude only. */
  | "store-unreadable";

export interface AgentSubagentsOk {
  status: "ok";
  provider: SubagentProvider;
  /** The parent session/thread the children hang off. */
  parentId: string;
  subagents: AgentSubagent[];
}

export interface AgentSubagentsUnavailable {
  status: "unavailable";
  reason: AgentSubagentUnavailableReason;
  detail?: string;
}

export type AgentSubagentsResult = AgentSubagentsOk | AgentSubagentsUnavailable;

export interface AgentSubagentMessage {
  /** `task` is what the parent asked for, `reply` is what the child said back. */
  role: "task" | "reply";
  text: string;
}

export interface AgentSubagentTranscriptOk {
  status: "ok";
  subagentId: string;
  /** Oldest first, so a child reads as the task it was given and the answer it gave. */
  messages: AgentSubagentMessage[];
  /** Older messages were dropped to stay inside the cap, or never fetched. */
  truncated: boolean;
}

export type AgentSubagentTranscriptResult = AgentSubagentTranscriptOk | AgentSubagentsUnavailable;

/**
 * One root Codex session recorded for a folder — what "Find session"
 * (issue #12182) offers to reopen after a restore couldn't reattach to the
 * prior conversation.
 *
 * Deliberately minimal: `preview` is the session's own first message, which
 * is conversation text and must stay local — never logged, sent anywhere but
 * the renderer that asked for it, or persisted.
 */
export interface CodexFolderSession {
  id: string;
  preview: string;
  updatedAt: number;
}

export interface CodexFolderSessionsOk {
  status: "ok";
  sessions: CodexFolderSession[];
}

export type CodexFolderSessionsResult = CodexFolderSessionsOk | AgentSubagentsUnavailable;

/**
 * Messages returned per transcript read. Bounded so one long-running child
 * can't flood IPC. When it bites, the delegated task is kept and the oldest
 * replies are dropped — the task is the one message that explains the rest.
 */
export const SUBAGENT_TRANSCRIPT_MESSAGE_LIMIT = 24;

/** Per-message character cap applied before a transcript crosses IPC. */
export const SUBAGENT_MESSAGE_MAX_CHARS = 4000;

/** Children returned for one parent. */
export const SUBAGENT_LIST_LIMIT = 50;

/**
 * Trim a transcript to `limit`, dropping the oldest replies but keeping the
 * delegated task wherever it sits.
 *
 * The task is what makes every reply below it legible, so it is the one message
 * that must not be the thing evicted to make room. Shared rather than written
 * per provider, because both trim and both promised the same thing.
 */
export function trimPreservingTask(messages: AgentSubagentMessage[], limit: number): void {
  if (messages.length <= limit) return;
  if (limit <= 0) {
    messages.length = 0;
    return;
  }
  // Held by identity rather than by index: every eviction shifts the array, so
  // an index captured once stops pointing at the task after the first splice
  // and the loop goes on to delete the very message it was protecting.
  const task = messages.find((message) => message.role === "task");
  while (messages.length > limit) {
    const oldestEvictable = messages.findIndex((message) => message !== task);
    // Nothing but the protected message left, so the limit wins over it.
    messages.splice(oldestEvictable === -1 ? 0 : oldestEvictable, 1);
  }
}
