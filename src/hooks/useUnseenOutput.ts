import { useCallback, useSyncExternalStore } from "react";
import { terminalInstanceService } from "@/services/TerminalInstanceService";

// Minimum unseen lines before surfacing the "new output below" pill. Prevents
// flicker on touchpad jitter / single-line interleavings.
const UNSEEN_THRESHOLD = 2;

// While this many milliseconds have elapsed since the last user wheel event,
// suppress showing the pill so it does not flash mid-scroll-gesture.
const ACTIVE_SCROLL_SUPPRESSION_MS = 200;

export function useUnseenOutput(id: string) {
  const subscribe = useCallback(
    (onStoreChange: () => void) => terminalInstanceService.subscribeUnseenOutput(id, onStoreChange),
    [id]
  );
  const getSnapshot = useCallback(() => terminalInstanceService.getUnseenOutputSnapshot(id), [id]);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  const lastWheelAt = terminalInstanceService.getLastWheelAt(id);
  const isActivelyScrolling = Date.now() - lastWheelAt < ACTIVE_SCROLL_SUPPRESSION_MS;

  return {
    isUserScrolledBack: snapshot.isUserScrolledBack,
    hasUnseenOutput:
      snapshot.isUserScrolledBack && snapshot.unseen > UNSEEN_THRESHOLD && !isActivelyScrolling,
  };
}
