import { useEffect, useRef, useState } from "react";
import type { CanopyResumeAnswer, CanopyResumeRequest } from "@shared/types/ipc/canopy";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { useWorktreeStoreApi } from "@/hooks/useWorktreeStore";
import { resumeSessionForPerson } from "@/services/agentResumeForPerson";
import { whenWorktreesKnown } from "@/services/worktreeLanding";
import { logWarn } from "@/utils/logger";

/** Under main's own wait, so the view's answer is the one main hears. */
const WORKTREES_WAIT_MS = 20_000;

/**
 * Canopy's Trash asks this view, one of its project's, to resume a session
 * the user closed: as the Resume Sessions palette would, through the same
 * path, answered with the pane that runs it now. Held until the view has
 * hydrated and knows its worktrees, so a project opened for the restore
 * resumes into its own worktree rather than reporting it gone. Nothing here
 * moves the keyboard: Canopy shows the run, or the restore that opened the
 * project focuses it.
 */
export function useCanopyResumeRequests(isStateLoaded: boolean): void {
  const worktreeStore = useWorktreeStoreApi();
  const [queued, setQueued] = useState<CanopyResumeRequest[]>([]);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const off = window.electron?.canopy?.onResumeRequested?.((request) => {
      setQueued((current) => [...current, request]);
    });
    return () => {
      alive.current = false;
      off?.();
    };
  }, []);

  useEffect(() => {
    if (!isStateLoaded || queued.length === 0) return;
    const requests = queued;
    setQueued([]);
    for (const { requestId, session } of requests) {
      const answer = async (): Promise<CanopyResumeAnswer> => {
        if (!(await whenWorktreesKnown(worktreeStore, WORKTREES_WAIT_MS))) {
          return { error: "The project's worktrees didn't load in time." };
        }
        const worktrees = new Map(
          [...worktreeStore.getState().worktrees.values()].map((wt) => [wt.id, wt.path])
        );
        try {
          const resumed = await resumeSessionForPerson(session, worktrees);
          return { runId: resumed.terminalId };
        } catch (error) {
          return {
            error: formatErrorMessage(
              error,
              "Couldn't resume this session — its agent may no longer support resuming."
            ),
          };
        }
      };
      void answer()
        .then((settled) => {
          if (!alive.current) return;
          return window.electron.canopy.resumeSettled(requestId, settled);
        })
        .catch((error: unknown) => {
          logWarn("Couldn't answer Canopy's resume request", { error });
        });
    }
  }, [isStateLoaded, queued, worktreeStore]);
}
