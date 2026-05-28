import { useEffect, useState } from "react";

// Browsers clamp `setTimeout` to a signed 32-bit max (~24.8 days). A snooze
// scheduled past this would fire the timer early, the no-op sweep returns,
// and no further timer is scheduled — the snooze would never visibly
// expire. Capping at this max and re-arming on each fire lets the timer
// chain across the boundary while still cooperating with React 19
// StrictMode cleanup.
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Schedules a single `setTimeout` for the nearest snooze expiry. When it
 * fires, calls `clearExpiredSnoozes(now)` so the store drops every expired
 * key in one write and any rows it was hiding reappear in the All/Unread
 * tabs. Re-arms whenever `snoozedThreads` changes (new snooze added, one
 * cleared early) and after each clamped fire for snoozes scheduled past
 * the browser timer cap. Skips entirely when nothing is snoozed.
 *
 * Cleanup returns `clearTimeout` so React 19 StrictMode's double-mount in
 * dev does not leave a dangling timer that double-fires.
 */
export function useSnoozeExpiryTimer(
  snoozedThreads: Record<string, number>,
  clearExpiredSnoozes: (now: number) => void
): void {
  // Counter that increments after each clamped fire to re-trigger the
  // effect — `snoozedThreads` is unchanged when the sweep was a no-op, so
  // we need an explicit re-arm trigger.
  const [armTick, setArmTick] = useState(0);
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
    const delay = Math.min(nextExpiry - now, MAX_TIMEOUT_MS);
    let disposed = false;
    const id = setTimeout(() => {
      if (disposed) return;
      clearExpiredSnoozes(Date.now());
      // The sweep may have been a no-op when `delay` was clamped below the
      // real expiry — bump the arm tick so the effect re-runs and schedules
      // the next chunk of the wait.
      setArmTick((n) => n + 1);
    }, delay);
    return () => {
      disposed = true;
      clearTimeout(id);
    };
    // armTick is read inside setArmTick (functional update), so React's
    // exhaustive-deps lint flags it as a dependency — including it gives
    // the re-arm behavior we want.
  }, [snoozedThreads, clearExpiredSnoozes, armTick]);
}
