import { useEffect } from "react";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";

// setTimeout stores its delay as a signed 32-bit int and fires at once past
// it, so a longer snooze is waited out in capped chunks.
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Wakes snoozed inbox threads when their snooze ends, for the life of the view.
 * The bell and the overflow badge read the stored unread count, which only
 * moves when the expired snooze is cleared, so the timer can't live in
 * Notification Center: its content unmounts when the inbox closes (#17590).
 *
 * Reads the store outside render, so App doesn't re-render on every snooze.
 * Also catches up when the machine wakes or the window comes back, since a
 * timer armed before a sleep can fire late.
 */
export function useNotificationSnoozeExpiry(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    // Schedules only. It runs inside the store's change notification, where
    // a sweep would nest a second store write.
    const arm = () => {
      clearTimeout(timer);
      timer = undefined;
      let nextExpiry = Infinity;
      for (const until of Object.values(useNotificationHistoryStore.getState().snoozedThreads)) {
        if (until < nextExpiry) nextExpiry = until;
      }
      if (!Number.isFinite(nextExpiry)) return;
      const delay = Math.min(Math.max(nextExpiry - Date.now(), 0), MAX_TIMEOUT_MS);
      timer = setTimeout(reconcile, delay);
    };

    // A no-op sweep (an early or capped fire) leaves the store untouched, so
    // re-arming here is what carries the wait on.
    const reconcile = () => {
      useNotificationHistoryStore.getState().clearExpiredSnoozes(Date.now());
      arm();
    };

    const unsubscribe = useNotificationHistoryStore.subscribe((state, prev) => {
      if (state.snoozedThreads !== prev.snoozedThreads) arm();
    });
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") reconcile();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", reconcile);
    const offWake = window.electron?.systemSleep?.onWake?.(reconcile);
    reconcile();

    return () => {
      clearTimeout(timer);
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", reconcile);
      offWake?.();
    };
  }, []);
}
