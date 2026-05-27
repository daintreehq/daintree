import { useEffect } from "react";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Long-running renderers can sit open for days. Age-based eviction at hydrate
 * time only catches entries that aged out while the app was closed — a separate
 * tick keeps the live store from accumulating stale entries during long
 * sessions. Runs once on mount and then hourly; both calls are no-ops when
 * nothing has expired, so the persist write only fires when entries actually
 * drop off.
 */
export function useNotificationHistoryPruning(): void {
  useEffect(() => {
    useNotificationHistoryStore.getState().pruneExpiredEntries();
    const id = setInterval(() => {
      useNotificationHistoryStore.getState().pruneExpiredEntries();
    }, PRUNE_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);
}
