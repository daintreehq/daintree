import { useEffect, useRef, useState } from "react";
import { updateFaviconBadge, clearFaviconBadge } from "@/services/FaviconBadgeService";
import { useTerminalNotificationPanelIds } from "@/hooks/useTerminalSelectors";

const DEBOUNCE_MS = 300;
const FOCUS_BLUR_DEBOUNCE_MS = 150;

/** One report's panes, in order, as a comparable key; panel ids never hold a NUL. */
function panesKey(panelIds: readonly string[]): string {
  return panelIds.join("\0");
}

export function useWindowNotifications(): void {
  // The panes last reported, so a swap at the same count (one pane stops
  // waiting as another starts) still reaches main, which counts each pane
  // once with any Decisions question waiting in it (#17233).
  const prevWaitingKeyRef = useRef("");
  const windowFocusedRef = useRef(true);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const blurDimTimerRef = useRef<NodeJS.Timeout | null>(null);
  // Last badge state handed to Main and drawn in the favicon. Focus used to
  // re-send both unconditionally; with no waiting agents that is an IPC and a
  // favicon href rewrite per focus for no change.
  const sentBadgeCountRef = useRef<number | null>(null);
  const faviconBadgedRef = useRef(false);
  const [blurTime, setBlurTime] = useState<number | null>(null);

  const waitingPanelIds = useTerminalNotificationPanelIds(blurTime);

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

      prevWaitingKeyRef.current = "";

      if (faviconBadgedRef.current) {
        faviconBadgedRef.current = false;
        clearFaviconBadge();
      }

      if (sentBadgeCountRef.current !== 0 && window.electron?.notification?.updateBadge) {
        sentBadgeCountRef.current = 0;
        window.electron.notification.updateBadge({ waitingPanelIds: [] });
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
    const key = panesKey(waitingPanelIds);
    if (prevWaitingKeyRef.current !== key) {
      prevWaitingKeyRef.current = key;
      const waitingCount = waitingPanelIds.length;

      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }

      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;

        if (window.electron?.notification?.updateBadge) {
          sentBadgeCountRef.current = waitingCount;
          window.electron.notification.updateBadge({ waitingPanelIds });
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
  }, [waitingPanelIds]);

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }

      if (window.electron?.notification?.updateBadge) {
        window.electron.notification.updateBadge({ waitingPanelIds: [] });
      }
      clearFaviconBadge();
    };
  }, []);
}
