import { pluralize } from "@/lib/pluralize";
import type { DecisionQuestionStanding } from "@shared/types/decisionsQuestion";
import {
  asksByDeadline,
  deadlineElapsed,
  deadlineMs,
  nextAskDeadline,
} from "@shared/utils/decisionDeadline";

/**
 * A question's deadline as this computer's clock reads it (#17943). The clock
 * only ever says the deadline passed: whether the question closed, and how,
 * is the store's to say once the relay confirms it.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How close a deadline has to be before a waiting row names it. */
export const EXPIRY_SOON_MS = DAY;

export { asksByDeadline, deadlineElapsed, deadlineMs, nextAskDeadline };

/** As `deadlineElapsed`, for a question read in full, by its status. */
export function contentDeadlineElapsed(
  question: { expiresAt: string | null; status: string },
  nowMs: number
): boolean {
  if (question.status !== "open" && question.status !== "queued") return false;
  const at = deadlineMs(question.expiresAt);
  return at !== null && at <= nowMs;
}

/** Whether a question still asking closes soon enough for its row to say so. */
export function expiresSoon(
  item: { expiresAt: string | null; standing: DecisionQuestionStanding },
  nowMs: number
): boolean {
  const at = deadlineMs(item.expiresAt);
  return at !== null && asksByDeadline(item.standing) && at > nowMs && at - nowMs <= EXPIRY_SOON_MS;
}

/** "8 minutes left", in the largest whole unit; the last minute is "Less than a minute left". */
export function remainingText(deadline: number, nowMs: number): string {
  const left = deadline - nowMs;
  if (left < MINUTE) return "Less than a minute left";
  if (left < HOUR) return `${pluralize(Math.floor(left / MINUTE), "minute")} left`;
  if (left < DAY) return `${pluralize(Math.floor(left / HOUR), "hour")} left`;
  return `${pluralize(Math.floor(left / DAY), "day")} left`;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * The deadline in this computer's local time: the time alone today, with the
 * weekday within the week ahead, with the date beyond that.
 */
export function clockText(deadline: number, nowMs: number): string {
  const at = new Date(deadline);
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (sameDay(at, new Date(nowMs))) return time;
  const day =
    Math.abs(deadline - nowMs) < 6 * DAY
      ? at.toLocaleDateString(undefined, { weekday: "short" })
      : at.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return `${day} ${time}`;
}

/** "Reply by 14:15", the deadline in local time. */
export function replyByText(deadline: number, nowMs: number): string {
  return `Reply by ${clockText(deadline, nowMs)}`;
}

/**
 * How long until what any of `deadlines` shows next changes: its remaining
 * time ticking to the next whole unit, its row coming within a day, or the
 * deadline passing. Null when none is still ahead, so nothing is scheduled.
 */
export function nextDeadlineChange(deadlines: readonly number[], nowMs: number): number | null {
  let next: number | null = null;
  const consider = (delay: number) => {
    if (delay > 0 && (next === null || delay < next)) next = delay;
  };
  for (const deadline of deadlines) {
    const left = deadline - nowMs;
    if (left <= 0) continue;
    consider(left);
    if (left > EXPIRY_SOON_MS) consider(left - EXPIRY_SOON_MS);
    const unit = left < HOUR ? MINUTE : left < DAY ? HOUR : DAY;
    // Just past the boundary: at it exactly, the whole units left are still the same.
    consider((left % unit || unit) + 1);
  }
  return next;
}
