import { useEffect, useRef, useState } from "react";
import type { CanopyResumeAnswer, CanopyResumeRequest } from "@shared/types/ipc/canopy";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { isScratchWorkspaceId } from "@shared/utils/workspaceIds";
import { useWorktreeStoreApi } from "@/hooks/useWorktreeStore";
import { RESUME_UNAVAILABLE_MESSAGE } from "@/services/agentResume";
import { resumeSessionForPerson } from "@/services/agentResumeForPerson";
import { whenWorktreesKnown } from "@/services/worktreeLanding";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { safeFireAndForget } from "@/utils/safeFireAndForget";

/** As long as a project still opening is given for its first worktree list. */
const WORKTREES_WAIT_MS = 5_000;

interface QueuedRequest {
  request: CanopyResumeRequest;
  arrivedAt: number;
}

/**
 * Canopy's Trash asks this view, one of its project's, to resume a session
 * the user closed: as the Resume Sessions palette would, through the same
 * path, answered with the pane that runs it now. Held until the view has
 * hydrated. A view that already has a worktree list uses it, a cached one's
 * included; one still opening waits a moment for its first; one with none
 * (a scratch) launches from the session's own place, which main has checked
 * is on disk. A request main has stopped waiting for is dropped, never
 * started. Nothing here moves the keyboard: Canopy shows the run, or the
 * restore that opened the project focuses it.
 */
export function useCanopyResumeRequests(isStateLoaded: boolean): void {
  const worktreeStore = useWorktreeStoreApi();
  const [queued, setQueued] = useState<QueuedRequest[]>([]);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const off = window.electron?.canopy?.onResumeRequested?.((request) => {
      setQueued((current) => [...current, { request, arrivedAt: Date.now() }]);
    });
    return () => {
      alive.current = false;
      off?.();
    };
  }, []);

  useEffect(() => {
    if (!isStateLoaded || queued.length === 0) return;
    const pending = queued;
    setQueued([]);
    const listOf = (): Map<string, string> | null => {
      const { worktrees } = worktreeStore.getState();
      return worktrees.size > 0
        ? new Map([...worktrees.values()].map((wt) => [wt.id, wt.path]))
        : null;
    };
    for (const { request, arrivedAt } of pending) {
      const { requestId, session, answerWithinMs } = request;
      const stale = () => Date.now() - arrivedAt >= answerWithinMs;
      const answer = async (): Promise<CanopyResumeAnswer | null> => {
        let worktrees = listOf();
        const state = worktreeStore.getState();
        const opening = !state.isInitialized || state.isLoading;
        if (!worktrees && opening && !isScratchWorkspaceId(getViewWorkspaceId() ?? "")) {
          await whenWorktreesKnown(worktreeStore, WORKTREES_WAIT_MS);
          worktrees = listOf();
        }
        // Main stopped waiting: a launch now would be one nobody is told of.
        if (stale() || !alive.current) return null;
        try {
          const resumed = await resumeSessionForPerson(session, worktrees);
          return { runId: resumed.terminalId };
        } catch (error) {
          return { error: formatErrorMessage(error, RESUME_UNAVAILABLE_MESSAGE) };
        }
      };
      if (stale()) continue;
      safeFireAndForget(
        answer().then((settled) => {
          if (settled === null || !alive.current) return;
          return window.electron.canopy.resumeSettled(requestId, settled);
        }),
        { context: "Answering Canopy's resume request" }
      );
    }
  }, [isStateLoaded, queued, worktreeStore]);
}
