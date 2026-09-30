import { useEffect, useRef, useState } from "react";
import { updateFaviconBadge, clearFaviconBadge } from "@/services/FaviconBadgeService";
import { useTerminalNotificationCounts } from "@/hooks/useTerminalSelectors";

const DEBOUNCE_MS = 300;
const FOCUS_BLUR_DEBOUNCE_MS = 150;

export function useWindowNotifications(): void {
  const prevWaitingRef = useRef(0);
  const windowFocusedRef = useRef(true);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const blurDimTimerRef = useRef<NodeJS.Timeout | null>(null);
  // Last badge state handed to Main and drawn in the favicon. Focus used to
  // re-send both unconditionally; with no waiting agents that is an IPC and a
  // favicon href rewrite per focus for no change.
  const sentBadgeCountRef = useRef<number | null>(null);
  const faviconBadgedRef = useRef(false);
  const [blurTime, setBlurTime] = useState<number | null>(null);

  const { waitingCount } = useTerminalNotificationCounts(blurTime);

  useEffect(() => {
    const handleFocus = () => {
      windowFocusedRef.current = true;
      setBlurTime(null);

      if (blurDimTimerRef.current) {
        clearTimeout(blurDimTimerRef.current);
        blurDimTimerRef.current = null;
      }
      delete document.body.dataset.windowFocused;

      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }

      prevWaitingRef.current = 0;

      if (faviconBadgedRef.current) {
        faviconBadgedRef.current = false;
        clearFaviconBadge();
      }

      if (sentBadgeCountRef.current !== 0 && window.electron?.notification?.updateBadge) {
        sentBadgeCountRef.current = 0;
        window.electron.notification.updateBadge({ waitingCount: 0 });
      }
    };

    const handleBlur = () => {
      windowFocusedRef.current = false;
      setBlurTime(Date.now());

      if (blurDimTimerRef.current) {
        clearTimeout(blurDimTimerRef.current);
      }
      blurDimTimerRef.current = setTimeout(() => {
        blurDimTimerRef.current = null;
        document.body.dataset.windowFocused = "false";
      }, FOCUS_BLUR_DEBOUNCE_MS);
    };

    window.addEventListener("focus", handleFocus);
    window.addEventListener("blur", handleBlur);

    return () => {
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("blur", handleBlur);
      if (blurDimTimerRef.current) {
        clearTimeout(blurDimTimerRef.current);
        blurDimTimerRef.current = null;
      }
      delete document.body.dataset.windowFocused;
    };
  }, []);

  useEffect(() => {
    if (prevWaitingRef.current !== waitingCount) {
      prevWaitingRef.current = waitingCount;

      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }

      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;

        if (window.electron?.notification?.updateBadge) {
          sentBadgeCountRef.current = waitingCount;
          window.electron.notification.updateBadge({ waitingCount });
        }

        if (!windowFocusedRef.current) {
          if (waitingCount > 0) {
            faviconBadgedRef.current = true;
            updateFaviconBadge(waitingCount);
          } else {
            faviconBadgedRef.current = false;
            clearFaviconBadge();
          }
        }
      }, DEBOUNCE_MS);
    }
  }, [waitingCount]);

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }

      if (window.electron?.notification?.updateBadge) {
        window.electron.notification.updateBadge({ waitingCount: 0 });
      }
      clearFaviconBadge();
    };
  }, []);
}
