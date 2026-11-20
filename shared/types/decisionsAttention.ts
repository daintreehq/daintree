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
  /**
   * The machine that asked, when it isn't this computer (#17944): its id, and
   * an enrolled Remote Host's name while this computer knows one. Null for a
   * question this computer asked.
   */
  otherHost: { hostId: string; name: string | null } | null;
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

/**
 * The notice that a question's deadline closed it without an answer (#17944),
 * waiting for a person because typing it into the terminal that asked
 * stopped. Only what was recorded: which round it closed and when, how far
 * typing it got, and for an advisory round what it says of the agent's plan.
 * Never that the agent read it or acted on it.
 */
export interface DecisionsTimeoutNotice {
  /**
   * `expired`: the deadline passed with no answer. `never-published`: it
   * passed before the question ever reached the relay.
   */
  kind: "expired" | "never-published";
  /** The round it closed. */
  revision: number;
  /** When that round's deadline passed, ISO 8601; null when none was recorded. */
  deadline: string | null;
  /**
   * `delivery-uncertain`: a write of it may or may not have reached the
   * terminal, so it is never typed again from here.
   */
  delivery: "needs-attention" | "delivery-uncertain";
  /**
   * An advisory round's notice: whether, once typed (or as it may have been
   * typed), it tells the agent it may go ahead with its stated plan
   * (`fallback-due`) or not (`fallback-withheld`). Null for a question that
   * waited for a reply, or when it can't be told.
   */
  disposition: "fallback-due" | "fallback-withheld" | null;
}

/** A follow-up the person sent (#16231) that Daintree won't type in on its own, opened. */
export interface DecisionsFollowUpPreview {
  messageId: string;
  /** Written on their computer (#17238) rather than a phone. */
  onComputer: boolean;
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
  /**
   * The timeout notice that needs a person in place of an answer (#17944);
   * null when what needs one is an answer, or only follow-ups.
   */
  notice: DecisionsTimeoutNotice | null;
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
  /**
   * What the item asks of the person as read, an opaque token of ids and
   * states (#17944): sent back with Mark handled and Choose destination, so
   * main refuses an action confirmed before the question asked something else.
   */
  token: string;
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
  /**
   * When an answer moved here is typed in, by its agent: once its composer is
   * empty (an agent that takes a line mid-turn), or at its next prompt. Its
   * host is live while it is listed.
   */
  waitsFor: "composer" | "prompt";
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
  /** The item's `token` as the person saw it; refused as `changed` once it no longer holds. */
  expected?: string;
}

export interface MarkDecisionsAnswerHandledPayload {
  questionId: string;
  /** The item's `token` as the person saw it; refused as `changed` once it no longer holds. */
  expected?: string;
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
      /**
       * Only the follow-ups the action sent back still wait: the timeout
       * notice sent with them no longer does, its round replaced (#17944).
       */
      followUpsOnly?: true;
    }
  | {
      result: "needs-attention";
      status: "needs-attention" | "delivery-uncertain";
      reason: string;
      /** Only follow-ups the action sent back are left: the notice sent with them was replaced (#17944). */
      followUpsOnly?: true;
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
        | "destination-gone"
        /**
         * The question asked for advice and is still in that round (#17941): only
         * the agent that asked it, or a resume of its session, takes its outcome.
         */
        | "asker-only"
        /** It asks something else than when it was read (#17944): nothing was done. */
        | "changed";
    };
