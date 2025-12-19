import { useEffect, useRef } from "react";
import { updateFaviconBadge, clearFaviconBadge } from "@/services/FaviconBadgeService";
import { useTerminalNotificationCounts } from "@/hooks/useTerminalSelectors";

const DEBOUNCE_MS = 300;

export function useWindowNotifications(): void {
  const prevStateRef = useRef({ waitingCount: 0, failedCount: 0 });
  const windowFocusedRef = useRef(true);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  const { waitingCount, failedCount } = useTerminalNotificationCounts();

  // Handle window focus/blur for favicon badge clearing
  useEffect(() => {
    const handleFocus = () => {
      windowFocusedRef.current = true;
      clearFaviconBadge();
    };

    const handleBlur = () => {
      windowFocusedRef.current = false;
      // Update badge when window loses focus if there are notifications
      const { waitingCount, failedCount } = prevStateRef.current;
      if (waitingCount > 0 || failedCount > 0) {
        updateFaviconBadge(waitingCount, failedCount);
      }
    };

    window.addEventListener("focus", handleFocus);
    window.addEventListener("blur", handleBlur);

    return () => {
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("blur", handleBlur);
    };
  }, []);

  useEffect(() => {
    const prevState = prevStateRef.current;

    // Only send update if counts have changed
    if (prevState.waitingCount !== waitingCount || prevState.failedCount !== failedCount) {
      prevStateRef.current = { waitingCount, failedCount };

      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }

      // Debounce all updates to match main process debouncing
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;

        // Update Electron main process (window title and macOS dock badge)
        // Guard for browser/test environments
        if (window.electron?.notification?.updateBadge) {
          window.electron.notification.updateBadge({ waitingCount, failedCount });
        }

        // Update favicon badge (only if window is not focused)
        if (!windowFocusedRef.current) {
          if (waitingCount > 0 || failedCount > 0) {
            updateFaviconBadge(waitingCount, failedCount);
          } else {
            clearFaviconBadge();
          }
        }
      }, DEBOUNCE_MS);
    }
  }, [waitingCount, failedCount]);

  // Clear notifications on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }

      // Clear notifications (browser-safe)
      if (window.electron?.notification?.updateBadge) {
        window.electron.notification.updateBadge({ waitingCount: 0, failedCount: 0 });
      }
      clearFaviconBadge();
    };
  }, []);
}
