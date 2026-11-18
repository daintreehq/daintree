import { useEffect, useRef, useState } from "react";
import { updateFaviconBadge, clearFaviconBadge } from "@/services/FaviconBadgeService";
import { useTerminalNotificationPanelIds } from "@/hooks/useTerminalSelectors";

const DEBOUNCE_MS = 300;
const FOCUS_BLUR_DEBOUNCE_MS = 150;

function samePanes(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((panelId, index) => panelId === b[index]);
}

const NO_PANES: readonly string[] = [];

export function useWindowNotifications(): void {
  // The panes last seen, so a swap at the same count (one pane stops waiting
  // as another starts) still reaches main, which counts each pane once with
  // any Decisions question waiting in it (#17233). The pending send reads it.
  const prevWaitingRef = useRef<readonly string[]>(NO_PANES);
  // Whether the count moved while the pending send waited. A send whose count
  // didn't is marked membership-only, so main runs every pass it ran when only
  // counts were sent, and the swap's own only while a question waits.
  const countMovedRef = useRef(false);
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

      prevWaitingRef.current = NO_PANES;
      countMovedRef.current = false;

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
    const previous = prevWaitingRef.current;
    if (!samePanes(previous, waitingPanelIds)) {
      prevWaitingRef.current = waitingPanelIds;
      const countMoved = previous.length !== waitingPanelIds.length;

      // A swap at the same count rides on a send already pending rather than
      // postponing it, so panes trading places can't hold a steady count back.
      if (!countMoved && debounceTimerRef.current) return;
      if (countMoved) countMovedRef.current = true;

      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }

      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        const panes = prevWaitingRef.current;
        const membershipOnly = !countMovedRef.current;
        countMovedRef.current = false;
        const waitingCount = panes.length;

        if (window.electron?.notification?.updateBadge) {
          if (membershipOnly) {
            window.electron.notification.updateBadge({
              waitingPanelIds: [...panes],
              membershipOnly,
            });
          } else {
            sentBadgeCountRef.current = waitingCount;
            window.electron.notification.updateBadge({ waitingPanelIds: [...panes] });
          }
        }
        // The count, and so the favicon, stayed where it was.
        if (membershipOnly) return;

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
