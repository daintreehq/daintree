import { useEffect, useRef, useState } from "react";
import { actionService } from "@/services/ActionService";
import type { ProjectFocusOnActivateIntent } from "@shared/types/ipc/project";
import type { ActionId } from "@shared/types/actions";
import { logWarn } from "@/utils/logger";
import { notify } from "@/lib/notify";
import { activateAssistantLane } from "@/services/assistantSubject";
import { landOnWorktree } from "@/services/worktreeLanding";
import { useWorktreeStoreApi } from "@/hooks/useWorktreeStore";

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
  const worktreeStore = useWorktreeStoreApi();
  /** A worktree landing still waiting on the list: a newer intent or unmount cancels it. */
  const cancelLanding = useRef<(() => void) | null>(null);

  useEffect(() => {
    const off = window.electron.project.onFocusOnActivate((payload) => {
      if (
        payload?.intent !== "focus-next-waiting" &&
        payload?.intent !== "focus-panel" &&
        payload?.intent !== "focus-worktree" &&
        payload?.intent !== "run-plugin-action" &&
        payload?.intent !== "open-assistant"
      ) {
        return;
      }
      cancelLanding.current?.();
      cancelLanding.current = null;
      setPending(payload);
    });
    return () => {
      off();
      cancelLanding.current?.();
    };
  }, []);

  useEffect(() => {
    if (!isStateLoaded || pending === null) return;
    setPending(null);
    if (pending.intent === "run-plugin-action") {
      // A plugin's banner may only ever run that plugin's own action.
      if (!pending.actionId.startsWith(`${pending.pluginId}.`)) return;
      void actionService
        .dispatch(pending.actionId as ActionId, pending.args, { source: "user" })
        .then((result) => {
          if (!result.ok) {
            logWarn("Plugin notification action failed", {
              actionId: pending.actionId,
              error: result.error,
            });
          }
        });
      return;
    }
    if (pending.intent === "open-assistant") {
      // Checked again on arrival: a session that ended during the switch opens nothing.
      void activateAssistantLane(pending.subject).catch((error: unknown) => {
        logWarn("Couldn't open the assistant lane", { error });
      });
      return;
    }
    if (pending.intent === "focus-worktree") {
      cancelLanding.current = landOnWorktree(pending.worktreeId, worktreeStore);
      return;
    }
    if (pending.intent === "focus-panel") {
      // The terminal can exit or be trashed while the project switch is in flight.
      void actionService.dispatch("panel.focus", { panelId: pending.panelId }).then((result) => {
        if (result.ok) return;
        notify({
          type: "warning",
          title: "Terminal is gone",
          message: "It closed while its project was opening. You're in that project now.",
          context: { eventKind: "uiFeedback" },
          replaceKey: "focus-on-activate:terminal-gone",
        });
      });
      return;
    }
    void actionService.dispatch("agent.focusNextWaiting");
  }, [isStateLoaded, pending, worktreeStore]);
}
