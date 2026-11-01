import { useEffect } from "react";
import { isRemoteWindow } from "@/hooks/useHostPlatform";
import { useProjectStore } from "@/store/projectStore";
import {
  flushNotificationHistory,
  notificationHistoryIdsInStorage,
  useNotificationHistoryStore,
} from "@/store/slices/notificationHistorySlice";
import type { NotificationHistoryEntry } from "@/store/slices/notificationHistorySlice";
import {
  scheduledRunInboxEntry,
  scheduledRunInboxEntryId,
} from "@/components/Schedules/scheduledRunInboxEntry";
import { logWarn } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";

/** Past the moment another view's hold lapses, so asking again finds it lapsed. */
const RETRY_SLACK_MS = 1_000;

/**
 * Puts the scheduled runs that settled while no window was open in the
 * notification inbox (#15983), in a project view on this machine once its
 * state has loaded, and again whenever it's shown. Main hands them only to a
 * view on screen and holds each until the view says it's filed: the entries
 * are written to storage and read back first, so a run that didn't reach it
 * (a full or failed storage, the inbox's entry cap) waits in main for another
 * try, and one filed twice is still one entry, keyed by the run. A project
 * view, because the entry's "View history" opens a project's schedules.
 */
export function useScheduledRunInboxBridge(isStateLoaded: boolean): void {
  const projectId = useProjectStore((state) => state.currentProject?.id ?? null);

  useEffect(() => {
    if (!isStateLoaded || !projectId || isRemoteWindow()) return;
    const api = window.electron?.scheduledRuns;
    if (!api?.takeInbox || !api.ackInbox) return;
    let disposed = false;
    // Parked out of sight: runs that arrive now would be filed where nobody
    // looks, so they're left with main, which hands them to the view shown.
    let cached = false;
    let asking = false;
    let askAgain = false;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const fileOnce = async (): Promise<void> => {
      const { items, retryInMs } = await api.takeInbox();
      if (disposed || cached) return;
      if (retryInMs !== null) {
        if (retry) clearTimeout(retry);
        retry = setTimeout(() => {
          retry = null;
          void ask();
        }, retryInMs + RETRY_SLACK_MS);
      }
      if (items.length === 0) return;
      const now = Date.now();
      const built = items.map((item) => ({
        runId: item.run.id,
        entry: scheduledRunInboxEntry(item, now),
      }));
      useNotificationHistoryStore
        .getState()
        .importEntries(
          built
            .map(({ entry }) => entry)
            .filter((entry): entry is NotificationHistoryEntry => entry !== null)
        );
      flushNotificationHistory();
      const stored = notificationHistoryIdsInStorage();
      // A run with nothing to file (it never settled) has nothing to wait for.
      const runIds = built
        .filter(({ runId, entry }) => entry === null || stored.has(scheduledRunInboxEntryId(runId)))
        .map(({ runId }) => runId);
      if (runIds.length > 0) await api.ackInbox({ runIds });
    };

    // One ask at a time; one asked for meanwhile runs once the current one ends.
    const ask = async (): Promise<void> => {
      if (asking) {
        askAgain = true;
        return;
      }
      asking = true;
      try {
        do {
          askAgain = false;
          try {
            await fileOnce();
          } catch (error) {
            logWarn("Couldn't put scheduled runs in the inbox", {
              error: formatErrorMessage(error, "unknown"),
            });
          }
        } while (askAgain && !disposed);
      } finally {
        asking = false;
      }
    };

    void ask();
    // A cached view shown again: it may be the only view on screen to file them.
    const offRevealed = window.electron?.app?.onViewRevealed?.(() => {
      cached = false;
      void ask();
    });
    const offCached = window.electron?.app?.onViewCached?.(() => {
      cached = true;
    });
    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      offRevealed?.();
      offCached?.();
    };
  }, [isStateLoaded, projectId]);
}
