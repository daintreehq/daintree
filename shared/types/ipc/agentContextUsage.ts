/**
 * The context a Claude Code pane's most recent main-conversation request
 * carried (#16371), as the CLI recorded it in its own transcript.
 *
 * Only what the transcript says: the request's input, cache-write and
 * cache-read token counts summed, and when it was written. The transcript
 * names the model but not the context window it ran with, so no fraction of a
 * window is offered.
 */

export type AgentContextUsageUnavailableReason =
  /** No such terminal, or one whose record can't say where it runs. */
  | "terminal-unknown"
  /** The pane isn't running Claude Code. */
  | "provider-mismatch"
  /** The pane has no recorded session id to find a transcript by. */
  | "no-session"
  /** Where this pane's Claude Code keeps its transcripts was never pinned down. */
  | "store-unknown"
  /** The transcript holds no request yet, or none since the last compaction. */
  | "no-request"
  /** The newest request's usage wasn't in a shape this reader recognises. */
  | "unrecognized"
  /** The read's ceiling came before any request. */
  | "search-cap-reached"
  | "store-unreadable";

export type AgentContextUsageResult =
  | {
      status: "ok";
      provider: "claude";
      /** Input, cache-write and cache-read tokens of the request, summed. */
      contextTokens: number;
      /** When the transcript says the request's reply was written, epoch ms; null when it doesn't. */
      recordedAt: number | null;
    }
  | { status: "unavailable"; reason: AgentContextUsageUnavailableReason };
