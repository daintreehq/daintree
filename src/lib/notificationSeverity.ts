import type { NotificationType } from "@/store/notificationStore";
import type { NotificationHistoryEntry } from "@/store/slices/notificationHistorySlice";

/**
 * Ordinal weights for notification severity, used to compare which type is
 * "worse" within a thread. Higher is more severe. Shared across the dispatch
 * path (`notify.ts`), the notification center grouping, and the re-entry
 * summary so the ordering stays consistent.
 */
export const SEVERITY_WEIGHTS: Record<NotificationType, number> = {
  error: 3,
  warning: 2,
  info: 1,
  success: 0,
} as const;

/**
 * Returns the most severe `type` across a set of history entries. Empty input
 * resolves to `"success"` (the least severe), so callers can treat an absent
 * thread as a clean baseline. Ties keep the earliest entry, matching the
 * reduce semantics the notification center relied on previously.
 */
export function getWorstSeverity(entries: NotificationHistoryEntry[]): NotificationType {
  if (entries.length === 0) return "success";
  return entries.reduce((highest, current) =>
    SEVERITY_WEIGHTS[current.type] > SEVERITY_WEIGHTS[highest.type] ? current : highest
  ).type;
}

/**
 * Thread re-promotion predicate. Given an incoming notification's severity, its
 * `urgent` flag, and the existing history entries that share its
 * `correlationId`, decides whether the notification warrants re-toasting a
 * thread that would otherwise update its inbox row silently.
 *
 * Re-toast when any of:
 *  1. The payload is `urgent` (explicit critical override).
 *  2. The incoming severity strictly exceeds the thread's worst *active*
 *     severity (escalation — e.g. an `info` thread that just turned `error`).
 *  3. Every existing entry in the thread is archived (un-snooze — the user had
 *     dismissed the thread and it has new activity).
 *
 * The escalation check considers only non-archived (active) entries: an old
 * archived `error` must not permanently block a re-dismissed thread from
 * escalating again. This mirrors how the notification center computes a
 * thread's worst severity over its visible (non-archived) entries.
 *
 * For escalation and un-snooze, this predicate layers on top of the existing
 * rate-limit token bucket — returning `true` admits the notification to the
 * toast gate, it does not bypass rate limiting. (`urgent` follows the dispatch
 * path's existing rate-limit exemption, consistent with urgent everywhere.)
 *
 * A thread with no existing entries returns `false`: there is nothing to
 * re-promote, so the standard toast gate applies unchanged.
 */
export function shouldReToast(
  payloadType: NotificationType,
  threadEntries: NotificationHistoryEntry[],
  urgent = false
): boolean {
  if (threadEntries.length === 0) return false;

  if (urgent) return true;

  const activeEntries = threadEntries.filter((e) => e.archivedAt === null);
  const isEscalation =
    SEVERITY_WEIGHTS[payloadType] > SEVERITY_WEIGHTS[getWorstSeverity(activeEntries)];
  if (isEscalation) return true;

  // A partially-archived thread is still active and visible, so only re-toast
  // when the whole thread had been archived (the un-snooze case).
  return activeEntries.length === 0;
}
