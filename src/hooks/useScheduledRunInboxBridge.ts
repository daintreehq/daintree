import { useEffect } from "react";
import { isRemoteWindow } from "@/hooks/useHostPlatform";
import {
  flushNotificationHistory,
  useNotificationHistoryStore,
} from "@/store/slices/notificationHistorySlice";
import { scheduledRunInboxEntry } from "@/components/Schedules/scheduledRunInboxEntry";
import type { NotificationHistoryEntry } from "@/store/slices/notificationHistorySlice";
import { logWarn } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";

/**
 * Puts the scheduled runs that settled while no window was open in the
 * notification inbox (#15983), once this view's state has loaded. Main holds
 * each until a view says it's written: the entries go to storage first, so a
 * view that dies between the two leaves the runs for the next one, and one
 * that writes a run twice still holds one entry, keyed by the run.
 */
export function useScheduledRunInboxBridge(isStateLoaded: boolean): void {
  useEffect(() => {
    if (!isStateLoaded || isRemoteWindow()) return;
    const api = window.electron?.scheduledRuns;
    if (!api?.takeInbox || !api.ackInbox) return;
    let cancelled = false;
    void (async () => {
      try {
        const items = await api.takeInbox();
        if (cancelled || items.length === 0) return;
        const now = Date.now();
        const entries = items
          .map((item) => scheduledRunInboxEntry(item, now))
          .filter((entry): entry is NotificationHistoryEntry => entry !== null);
        useNotificationHistoryStore.getState().importEntries(entries);
        flushNotificationHistory();
        await api.ackInbox({ runIds: items.map((item) => item.run.id) });
      } catch (error) {
        logWarn("Couldn't put scheduled runs in the inbox", {
          error: formatErrorMessage(error, "unknown"),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isStateLoaded]);
}
