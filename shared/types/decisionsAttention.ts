/**
 * Answers Daintree couldn't type in on its own, as the needs-attention list
 * shows them (#16020): read on demand from the owner's store, never pushed.
 * Unlike the pane chip's state, an item carries the question's first line
 * and the answer itself, since deciding what to do with an answer means
 * seeing it; both stay on this computer.
 */

/** Where the question was asked, in the names this computer knows. */
export interface DecisionsAnswerOrigin {
  projectId: string;
  /** The project's name here; null when it is no longer one of this computer's projects. */
  projectName: string | null;
  /** The worktree's id here; empty for a pane outside any worktree. */
  worktreeId: string;
  /** The folder the agent ran in, by name; null when none was recorded. */
  worktreeName: string | null;
  agentId: string;
  /** The agent's name in the registry; null for one Daintree doesn't know. */
  agentName: string | null;
  paneId: string;
  /** The pane's title while it is still open here, perhaps running another session; null once it's gone. */
  paneTitle: string | null;
}

/** The answer waiting to be typed in, opened. */
export interface DecisionsAnswerPreview {
  source: "human" | "proxy";
  /** The chosen options, by label where the phone sent one, in order. */
  choices: string[];
  /** The free text as it would be typed (cut only where typing would cut it); null when there was none. */
  text: string | null;
  /** This answer replaces an earlier one. */
  correction: boolean;
  /** When the answer arrived, ISO 8601. */
  answeredAt: string;
}

/** A follow-up the person sent from their phone (#16231) that Daintree won't type in on its own, opened. */
export interface DecisionsFollowUpPreview {
  messageId: string;
  /** `delivery-uncertain`: it may or may not have been typed in already. */
  status: "needs-attention" | "delivery-uncertain";
  /** The library's code for why; `unspecified` when none was recorded. */
  reason: string;
  /** What the person wrote, as it would be typed; null when it had no words, or couldn't be opened. */
  text: string | null;
  /** It couldn't be opened on this computer. */
  unreadable: boolean;
  /** When the person sent it, ISO 8601. */
  sentAt: string;
}

/**
 * One question whose answer, or a follow-up after it, needs a person. The
 * answer fields describe the answer only while it is one of those.
 */
export interface DecisionsAttentionItem {
  questionId: string;
  /** The `N` of the `q-N` the agent was told. */
  alias: number;
  /** `delivery-uncertain`: the answer, or a follow-up, may or may not have been typed in already. */
  status: "needs-attention" | "delivery-uncertain";
  /**
   * The library's code for why (`pane_gone`, `resume_timeout`, …), the
   * answer's while it needs a person, else the first follow-up's;
   * `unspecified` when none was recorded.
   */
  reason: string;
  /** The question as asked, its first line; null when it couldn't be opened here. */
  question: string | null;
  /** When the pane asked, ISO 8601. */
  askedAt: string;
  origin: DecisionsAnswerOrigin;
  /** Null when no answer is waiting to be typed in, or it couldn't be opened here. */
  answer: DecisionsAnswerPreview | null;
  /**
   * Why `answer` is null: nothing is waiting to be typed in for it (`none`),
   * or something is but it couldn't be opened on this computer (`unreadable`).
   * Null when there is an answer, or the answer doesn't need a person.
   */
  answerUnavailable: "none" | "unreadable" | null;
  /** The follow-ups that need a person, in the order they were sent. */
  followUps: DecisionsFollowUpPreview[];
  /**
   * Resuming the agent's session could deliver it: an agent Daintree can
   * resume, asked on this computer, with a session and a worktree that is
   * still there.
   */
  canResume: boolean;
  /**
   * Another pane can be chosen for it, answer and follow-ups alike. Never for
   * one that may already have been typed in.
   */
  canReassign: boolean;
}

/**
 * - `listed`: every answer needing a person, oldest question first.
 * - `not-running`: Decisions isn't delivering answers on this computer (no
 *   relay set up, revoked, or stopped), so none can be read or acted on.
 */
export type DecisionsAttentionList =
  { result: "listed"; items: DecisionsAttentionItem[] } | { result: "not-running" };

/** A pane an answer could be typed into instead: an agent running here now. */
export interface DecisionsAnswerDestination {
  terminalId: string;
  title: string;
  agentId: string;
  agentName: string | null;
  projectId: string;
  projectName: string | null;
  /** Empty for a pane outside any worktree. */
  worktreeId: string;
  worktreeName: string | null;
  /** The pane the question was asked in, relaunched since. */
  askedHere: boolean;
}

export type DecisionsAnswerDestinations =
  | { result: "listed"; destinations: DecisionsAnswerDestination[] }
  | { result: "not-running" }
  /** The answer no longer needs a person, or can't be moved. */
  | { result: "unavailable" };

export interface ReassignDecisionsAnswerPayload {
  questionId: string;
  /** The pane the person confirmed. */
  terminalId: string;
}

export interface MarkDecisionsAnswerHandledPayload {
  questionId: string;
}

/**
 * What became of an answer after an action on it, as observed once
 * delivery had a go:
 *
 * - `delivered`: typed into `terminalId`.
 * - `waiting`: it has a pane again (`terminalId`), and is typed in once its
 *   composer is empty (for an agent that takes a line mid-turn), at the
 *   agent's next prompt, or once its host is back (`waitsFor`).
 * - `needs-attention`: it still needs a person, for `reason`.
 * - `handled`: marked handled; it leaves the list, and is never typed in.
 * - `resolved`: it no longer needed a person by the time this ran.
 * - `refused`: nothing was done (`reason`).
 */
export type DecisionsAnswerOutcome =
  | { result: "delivered"; terminalId: string; title: string | null }
  | {
      result: "waiting";
      terminalId: string;
      title: string | null;
      waitsFor: "composer" | "prompt" | "host";
    }
  | {
      result: "needs-attention";
      status: "needs-attention" | "delivery-uncertain";
      reason: string;
    }
  | { result: "handled" }
  | { result: "resolved" }
  | {
      result: "refused";
      reason:
        | "not-running"
        /** It may already have been typed in, so it is never typed again from here. */
        | "uncertain"
        /** No answer was kept for it. */
        | "no-answer"
        /** The chosen pane closed, or isn't running an agent Daintree can type into. */
        | "destination-gone";
    };
