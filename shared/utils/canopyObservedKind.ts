import type { CanopyCategory } from "../types/ipc/canopy.js";

/**
 * The kind of run Daintree's own state says it is, before or apart from any
 * reading of its screen: the inbox places a run by it until it is read.
 */
export function observedCanopyKind(state: {
  agentState?: string | null;
  waitingReason?: string | null;
}): CanopyCategory {
  switch (state.agentState) {
    case "waiting":
      if (state.waitingReason === "approval") return "approval";
      if (state.waitingReason === "error") return "error";
      return "question";
    case "working":
    case "directing":
      return "working";
    case "completed":
      return "finished";
    default:
      return "idle";
  }
}

function busy(kind: CanopyCategory): boolean {
  return kind === "working" || kind === "running";
}

/** The longest Daintree's state lags a reading and still counts as catching up with it. */
export const CANOPY_CATCH_UP_MS = 15_000;

/**
 * Daintree's state, changed since a reading, has only caught up with what the
 * reading saw: at the read it said busy where the reading saw the agent stopped
 * (or the other way round), it now agrees on that much, and it changed soon
 * after the read. It often sees an agent stop seconds after the screen shows
 * it, and names the stop more loosely than the reading does — a prompt for
 * what the reading knows is an approval — so busy against stopped is what is
 * compared, not the exact kind. A change long after the read is a new episode:
 * the agent may have worked and stopped on another dialog meanwhile.
 */
export function observedCaughtUp(
  category: CanopyCategory,
  then: { agentState?: string | null; waitingReason?: string | null },
  now: { agentState?: string | null; waitingReason?: string | null; since?: number },
  readAt: number
): boolean {
  return (
    now.since !== undefined &&
    now.since >= readAt &&
    now.since - readAt <= CANOPY_CATCH_UP_MS &&
    busy(observedCanopyKind(then)) !== busy(category) &&
    busy(observedCanopyKind(now)) === busy(category)
  );
}
