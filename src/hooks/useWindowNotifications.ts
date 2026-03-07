import { useEffect, useRef, useState } from "react";
import { updateFaviconBadge, clearFaviconBadge } from "@/services/FaviconBadgeService";
import { useTerminalNotificationCounts } from "@/hooks/useTerminalSelectors";

const DEBOUNCE_MS = 300;

export function useWindowNotifications(): void {
  const prevStateRef = useRef({ waitingCount: 0, failedCount: 0 });
  const windowFocusedRef = useRef(true);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const blurTimeRef = useRef<number | null>(null);
  const [, setTick] = useState(0);

  const { waitingCount, failedCount } = useTerminalNotificationCounts(blurTimeRef.current);

  useEffect(() => {
    const handleFocus = () => {
      windowFocusedRef.current = true;
      blurTimeRef.current = null;

      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }

      prevStateRef.current = { waitingCount: 0, failedCount: 0 };

      clearFaviconBadge();

      if (window.electron?.notification?.updateBadge) {
        window.electron.notification.updateBadge({ waitingCount: 0, failedCount: 0 });
      }

      setTick((t) => t + 1);
    };

    const handleBlur = () => {
      windowFocusedRef.current = false;
      blurTimeRef.current = Date.now();
      setTick((t) => t + 1);
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

    if (prevState.waitingCount !== waitingCount || prevState.failedCount !== failedCount) {
      prevStateRef.current = { waitingCount, failedCount };

      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }

      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;

        if (window.electron?.notification?.updateBadge) {
          window.electron.notification.updateBadge({ waitingCount, failedCount });
        }

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

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }

      if (window.electron?.notification?.updateBadge) {
        window.electron.notification.updateBadge({ waitingCount: 0, failedCount: 0 });
      }
      clearFaviconBadge();
    };
  }, []);
}
