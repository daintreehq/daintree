import type {
  DecisionQuestionInbox,
  DecisionQuestionStanding,
} from "../types/decisionsQuestion.js";
import { deadlineElapsed } from "./decisionDeadline.js";

/**
 * Whether a question waits on the person: the one rule behind the toolbar
 * badge and its overflow, the window title and the Dock badge (#18046).
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
