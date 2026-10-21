import { useCallback } from "react";
import { useWorktreeStoreOptional } from "@/hooks/useWorktreeStore";
import { actionService } from "@/services/ActionService";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import type { WorktreeResourceStatus } from "@shared/types/worktree";

/**
 * The resource endpoint an endpoint-mode dev preview shows (#13688). Returns
 * `endpoint: undefined` for an ordinary panel so useDevServer keeps running its
 * dev command; an endpoint panel gets the worktree's last reported endpoint, or
 * null until a status check has reported one.
 */
export function useResourceEndpointPreview(
  worktreeId: string | undefined,
  enabled: boolean
): {
  endpoint: string | null | undefined;
  refreshEndpoint: (() => Promise<string | null>) | undefined;
  checkEndpoint: (() => void) | undefined;
} {
  const reported = useWorktreeStoreOptional(
    useCallback(
      (state) =>
        worktreeId ? (state.worktrees.get(worktreeId)?.resourceStatus?.endpoint ?? null) : null,
      [worktreeId]
    ),
    null
  );

  const refreshEndpoint = useCallback(async (): Promise<string | null> => {
    if (!worktreeId) return null;
    const worktree = getCurrentViewStore().getState().worktrees.get(worktreeId);
    // Optional commands: a resource without pause or resume skips that step,
    // and the status check is what reports where the server now is.
    for (const [actionId, configured] of [
      ["worktree.resource.pause", worktree?.hasPauseCommand],
      ["worktree.resource.resume", worktree?.hasResumeCommand],
    ] as const) {
      if (!configured) continue;
      const result = await actionService.dispatch(actionId, { worktreeId }, { source: "user" });
      if (!result.ok) throw new Error(result.error.message);
    }
    const status = await actionService.dispatch<{
      configured: boolean;
      status: WorktreeResourceStatus | null;
    }>("worktree.resource.status", { worktreeId }, { source: "user" });
    if (!status.ok) throw new Error(status.error.message);
    return status.result?.status?.endpoint ?? null;
  }, [worktreeId]);

  // A plain status check: the endpoint it reports lands in the worktree store,
  // which re-ensures the panel. Failures notify from the action itself.
  const checkEndpoint = useCallback(() => {
    if (!worktreeId) return;
    void actionService.dispatch("worktree.resource.status", { worktreeId }, { source: "user" });
  }, [worktreeId]);

  return enabled
    ? { endpoint: reported, refreshEndpoint, checkEndpoint }
    : { endpoint: undefined, refreshEndpoint: undefined, checkEndpoint: undefined };
}
