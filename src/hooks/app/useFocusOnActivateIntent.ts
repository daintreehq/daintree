import { useEffect, useState } from "react";
import { actionService } from "@/services/ActionService";
import type { ProjectFocusOnActivateIntent } from "@shared/types/ipc/project";

/**
 * Cross-project focus intent receiver.
 *
 * The main process delivers `project:focus-on-activate` once a cross-project
 * navigation has switched WebContentsViews and the incoming view has either
 * painted (cold start) or been reactivated (cached). This hook subscribes
 * unconditionally on mount so the listener is registered before
 * `notifyViewPainted` fires.
 *
 * Dispatch is deferred until `isStateLoaded` is true: the paint signal arrives
 * after the first React commit but before `useAppHydration` finishes, so
 * `panelStore.panelIds` is empty at receipt-time and a direct dispatch would
 * silently no-op. Buffering the intent in state and firing on the hydration
 * transition is the canonical fix.
 *
 * The whole intent is buffered rather than a boolean: `focus-panel` carries the
 * target panel id, and re-deriving a destination on arrival is exactly what the
 * explicit form exists to avoid.
 */
export function useFocusOnActivateIntent(isStateLoaded: boolean): void {
  const [pending, setPending] = useState<ProjectFocusOnActivateIntent | null>(null);

  useEffect(() => {
    return window.electron.project.onFocusOnActivate((payload) => {
      if (payload?.intent !== "focus-next-waiting" && payload?.intent !== "focus-panel") return;
      setPending(payload);
    });
  }, []);

  useEffect(() => {
    if (!isStateLoaded || pending === null) return;
    setPending(null);
    if (pending.intent === "focus-panel") {
      void actionService.dispatch("panel.focus", { panelId: pending.panelId });
      return;
    }
    void actionService.dispatch("agent.focusNextWaiting");
  }, [isStateLoaded, pending]);
}
