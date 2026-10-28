import { useCallback } from "react";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeStoreApi } from "@/hooks/useWorktreeStore";
import { ResumeWorktreeGoneError, resumeSessionForPerson } from "@/services/agentResumeForPerson";
import { notify } from "@/lib/notify";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { AgentSessionRecord } from "@shared/types/ipc/agentSessionHistory";

/**
 * Returns a `resume(session)` callback that launches (or focuses) a closed
 * agent session. Every human resume surface — the resume launcher palette, the
 * empty-grid card, and the panel palette — funnels through here.
 *
 * The policy lives in `resumeSessionForPerson`, shared with Canopy's Trash:
 * the session's own directory and worktree, revealed in the grid, never a
 * second pane on one transcript. What stays here is what only this surface
 * needs: the per-view worktree store, bringing the pane forward, and turning
 * a failure into a toast.
 *
 * Everything, the worktree map included, is read via `getState()` at call time
 * so the callback keeps one identity across worktree status ticks — it is
 * handed to the app root's modal host.
 */
export function useResumeAgentSession() {
  const worktreeStore = useWorktreeStoreApi();

  return useCallback(
    async (session: AgentSessionRecord): Promise<void> => {
      const worktrees = new Map(
        [...worktreeStore.getState().worktrees.values()].map((wt) => [wt.id, wt.path])
      );
      try {
        const resumed = await resumeSessionForPerson(session, worktrees);
        usePanelStore.getState().activateTerminal(resumed.terminalId);
      } catch (error) {
        // Callers already filter rows whose worktree is gone; a stale one does nothing.
        if (error instanceof ResumeWorktreeGoneError) return;
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
        notify({
          type: "error",
          title: "Resume failed",
          message: formatErrorMessage(
            error,
            "Couldn't resume this session — its agent may no longer support resuming."
          ),
          priority: "high",
          context: {
            eventKind: "agent",
            ...(session.worktreeId ? { worktreeId: session.worktreeId } : {}),
          },
        });
      }
    },
    [worktreeStore]
  );
}
