import type { AgentState, WaitingReason } from "../types/agent.js";
import type { RunHandBackRecord, RunWaitRecord } from "../types/ipc/fleet.js";

/**
 * How long a stint of work must be watched before its stop is a hand-back: a
 * start gone again in under this is output flickering the observed state. The
 * same bar Canopy holds a turn to.
 */
export const HAND_BACK_MIN_WORK_MS = 3_000;

/**
 * How long a terminal must stay in front of the user after its stop before the
 * hand-back counts as seen: switching through panes reads nothing on the way.
 */
export const HAND_BACK_SEEN_DWELL_MS = 1_500;

/**
 * A look not told again for this long has ended: a view re-reports each look it
 * keeps once a minute, and a lost report must never leave a run seen for good.
 */
export const HAND_BACK_LOOK_LEASE_MS = 150_000;

/** The user has not seen the stop, or marked it unread again. */
export function isHandBackUnseen(record: RunHandBackRecord | undefined): boolean {
  if (record === undefined) return false;
  return record.markedUnreadAt !== undefined || record.seenAt === undefined;
}

/**
 * A stop that hands work back: finished, or sitting at a prompt for no more
 * specific reason. An approval, question or error wait asks something of the
 * user, and looking at it answers nothing.
 */
export function isHandBackStop(state: AgentState, waitingReason?: WaitingReason): boolean {
  if (state === "completed") return true;
  return state === "waiting" && (waitingReason === undefined || waitingReason === "prompt");
}

/**
 * A wait the patterns filed as asking the user something: an approval or a
 * question. A guess at what the screen shows, so on its own it is news, never
 * a demand.
 */
export function isObservedAskWait(state: AgentState, waitingReason?: WaitingReason): boolean {
  return state === "waiting" && (waitingReason === "approval" || waitingReason === "question");
}

/**
 * The user has not had the wait in front of them since it began. No record is
 * unseen: a wait nobody here watched start is still news to whoever looks.
 */
export function isWaitUnseen(record: RunWaitRecord | undefined): boolean {
  return record?.seenAt === undefined;
}
