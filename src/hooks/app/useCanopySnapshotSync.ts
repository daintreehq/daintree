import { useEffect } from "react";
import { useCanopyStore } from "@/store/canopyStore";
import { safeFireAndForget } from "@/utils/safeFireAndForget";

/**
 * Keeps this view's Canopy state current, whatever of Canopy it shows: whether
 * it is on, off or hidden, and the cards behind the toolbar's count. Lives at
 * the app, not in the toolbar button, since a hidden Canopy has no button and a
 * view must still hear when Settings in another one shows it again.
 */
export function useCanopySnapshotSync(): void {
  useEffect(() => {
    const canopy = window.electron?.canopy;
    if (!canopy?.onSnapshotUpdated) return;
    const { applySnapshot } = useCanopyStore.getState();
    const unsubscribe = canopy.onSnapshotUpdated(applySnapshot);
    safeFireAndForget(canopy.getSnapshot().then(applySnapshot), {
      context: "Reading whether Canopy is set up",
    });
    return unsubscribe;
  }, []);
}
