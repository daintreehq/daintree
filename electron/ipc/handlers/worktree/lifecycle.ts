import { CHANNELS } from "../../channels.js";
import { store } from "../../../store.js";
import type { HandlerDependencies, IpcContext } from "../../types.js";
import type { WorktreeSetActivePayload, WorktreeDeletePayload } from "../../../types/index.js";
import type { WorktreeState } from "../../../../shared/types/worktree.js";
import { fileSearchService } from "../../../services/FileSearchService.js";
import { getSoundService } from "../../../services/getSoundService.js";
import type * as SoundServiceModule from "../../../services/SoundService.js";

type SoundId = keyof typeof SoundServiceModule.SOUND_FILES;

function playSoundFireAndForget(id: SoundId): void {
  void getSoundService()
    .then((svc) => svc.play(id))
    .catch((err) => console.error("[worktree.lifecycle] sound play failed:", err));
}
import {
  checkRateLimit,
  waitForRateLimitSlot,
  typedHandle,
  typedHandleWithContext,
} from "../../utils.js";
import { WORKTREE_RATE_LIMIT_KEY, WORKTREE_RATE_LIMIT_INTERVAL_MS } from "./constants.js";

export function registerWorktreeLifecycleHandlers(deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const handleWorktreeGetAll = async (ctx: IpcContext): Promise<WorktreeState[]> => {
    if (!deps.worktreeService) {
      return [];
    }
    return (await deps.worktreeService.getAllStatesAsync(ctx.senderWindow?.id)) as WorktreeState[];
  };
  handlers.push(typedHandleWithContext(CHANNELS.WORKTREE_GET_ALL, handleWorktreeGetAll));

  const handleWorktreeRefresh = async () => {
    if (!deps.worktreeService) {
      return;
    }
    await deps.worktreeService.refresh();
  };
  handlers.push(typedHandle(CHANNELS.WORKTREE_REFRESH, handleWorktreeRefresh));

  const handleWorktreeSetActive = async (ctx: IpcContext, payload: WorktreeSetActivePayload) => {
    if (!deps.worktreeService) {
      return;
    }
    await deps.worktreeService.setActiveWorktree(payload.worktreeId, ctx.senderWindow?.id, {
      silent: true,
    });
  };
  handlers.push(typedHandleWithContext(CHANNELS.WORKTREE_SET_ACTIVE, handleWorktreeSetActive));

  const handleWorktreeCreate = async (payload: {
    rootPath: string;
    options: { baseBranch: string; newBranch: string; path: string; fromRemote?: boolean };
  }): Promise<string> => {
    await waitForRateLimitSlot(WORKTREE_RATE_LIMIT_KEY, WORKTREE_RATE_LIMIT_INTERVAL_MS);
    if (!deps.worktreeService) {
      throw new Error("Workspace client not initialized");
    }
    const worktreeId = await deps.worktreeService.createWorktree(payload.rootPath, payload.options);
    try {
      fileSearchService.invalidate(payload.options.path);
    } catch (error) {
      console.warn("[worktree.create] Failed to invalidate file search cache:", error);
    }
    if (store.get("notificationSettings").uiFeedbackSoundEnabled) {
      playSoundFireAndForget("worktree-create");
    }
    return worktreeId;
  };
  handlers.push(typedHandle(CHANNELS.WORKTREE_CREATE, handleWorktreeCreate));

  const handleWorktreeRestartService = async (ctx: IpcContext): Promise<void> => {
    if (!deps.worktreeService) return;
    const windowId = ctx.senderWindow?.id;
    if (windowId === undefined) {
      console.warn(
        "[worktree.restart-service] No sender window; cannot route manual restart to a host"
      );
      return;
    }
    deps.worktreeService.manualRestartForWindow(windowId);
  };
  handlers.push(
    typedHandleWithContext(CHANNELS.WORKTREE_RESTART_SERVICE, handleWorktreeRestartService)
  );

  const handleWorktreeDelete = async (ctx: IpcContext, payload: WorktreeDeletePayload) => {
    checkRateLimit(CHANNELS.WORKTREE_DELETE, 10, 10_000);
    if (!deps.worktreeService) {
      throw new Error("Workspace client not initialized");
    }
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload");
    }
    if (typeof payload.worktreeId !== "string" || !payload.worktreeId) {
      throw new Error("Invalid worktree ID");
    }
    if (payload.force !== undefined && typeof payload.force !== "boolean") {
      throw new Error("Invalid force parameter");
    }
    if (payload.deleteBranch !== undefined && typeof payload.deleteBranch !== "boolean") {
      throw new Error("Invalid deleteBranch parameter");
    }
    const states = await deps.worktreeService.getAllStatesAsync(ctx.senderWindow?.id);
    const worktree = states.find((wt) => wt.id === payload.worktreeId);
    await deps.worktreeService.deleteWorktree(
      payload.worktreeId,
      payload.force,
      payload.deleteBranch
    );
    if (worktree) {
      try {
        fileSearchService.invalidate(worktree.path);
      } catch (error) {
        console.warn("[worktree.delete] Failed to invalidate file search cache:", error);
      }
    }
    if (store.get("notificationSettings").uiFeedbackSoundEnabled) {
      playSoundFireAndForget("worktree-delete");
    }
    // Clean up persisted issue association
    const issueMap = store.get("worktreeIssueMap", {});
    if (issueMap[payload.worktreeId]) {
      const { [payload.worktreeId]: _, ...rest } = issueMap;
      store.set("worktreeIssueMap", rest);
    }
  };
  handlers.push(typedHandleWithContext(CHANNELS.WORKTREE_DELETE, handleWorktreeDelete));

  return () => handlers.forEach((cleanup) => cleanup());
}
