import type { DecisionsStatus, PaneDecisionState } from "@shared/types/decisions";
import type {
  DecisionsAnswerDestinations,
  DecisionsAnswerOutcome,
  DecisionsAttentionList,
} from "@shared/types/decisionsAttention";

/** Daintree Decisions, as main observes it. Pane state comes from the machine that owns the pane. */
export const decisionsClient = {
  getStatus: (): Promise<DecisionsStatus> => window.electron.decisions.getStatus(),

  /**
   * Decisions' status from now on: subscribes before reading, and keeps
   * whichever carries the higher revision, so a read that lands after a push
   * can't roll it back. A read that fails calls nothing. The returned
   * function stops it, read included.
   */
  watchStatus: (onStatus: (status: DecisionsStatus) => void): (() => void) => {
    let latest = -1;
    let stopped = false;
    const accept = (status: DecisionsStatus) => {
      if (stopped) return;
      const revision = status.revision ?? 0;
      if (revision < latest) return;
      latest = revision;
      onStatus(status);
    };
    const off = window.electron.events.on("decisions:status-changed", accept);
    window.electron.decisions.getStatus().then(accept, () => {});
    return () => {
      stopped = true;
      off();
    };
  },

  /** Every answer a person has to decide about, opened, oldest question first (#16020). */
  listAttention: (): Promise<DecisionsAttentionList> => window.electron.decisions.listAttention(),

  /** The delimited block of an answer needing attention, to paste in by hand. Rejects when there is none. */
  copyAnswer: (questionId: string): Promise<string> =>
    window.electron.decisions.copyAnswer(questionId),

  /** Reopens the agent that asked and types the answer in; resolves with what became of it. */
  resumeAnswer: (questionId: string): Promise<DecisionsAnswerOutcome> =>
    window.electron.decisions.resumeAnswer(questionId),

  /** The agents running here now that the answer could be typed into instead. */
  listAnswerDestinations: (questionId: string): Promise<DecisionsAnswerDestinations> =>
    window.electron.decisions.listAnswerDestinations(questionId),

  /** Sends the answer to the pane the person confirmed; recorded in the audit trail. */
  reassignAnswer: (questionId: string, terminalId: string): Promise<DecisionsAnswerOutcome> =>
    window.electron.decisions.reassignAnswer({ questionId, terminalId }),

  /** The person dealt with it: it leaves the list and is never typed in. */
  markAnswerHandled: (questionId: string): Promise<DecisionsAnswerOutcome> =>
    window.electron.decisions.markAnswerHandled({ questionId }),

  /** A pane's current state; null while Decisions is off or the pane has nothing outstanding. */
  getPaneState: (terminalId: string): Promise<PaneDecisionState | null> =>
    window.electron.decisions.getPaneState(terminalId),

  /** Every pane's state changes for this project. Callers filter by `terminalId`. */
  onPaneState: (callback: (state: PaneDecisionState) => void): (() => void) =>
    window.electron.terminal.onDecisionState(callback),

  /**
   * One pane's state from mount on: subscribes before reading, so a change
   * between the two is never missed, and keeps whichever carries the higher
   * revision, so a read that lands after a push can't roll it back. `onState`
   * is called only with a state newer than the last; a read that finds
   * nothing calls nothing. The returned function stops it, read included.
   */
  watchPaneState: (
    terminalId: string,
    onState: (state: PaneDecisionState) => void
  ): (() => void) => {
    let latest = -1;
    let stopped = false;
    const accept = (state: PaneDecisionState | null) => {
      if (stopped || state === null || state.terminalId !== terminalId) return;
      if (state.revision <= latest) return;
      latest = state.revision;
      onState(state);
    };
    const off = window.electron.terminal.onDecisionState(accept);
    window.electron.decisions.getPaneState(terminalId).then(accept, () => {});
    return () => {
      stopped = true;
      off();
    };
  },
} as const;
