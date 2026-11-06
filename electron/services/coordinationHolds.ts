/**
 * What an automatic sleep would silently drop: in-flight agent coordination
 * that lives in memory and is keyed to live terminals. Each source is read as
 * recorded, with no interpretation, and the answer is the observed kind.
 *
 * Ownership that cannot be resolved holds every project rather than guessing
 * from the active project or the terminal id.
 */
export type CoordinationHold =
  | "scheduled-run"
  | "waiting-run"
  | "unseen-hand-back"
  | "gated-park"
  | "pending-reply-wait"
  | "queued-notify"
  | "unattributed";

export interface CoordinationHoldSources {
  /** Owning project of a terminal, or null when it cannot be told. */
  projectOfTerminal: (terminalId: string) => string | null;
  /**
   * Whether a scheduled run of the project is still unsettled, or reserved and
   * about to spawn (#15978). Sleeping would kill the agent a schedule started
   * and leave the project reading as closed while it ran.
   */
  hasUnsettledScheduledRun: (projectId: string) => boolean;
  /** Projects of the fleet runs last observed `waiting`. */
  waitingRunProjectIds: () => readonly string[];
  /** Runs whose hand-back is still unseen. */
  unseenHandBackRunIds: () => readonly string[];
  /** Parks gated on another run. */
  gatedParks: () => ReadonlyArray<{ runId: string; gateRunId: string }>;
  /** Target of each outstanding MCP reply wait; undefined until a launch binds. */
  replyWaitTerminalIds: () => ReadonlyArray<string | undefined>;
  /** Projects owning notices, launches, wakes or undelivered lines. */
  notifyProjectIds: () => readonly string[];
}

export function findCoordinationHold(
  projectId: string,
  sources: CoordinationHoldSources
): CoordinationHold | null {
  // Resolved lazily, once per source, so an unattributable record outranks
  // nothing: a later source may still name this project.
  let unattributed = false;
  const owns = (terminalId: string): boolean => {
    const owner = sources.projectOfTerminal(terminalId);
    if (owner === null) {
      unattributed = true;
      return false;
    }
    return owner === projectId;
  };

  if (sources.hasUnsettledScheduledRun(projectId)) return "scheduled-run";
  if (sources.waitingRunProjectIds().includes(projectId)) return "waiting-run";
  if (sources.unseenHandBackRunIds().some(owns)) return "unseen-hand-back";
  if (sources.gatedParks().some((park) => owns(park.runId) || owns(park.gateRunId))) {
    return "gated-park";
  }
  for (const terminalId of sources.replyWaitTerminalIds()) {
    if (terminalId === undefined) {
      unattributed = true;
    } else if (owns(terminalId)) {
      return "pending-reply-wait";
    }
  }
  if (sources.notifyProjectIds().includes(projectId)) return "queued-notify";
  return unattributed ? "unattributed" : null;
}
