import { useEffect, useState } from "react";
import { actionService } from "@/services/ActionService";

/**
 * Cross-project focus intent receiver.
 *
 * The main process delivers `project:focus-on-activate` once the
 * `agent.focusNextWaitingGlobal` action has switched WebContentsViews and
 * the incoming view has either painted (cold start) or been reactivated
 * (cached). This hook subscribes unconditionally on mount so the listener
 * is registered before `notifyViewPainted` fires.
 *
 * Dispatch is deferred until `isStateLoaded` is true: paint signal arrives
 * after the first React commit but before `useAppHydration` finishes, so
 * `panelStore.panelIds` is empty at receipt-time and a direct dispatch of
 * `agent.focusNextWaiting` would silently no-op. Buffering the intent in
 * state and firing on the hydration transition is the canonical fix.
 */
export function useFocusOnActivateIntent(isStateLoaded: boolean): void {
  const [pending, setPending] = useState(false);

  useEffect(() => {
    return window.electron.project.onFocusOnActivate((payload) => {
      if (payload?.intent !== "focus-next-waiting") return;
      setPending(true);
    });
  }, []);

  useEffect(() => {
    if (!isStateLoaded || !pending) return;
    setPending(false);
    void actionService.dispatch("agent.focusNextWaiting");
  }, [isStateLoaded, pending]);
}
