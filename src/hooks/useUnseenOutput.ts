import { useCallback, useSyncExternalStore } from "react";
import {
  peek as peekTerminalService,
  subscribeWhenReady,
} from "@/services/terminal/terminalInstanceServiceAccessor";
import {
  UNSEEN_THRESHOLD,
  type UnseenOutputSnapshot,
} from "@/services/terminal/TerminalUnseenOutputTracker";

// While this many milliseconds have elapsed since the last user wheel event,
// suppress showing the pill so it does not flash mid-scroll-gesture.
const ACTIVE_SCROLL_SUPPRESSION_MS = 200;

// One shared reference: a fresh object per read would loop useSyncExternalStore.
const UNLOADED_SNAPSHOT: UnseenOutputSnapshot = Object.freeze({
  isUserScrolledBack: false,
  unseen: 0,
});

export function useUnseenOutput(id: string) {
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      subscribeWhenReady(
        (service) => service.subscribeUnseenOutput(id, onStoreChange),
        onStoreChange
      ),
    [id]
  );
  const getSnapshot = useCallback(
    () => peekTerminalService()?.getUnseenOutputSnapshot(id) ?? UNLOADED_SNAPSHOT,
    [id]
  );

  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  const lastWheelAt = peekTerminalService()?.getLastWheelAt(id) ?? 0;
  const isActivelyScrolling = Date.now() - lastWheelAt < ACTIVE_SCROLL_SUPPRESSION_MS;

  return {
    isUserScrolledBack: snapshot.isUserScrolledBack,
    hasUnseenOutput:
      snapshot.isUserScrolledBack && snapshot.unseen > UNSEEN_THRESHOLD && !isActivelyScrolling,
  };
}
