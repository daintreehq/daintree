import { useEffect } from "react";

/**
 * Schedules a single `setTimeout` for the nearest snooze expiry. When it
 * fires, calls `clearExpiredSnoozes(now)` so the store drops every expired
 * key in one write and any rows it was hiding reappear in the All/Unread
 * tabs. Re-arms whenever `snoozedThreads` changes (new snooze added, one
 * cleared early). Skips entirely when nothing is snoozed.
 *
 * Cleanup returns `clearTimeout` so React 19 StrictMode's double-mount in
 * dev does not leave a dangling timer that double-fires.
 */
export function useSnoozeExpiryTimer(
  snoozedThreads: Record<string, number>,
  clearExpiredSnoozes: (now: number) => void
): void {
  useEffect(() => {
    let nextExpiry = Infinity;
    for (const value of Object.values(snoozedThreads)) {
      if (typeof value === "number" && Number.isFinite(value) && value < nextExpiry) {
        nextExpiry = value;
      }
    }
    if (!Number.isFinite(nextExpiry)) return;
    const now = Date.now();
    if (nextExpiry <= now) {
      // Past-due expiry on mount — flush immediately rather than schedule a
      // 0ms timer. setTimeout(0) would still defer past this render cycle.
      clearExpiredSnoozes(now);
      return;
    }
    const delay = nextExpiry - now;
    let disposed = false;
    const id = setTimeout(() => {
      if (disposed) return;
      clearExpiredSnoozes(Date.now());
    }, delay);
    return () => {
      disposed = true;
      clearTimeout(id);
    };
  }, [snoozedThreads, clearExpiredSnoozes]);
}
