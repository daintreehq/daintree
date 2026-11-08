import { useEffect } from "react";
import { useCanopyStore } from "@/store/canopyStore";

/**
 * A project view's Canopy dialog closes once a dialog, this view's or
 * another's, has popped out into the Canopy window (#16338), which now shows
 * what it did. Lives at the app, since the dialog mounts lazily, and only in
 * project views: the Canopy window hears the same push and must not put its
 * own inbox away.
 */
export function useCanopyPoppedOut(): void {
  useEffect(() => {
    const onPoppedOut = window.electron?.canopyWindow?.onPoppedOut;
    if (!onPoppedOut) return;
    return onPoppedOut(() => {
      if (useCanopyStore.getState().isOpen) useCanopyStore.getState().close();
    });
  }, []);
}
