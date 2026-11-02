import type { DecisionsStatus, PaneDecisionState } from "@shared/types/decisions";

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
