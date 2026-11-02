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

export interface DecisionsAttentionItem {
  questionId: string;
  /** The `N` of the `q-N` the agent was told. */
  alias: number;
  /** `delivery-uncertain`: the answer may or may not have been typed in already. */
  status: "needs-attention" | "delivery-uncertain";
  /** The library's code for why (`pane_gone`, `resume_timeout`, …); `unspecified` when none was recorded. */
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
   * Null when there is an answer.
   */
  answerUnavailable: "none" | "unreadable" | null;
  /**
   * Resuming the agent's session could deliver it: an agent Daintree can
   * resume, asked on this computer, with a session and a worktree that is
   * still there.
   */
  canResume: boolean;
  /** Another pane can be chosen for it. Never for an answer that may already have been typed in. */
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
 * - `waiting`: it has a pane again (`terminalId`), and is typed in once that
 *   pane is idle, or its host is back (`waitsFor`).
 * - `needs-attention`: it still needs a person, for `reason`.
 * - `handled`: marked handled; it leaves the list, and is never typed in.
 * - `resolved`: it no longer needed a person by the time this ran.
 * - `refused`: nothing was done (`reason`).
 */
export type DecisionsAnswerOutcome =
  | { result: "delivered"; terminalId: string; title: string | null }
  | { result: "waiting"; terminalId: string; title: string | null; waitsFor: "idle" | "host" }
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
