/**
 * How much context an agent pane carries, as the CLI recorded it in its own
 * session file: Claude Code's transcript (#16371) or Codex's rollout (#16408).
 *
 * Only what the file says, and each agent's figure is its own:
 *
 * - Claude Code: the most recent main-conversation request's input,
 *   cache-write and cache-read token counts summed. The transcript names the
 *   model but not the context window it ran with, so no window is offered.
 * - Codex: `last_token_usage.total_tokens` of the newest token count, the
 *   figure Codex itself measures its context by, which after a compaction is
 *   Codex's own estimate of what remains. The window is the one that same
 *   record states, when it states one.
 */

export type AgentContextUsageProvider = "claude" | "codex";

export type AgentContextUsageUnavailableReason =
  /** No such terminal, or one whose record can't say where it runs. */
  | "terminal-unknown"
  /** The pane isn't running the agent that was asked about. */
  | "provider-mismatch"
  /** The pane has no recorded session id to find a transcript by. */
  | "no-session"
  /** Where this pane's Claude Code keeps its transcripts was never pinned down. */
  | "store-unknown"
  /** Codex: no single rollout could be shown to be the one the pane's Codex is writing. */
  | "rollout-unknown"
  /** Codex: nothing on this platform can see which rollout a process holds open (Windows). */
  | "unsupported-platform"
  /** Codex: the process or open-file listing failed, was cut short, or ran out of time. */
  | "probe-failed"
  /** The session file holds no usage yet, or none since the last compaction. */
  | "no-request"
  /** The newest usage record wasn't in a shape this reader recognises. */
  | "unrecognized"
  /** The read's ceiling came before any usage record. */
  | "search-cap-reached"
  | "store-unreadable"
  /** The pane restarted or moved to another session while it was read. */
  | "pane-changed";

export type AgentContextUsageResult =
  | {
      status: "ok";
      provider: "claude";
      /** Input, cache-write and cache-read tokens of the request, summed. */
      contextTokens: number;
      /** When the transcript says the request's reply was written, epoch ms. */
      recordedAt: number;
    }
  | {
      status: "ok";
      provider: "codex";
      /** The newest token count's `last_token_usage.total_tokens`. */
      contextTokens: number;
      /** The context window the same record states, in tokens; absent when it states none. */
      contextWindow?: number;
      /** When the rollout says the token count was written, epoch ms. */
      recordedAt: number;
    }
  | { status: "unavailable"; reason: AgentContextUsageUnavailableReason };
