import type { AgentState, WaitingReason } from "../../shared/types/agent.js";

// Apart from the reader, so what builds a cleanup request or a host's answer
// takes in none of the transcript and terminal modules it reads with.

// The question a reply ends on is what a dictated answer leans on, so the
// newest text survives.
export const MAX_CORRECTION_REPLY_CHARS = 3000;

/**
 * What the dictated agent's own transcript last recorded it saying (#14900):
 * an observation of a file, which may be older than the screen. The state
 * beside it is what Daintree's output heuristics last reported for the
 * terminal, which can be wrong. Times are stamps, not ages, so the same
 * observation read twice is the same request.
 */
export interface VoiceAgentReply {
  /** Redacted and bounded, the newest text kept. */
  text: string;
  /** The head was cut, by the transcript read or the bound. */
  truncated: boolean;
  /** When the transcript recorded the reply (epoch ms); null when it didn't say. */
  recordedAt: number | null;
  /** The transcript holds something newer than the reply: a prompt, a tool result, another record. */
  newerRecordsFollow: boolean;
  observedState?: VoiceObservedAgentState;
}

export interface VoiceObservedAgentState {
  state: AgentState;
  waitingReason?: WaitingReason;
  /** When the state record last changed (epoch ms), not proof it held since; null when never stamped. */
  lastStateChangeAt: number | null;
}
