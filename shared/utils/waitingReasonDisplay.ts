/**
 * Shared presentation vocabulary for `WaitingReason`, used by the terminal
 * header chip, the waiting popover, fleet pane badges, OS notifications, and
 * accessibility announcements — so one agent reads as one signal everywhere.
 *
 * `prompt` is the classifier's fallback (no positive evidence), so it never
 * earns a specific label: every helper here collapses `prompt` and
 * `undefined` to the generic "waiting for input" presentation rather than
 * pretending certainty the classifier doesn't have.
 *
 * Browser-safe: no Node or DOM imports.
 */

import type { WaitingReason } from "../types/agent.js";

/** Reasons backed by positive classifier evidence — safe to label specifically. */
export type ActionableWaitingReason = Exclude<WaitingReason, "prompt">;

export function actionableWaitingReason(
  reason: WaitingReason | undefined
): ActionableWaitingReason | null {
  return reason === "approval" || reason === "question" || reason === "error" ? reason : null;
}

/** Compact chip/badge label. Keyed on the actionable subset only so a call
 * site can't accidentally render a specific-looking badge for the weak
 * `prompt` fallback. */
export const WAITING_REASON_BADGE_LABEL: Record<ActionableWaitingReason, string> = {
  approval: "Approval",
  question: "Question",
  error: "Error",
};

/** Sentence form for notification bodies and screen-reader announcements. */
export function describeWaiting(subject: string, reason: WaitingReason | undefined): string {
  switch (reason) {
    case "approval":
      return `${subject} is waiting for approval`;
    case "question":
      return `${subject} asked a question`;
    case "error":
      return `${subject} is blocked by an error`;
    default:
      return `${subject} is waiting for input`;
  }
}

/**
 * Plural body for grouped notifications. Only used when every agent in the
 * group shares the same classified reason — mixed groups keep the generic
 * "waiting for input" so the copy never overclaims for any member.
 */
export function describeWaitingMany(count: number, reason: WaitingReason | undefined): string {
  const subject = `${count} agents`;
  switch (reason) {
    case "approval":
      return `${subject} waiting for approval`;
    case "question":
      return `${subject} waiting on questions`;
    case "error":
      return `${subject} blocked by errors`;
    default:
      return `${subject} waiting for input`;
  }
}

/** Subject-less headline form (activity headline, tooltips). */
export function waitingHeadline(reason: WaitingReason | undefined): string {
  switch (reason) {
    case "approval":
      return "Waiting for approval";
    case "question":
      return "Asked a question";
    case "error":
      return "Blocked by an error";
    default:
      return "Waiting for input";
  }
}

/**
 * Triage order when several agents wait at once, by leverage per second of
 * user attention: an approval is a one-keystroke unblock; an error means the
 * agent is hard-blocked and silently burning wall-clock; a question needs a
 * considered answer; a bare prompt is the weak default and may just mean
 * "ready for the next instruction".
 */
export function waitingAttentionRank(reason: WaitingReason | undefined): number {
  switch (reason) {
    case "approval":
      return 0;
    case "error":
      return 1;
    case "question":
      return 2;
    default:
      return 3;
  }
}

export interface WaitingAttentionSortKey {
  id: string;
  waitingReason?: WaitingReason;
  lastStateChange?: number;
}

/**
 * Deterministic attention ordering: reason rank, then longest-waiting first
 * (missing timestamps sort last), then id so equal entries never reshuffle
 * between renders.
 */
export function compareWaitingAttention(
  a: WaitingAttentionSortKey,
  b: WaitingAttentionSortKey
): number {
  const rankDelta = waitingAttentionRank(a.waitingReason) - waitingAttentionRank(b.waitingReason);
  if (rankDelta !== 0) return rankDelta;
  const aSince = a.lastStateChange ?? Number.POSITIVE_INFINITY;
  const bSince = b.lastStateChange ?? Number.POSITIVE_INFINITY;
  if (aSince !== bSince) return aSince - bSince;
  return a.id.localeCompare(b.id);
}
