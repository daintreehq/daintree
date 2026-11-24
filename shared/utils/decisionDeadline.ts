import type { DecisionQuestionStanding } from "../types/decisionsQuestion.js";

/**
 * A Decisions question's deadline as this computer's clock reads it (#17943).
 * The clock only ever says the deadline passed: whether the question closed,
 * and how, is its store's to say once the relay confirms it.
 */

/** The deadline as epoch ms; null for one that never comes, or can't be read. */
export function deadlineMs(expiresAt: string | null | undefined): number | null {
  if (expiresAt == null) return null;
  const at = Date.parse(expiresAt);
  return Number.isNaN(at) ? null : at;
}

/**
 * Whether the question's own deadline is what it waits on: open for an answer,
 * or queued to send. A reply its agent asked for after an answer isn't bound by it.
 */
export function asksByDeadline(standing: DecisionQuestionStanding): boolean {
  return standing.kind === "queued" || (standing.kind === "waiting" && standing.reason === "open");
}

/**
 * Its deadline passed by this computer's clock while its store still has it
 * asking: nothing has confirmed it closed, nor how, so it no longer waits on
 * the person and waits on an update instead.
 */
export function deadlineElapsed(
  item: { expiresAt: string | null; standing: DecisionQuestionStanding },
  nowMs: number
): boolean {
  const at = deadlineMs(item.expiresAt);
  return at !== null && asksByDeadline(item.standing) && at <= nowMs;
}

/** The soonest deadline still ahead of `nowMs` among questions it would take out of asking. */
export function nextAskDeadline(
  items: readonly { expiresAt: string | null; standing: DecisionQuestionStanding }[],
  nowMs: number
): number | null {
  let next: number | null = null;
  for (const item of items) {
    if (!asksByDeadline(item.standing)) continue;
    const at = deadlineMs(item.expiresAt);
    if (at !== null && at > nowMs && (next === null || at < next)) next = at;
  }
  return next;
}
