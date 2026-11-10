import { use, useEffect } from "react";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { actionService } from "@/services/ActionService";
import { usePanelStore } from "@/store/panelStore";
import type { WorktreeViewStoreApi } from "@/store/createWorktreeStore";
import type { ActionDispatchResult } from "@shared/types/actions";
import { isPtyPanel } from "@shared/types/panel";
import { formatErrorMessage } from "@shared/utils/errorMessage";

/**
 * How long a view waits to hear of a worktree main just made for a run. Well
 * inside main's minute for an answer, so what it says about a view that never
 * hears is the launcher's own refusal of an unknown worktree.
 */
const NEW_WORKTREE_ARRIVAL_TIMEOUT_MS = 20_000;

/** Resolves once the view's store holds the worktree, or after the timeout. Never rejects. */
function whenWorktreeArrives(store: WorktreeViewStoreApi, worktreeId: string): Promise<void> {
  if (store.getState().worktrees.has(worktreeId)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const timer = setTimeout(finish, NEW_WORKTREE_ARRIVAL_TIMEOUT_MS);
    const unsubscribe = store.subscribe((state) => {
      if (state.worktrees.has(worktreeId)) finish();
    });
  });
}

/**
 * Launches the scheduled runs main hands this view (#15978), so a run's pane
 * appears in this window's grid at once and this view's persistence saves it.
 *
 * The run is host-stamped provenance (`scheduledRun`), never an argument.
 * Dispatched as `"agent"`, the source of work no keystroke asked for, so it
 * never becomes the action Repeat Last replays; `confirmed` is main's
 * attestation that the user configured this launch when they saved the
 * schedule. Main registers the run when the terminal spawns, and reads this
 * answer only for why a launch started nothing.
 *
 * A worktree main just made for the run (#16369) reaches this view on its own
 * port, so the launch waits to hear of it rather than refusing it as unknown.
 *
 * It also drops the pane of a run main closed to replace it (#15980). Main
 * already ended the terminal and kept its session, so only the pane goes, and
 * only one that holds that run.
 */
export function useScheduledRunLaunchBridge(): void {
  const worktreeStore = use(WorktreeStoreContext);
  useEffect(() => {
    const schedules = window.electron?.schedules;
    if (!schedules?.onLaunchRequest) return;
    let disposed = false;
    const cleanup = schedules.onLaunchRequest(({ requestId, args, scheduledRun, newWorktree }) => {
      void (async () => {
        const { worktreeId } = args;
        if (newWorktree && worktreeStore && typeof worktreeId === "string") {
          await whenWorktreeArrives(worktreeStore, worktreeId);
          // Main's wait runs out instead; nothing launches for a view that's gone.
          if (disposed) return;
        }
        let result: ActionDispatchResult;
        try {
          result = await actionService.dispatch("agent.launch", args, {
            source: "agent",
            confirmed: true,
            scheduledRun,
          });
        } catch (error) {
          result = {
            ok: false,
            error: {
              code: "EXECUTION_ERROR",
              message: formatErrorMessage(error, "The scheduled run's launch failed"),
            },
          };
        }
        if (disposed) return;
        try {
          schedules.sendLaunchResponse({ requestId, result });
        } catch {
          // Main's wait runs out instead, and the spawn's admission still decides.
        }
      })();
    });
    const cleanupClosed = schedules.onRunClosed?.(({ runId, terminalId }) => {
      const panels = usePanelStore.getState();
      const panel = panels.panelsById[terminalId];
      if (!panel || !isPtyPanel(panel) || panel.scheduledRun?.runId !== runId) return;
      panels.removePanel(terminalId, { backendAlreadyClosed: true });
    });
    return () => {
      disposed = true;
      cleanup();
      cleanupClosed?.();
    };
  }, [worktreeStore]);
}
