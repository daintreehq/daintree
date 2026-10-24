import { useCallback, useMemo } from "react";
import {
  useNotificationHistoryStore,
  type NotificationHistoryEntry,
} from "@/store/slices/notificationHistorySlice";
import { useUIStore } from "@/store/uiStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { actionService } from "@/services/ActionService";
import type { ActionId } from "@shared/types/actions";
import { notify } from "@/lib/notify";
import { UNDO_TOAST_DURATION_MS } from "@/lib/undoToast";
import { resolveSnoozeDuration, type SnoozeDurationOption } from "@shared/utils/snoozeTimestamps";
import { formatSnoozeWake } from "./NotificationCenterEntry";
import { groupByCorrelationId, type FlatRow } from "./notificationTriageModel";

/**
 * Says what a row action did. Archive, restore and snooze take the row out of
 * the tab, and a read toggle changes nothing a screen reader is reading, so
 * without this the outcome was silent everywhere but the pixels.
 */
export function announceTriage(message: string): void {
  useAnnouncerStore.getState().announce(message, "polite");
}

/**
 * The row-level triage writes: read-with-undo, archive and restore, the read
 * toggle, snooze, and the primary action. Each one re-reads what it needs from
 * the store at the moment it runs, so a keystroke on a stale row never acts on
 * entries that have already moved on.
 */
export function useNotificationRowActions(entries: NotificationHistoryEntry[]) {
  const markIdsRead = useNotificationHistoryStore((s) => s.markIdsRead);
  const markUnseenAsToast = useNotificationHistoryStore((s) => s.markUnseenAsToast);
  const archiveEntry = useNotificationHistoryStore((s) => s.archiveEntry);
  const archiveByCorrelationId = useNotificationHistoryStore((s) => s.archiveByCorrelationId);
  const unarchiveEntry = useNotificationHistoryStore((s) => s.unarchiveEntry);
  const unarchiveByCorrelationId = useNotificationHistoryStore((s) => s.unarchiveByCorrelationId);
  const snoozeThread = useNotificationHistoryStore((s) => s.snoozeThread);
  const clearSnooze = useNotificationHistoryStore((s) => s.clearSnooze);
  const resetLastClosedAt = useUIStore((s) => s.resetNotificationCenterLastClosedAt);

  const markIdsReadWithUndo = (requestedIds: string[], options: { resetLastClosed: boolean }) => {
    if (requestedIds.length === 0) return;
    // Re-filter against live store state so a rapid second click on a stale
    // closure doesn't fire a ghost toast for entries already marked read.
    const liveEntries = useNotificationHistoryStore.getState().entries;
    const liveById = new Map(liveEntries.map((e) => [e.id, e] as const));
    const ids = requestedIds.filter((id) => {
      const entry = liveById.get(id);
      return entry !== undefined && !entry.seenAsToast;
    });
    if (ids.length === 0) return;
    markIdsRead(ids);
    const prevLastClosedAt = options.resetLastClosed
      ? useUIStore.getState().lastNotificationCenterClosedAt
      : undefined;
    if (options.resetLastClosed) {
      resetLastClosedAt();
    }
    // eslint-disable-next-line no-restricted-syntax -- transient confirmations omit context
    notify({
      type: "success",
      message: `Marked ${ids.length} as read`,
      // WCAG 2.2.1: the 5 s auto-dismiss is permitted under the "available
      // elsewhere without a time limit" exception — the notification history
      // inbox is always accessible as the recovery surface, and Undo provides
      // a reversal mechanism within the time limit.
      duration: UNDO_TOAST_DURATION_MS,
      priority: "high",
      // Time-bound undo — surface even during quiet hours so the user has a
      // recovery path.
      urgent: true,
      // Confirmation toast only — no inbox entry. (Don't pair with `context`:
      // notify warns and silently drops in DEV.)
      transient: true,
      action: {
        label: "Undo",
        onClick: () => {
          for (const id of ids) {
            markUnseenAsToast(id, { silent: true });
          }
          if (prevLastClosedAt !== undefined) {
            useUIStore.setState({ lastNotificationCenterClosedAt: prevLastClosedAt });
          }
        },
      },
    });
  };

  const dispatchPrimaryAction = useCallback((row: FlatRow) => {
    const action = row.primaryAction;
    if (!action) return;
    const manifest = actionService.get(action.actionId as ActionId);
    if (!manifest || !manifest.enabled) return;
    void actionService.dispatch(action.actionId as ActionId, action.actionArgs);
  }, []);

  const archiveRow = useCallback(
    (row: FlatRow) => {
      if (row.isThread && row.correlationId) {
        archiveByCorrelationId(row.correlationId);
      } else {
        archiveEntry(row.entryId);
      }
      announceTriage(row.isThread ? "Thread archived" : "Notification archived");
    },
    [archiveByCorrelationId, archiveEntry]
  );

  const restoreRow = useCallback(
    (row: FlatRow) => {
      if (row.isThread && row.correlationId) {
        unarchiveByCorrelationId(row.correlationId);
      } else {
        unarchiveEntry(row.entryId);
      }
      announceTriage("Moved to inbox");
    },
    [unarchiveByCorrelationId, unarchiveEntry]
  );

  // Build a fast index of unread entry IDs grouped by row, so the `u` toggle
  // can flip read/unread for the focused row in one store call. Without this
  // memo each keystroke would walk every entry looking for matches.
  const flatRowEntryIds = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const group of groupByCorrelationId(entries)) {
      const key = group.correlationId ?? group.entries[0]!.id;
      map.set(
        key,
        group.entries.filter((e) => !e.archivedAt).map((e) => e.id)
      );
    }
    return map;
  }, [entries]);

  const toggleReadForRow = useCallback(
    (row: FlatRow) => {
      const ids = flatRowEntryIds.get(row.key) ?? [row.entryId];
      const live = useNotificationHistoryStore.getState().entries;
      const liveById = new Map(live.map((e) => [e.id, e] as const));
      const unreadIds = ids.filter((id) => {
        const e = liveById.get(id);
        return e !== undefined && !e.seenAsToast;
      });
      if (unreadIds.length > 0) {
        markIdsRead(unreadIds);
        announceTriage("Marked as read");
      } else {
        // Whole row already read — flip the head entry back to unread so the
        // dot reappears. Skip when the head entry no longer exists (a
        // dismissal or prune raced the keystroke).
        const head = liveById.get(row.entryId);
        if (head && head.seenAsToast && !head.archivedAt) {
          markUnseenAsToast(row.entryId, { silent: true });
          announceTriage("Marked as unread");
        }
      }
    },
    [flatRowEntryIds, markIdsRead, markUnseenAsToast]
  );

  const handleSnoozeForRow = useCallback(
    (row: FlatRow, option: SnoozeDurationOption) => {
      if (!row.correlationId) return;
      const until = resolveSnoozeDuration(option);
      snoozeThread(row.correlationId, until);
      announceTriage(`Snoozed until ${formatSnoozeWake(until)}`);
    },
    [snoozeThread]
  );

  const handleUnsnoozeForRow = useCallback(
    (row: FlatRow) => {
      if (!row.correlationId) return;
      clearSnooze(row.correlationId);
      announceTriage("Snooze cleared");
    },
    [clearSnooze]
  );

  return {
    markIdsReadWithUndo,
    dispatchPrimaryAction,
    archiveRow,
    restoreRow,
    toggleReadForRow,
    handleSnoozeForRow,
    handleUnsnoozeForRow,
  };
}
