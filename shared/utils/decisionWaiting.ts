import type {
  DecisionQuestionInbox,
  DecisionQuestionStanding,
} from "../types/decisionsQuestion.js";
import { deadlineElapsed } from "./decisionDeadline.js";

/**
 * Whether a question needs the person: the rules behind the toolbar button
 * and its overflow, the window title and the Dock badge (#18046, #18045).
 */

/**
 * A question the person can still answer: open, a reply its agent asked for, or
 * queued to send. The inbox's Needs you group is this standing.
 */
export function awaitsPerson(standing: DecisionQuestionStanding): boolean {
  return standing.kind === "waiting" || standing.kind === "queued";
}

/**
 * It waits on the person while it can be answered and they haven't seen or
 * cleared what it asks now (#17895), and, given the time, its deadline hasn't
 * passed by this computer's clock (#17943), which would leave it unanswerable.
 */
export function isWaitingOnPerson(
  item: {
    standing: DecisionQuestionStanding;
    inbox?: DecisionQuestionInbox;
    expiresAt?: string | null;
  },
  nowMs: number | null = null
): boolean {
  return (
    awaitsPerson(item.standing) &&
    item.inbox?.seen !== true &&
    item.inbox?.cleared !== true &&
    (nowMs === null ||
      !deadlineElapsed({ expiresAt: item.expiresAt ?? null, standing: item.standing }, nowMs))
  );
}

/**
 * An answer or a person's follow-up that delivery stopped on, typed in or
 * not, which only the person can decide what to do with (#18045): the inbox's
 * Needs attention group. It stays until they do, whatever the clock says.
 */
export function deliveryNeedsPerson(standing: DecisionQuestionStanding): boolean {
  return standing.kind === "needs-attention";
}

/**
 * Whether anything about the question needs the person: one to answer, or a
 * delivery stopped. The window title and Dock badge light by it, so they never
 * say all clear while the toolbar marks either.
 */
export function needsPerson(
  item: Parameters<typeof isWaitingOnPerson>[0],
  nowMs: number | null = null
): boolean {
  return isWaitingOnPerson(item, nowMs) || deliveryNeedsPerson(item.standing);
}
