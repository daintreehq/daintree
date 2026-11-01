import { useEffect, useRef, useState } from "react";
import { actionService } from "@/services/ActionService";
import type { ProjectFocusOnActivateIntent } from "@shared/types/ipc/project";
import type { ActionId } from "@shared/types/actions";
import { logWarn } from "@/utils/logger";
import { notify } from "@/lib/notify";
import { activateAssistantLane } from "@/services/assistantSubject";
import { landOnWorktree } from "@/services/worktreeLanding";
import { landOnScheduledRun } from "@/services/scheduledRunLanding";
import { useWorktreeStoreApi } from "@/hooks/useWorktreeStore";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { safeFireAndForget } from "@/utils/safeFireAndForget";

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
  /**
   * A landing still waiting (on the worktree list, or on a restore's pane): a
   * newer intent or unmount cancels it.
   */
  const cancelLanding = useRef<(() => void) | null>(null);

  useEffect(() => {
    const off = window.electron.project.onFocusOnActivate((payload) => {
      if (
        payload?.intent !== "focus-next-waiting" &&
        payload?.intent !== "focus-panel" &&
        payload?.intent !== "focus-worktree" &&
        payload?.intent !== "run-plugin-action" &&
        payload?.intent !== "open-assistant" &&
        payload?.intent !== "restore-trashed" &&
        payload?.intent !== "placement-note" &&
        payload?.intent !== "focus-scheduled-run" &&
        payload?.intent !== "open-schedules"
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
    if (pending.intent === "restore-trashed") {
      // This project was opened to resume a run from Canopy's Trash: its
      // host resumes it in this view now, and the pane it lands in is shown,
      // unless a newer destination came meanwhile.
      const { runId, spawnedAt, expiresAt } = pending;
      let superseded = false;
      cancelLanding.current = () => {
        superseded = true;
      };
      safeFireAndForget(
        window.electron.canopy
          .restoreTrashed(runId, { spawnedAt, expiresAt })
          .then(async (outcome) => {
            if (!("runId" in outcome)) throw new Error("This project's view isn't ready.");
            if (superseded) return;
            await actionService.dispatch("panel.focus", { panelId: outcome.runId });
          })
          .catch((error: unknown) => {
            // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
            notify({
              type: "error",
              title: "Couldn't restore terminal",
              message: formatErrorMessage(error, "It has left the trash."),
              context: { eventKind: "agent" },
              replaceKey: "focus-on-activate:restore-trashed",
            });
          }),
        { context: "Restoring a run from Canopy's Trash" }
      );
      return;
    }
    if (pending.intent === "placement-note") {
      // Grid-bar: it comes from the host this view now shows, after the dialog
      // that asked for the worktree has closed in another view.
      notify({
        type: "warning",
        title: "Part of the setup didn't run",
        message: pending.note,
        context: { eventKind: "agent" },
        placement: "grid-bar",
        duration: 0,
        replaceKey: "focus-on-activate:placement-note",
      });
      return;
    }
    if (pending.intent === "focus-scheduled-run") {
      // A scheduled run's banner (#15988): its pane if this view holds it,
      // else its schedule's history, decided now that the panes are in.
      let superseded = false;
      cancelLanding.current = () => {
        superseded = true;
      };
      safeFireAndForget(
        landOnScheduledRun(
          { runId: pending.runId, scheduleId: pending.scheduleId, panelId: pending.panelId },
          () => superseded
        ),
        { context: "Landing on a scheduled run from its notification" }
      );
      return;
    }
    if (pending.intent === "open-schedules") {
      const args = pending.scheduleId ? { scheduleId: pending.scheduleId } : undefined;
      void actionService.dispatch("schedules.open", args).then((result) => {
        if (!result.ok) logWarn("Couldn't open the schedules view", { error: result.error });
      });
      return;
    }
    if (pending.intent === "focus-worktree") {
      cancelLanding.current = landOnWorktree(pending.worktreeId, worktreeStore);
      return;
    }
    if (pending.intent === "focus-panel") {
      // The terminal can exit or be trashed while the project switch is in
      // flight. A sender that named its worktree lands there instead.
      const { panelId, worktreeId } = pending;
      let superseded = false;
      cancelLanding.current = () => {
        superseded = true;
      };
      void actionService.dispatch("panel.focus", { panelId }).then((result) => {
        if (result.ok || superseded) return;
        if (worktreeId) {
          cancelLanding.current = landOnWorktree(worktreeId, worktreeStore);
          return;
        }
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
