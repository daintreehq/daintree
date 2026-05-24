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
 * Thread re-promotion predicate. Given an incoming notification's severity and
 * the existing history entries that share its `correlationId`, decides whether
 * the notification warrants re-toasting a thread that would otherwise update
 * its inbox row silently.
 *
 * Re-toast when either:
 *  1. The incoming severity strictly exceeds the thread's current worst
 *     severity (escalation — e.g. an `info` thread that just turned `error`).
 *  2. Every existing entry in the thread is archived (un-snooze — the user had
 *     dismissed the thread and it has new activity).
 *
 * `urgent` payloads are handled by the dispatch path's own urgent bypass and
 * are intentionally not special-cased here. This predicate layers on top of
 * the existing rate-limit token bucket — returning `true` admits the
 * notification to the toast gate, it does not bypass rate limiting.
 *
 * A thread with no existing entries returns `false`: there is nothing to
 * re-promote, so the standard toast gate applies unchanged.
 */
export function shouldReToast(
  payloadType: NotificationType,
  threadEntries: NotificationHistoryEntry[]
): boolean {
  if (threadEntries.length === 0) return false;

  const isEscalation =
    SEVERITY_WEIGHTS[payloadType] > SEVERITY_WEIGHTS[getWorstSeverity(threadEntries)];
  if (isEscalation) return true;

  // A partially-archived thread is still active and visible, so only re-toast
  // when the whole thread had been archived (the un-snooze case).
  const allArchived = threadEntries.every((e) => e.archivedAt !== null);
  return allArchived;
}
