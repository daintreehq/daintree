import { CHANNELS } from "../../channels.js";
import { store } from "../../../store.js";
import { projectStore } from "../../../services/ProjectStore.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
import type { HandlerDependencies, IpcContext } from "../../types.js";
import type { WorktreeSetActivePayload, WorktreeDeletePayload } from "../../../types/index.js";
import type { WorktreeState } from "../../../../shared/types/worktree.js";
import type { CreateWorktreeOptions } from "../../../../shared/types/git.js";
import { fileSearchService } from "../../../services/FileSearchService.js";
import { getSoundService } from "../../../services/getSoundService.js";
import type * as SoundServiceModule from "../../../services/SoundService.js";
import { defineIpcNamespace, op } from "../../define.js";
import { checkRateLimit, waitForRateLimitSlot } from "../../utils.js";
import { validateBranchName } from "../../../../shared/utils/pathPattern.js";
import { WORKTREE_RATE_LIMIT_KEY, WORKTREE_RATE_LIMIT_INTERVAL_MS } from "./constants.js";

type SoundId = keyof typeof SoundServiceModule.SOUND_FILES;

function playSoundFireAndForget(id: SoundId): void {
  void getSoundService()
    .then((svc) => svc.play(id))
    .catch((err) => console.error("[worktree.lifecycle] sound play failed:", err));
}

export function registerWorktreeLifecycleHandlers(deps: HandlerDependencies): () => void {
  const handleWorktreeGetAll = async (ctx: IpcContext): Promise<WorktreeState[]> => {
    if (!deps.worktreeService) {
      return [];
    }
    return (await deps.worktreeService.getAllStatesAsync(ctx.senderWindow?.id)) as WorktreeState[];
  };

  const handleWorktreeRefresh = async (worktreeId?: string): Promise<void> => {
    if (!deps.worktreeService) {
      return;
    }
    await deps.worktreeService.refresh(worktreeId);
  };

  const handleWorktreeSetActive = async (
    ctx: IpcContext,
    payload: WorktreeSetActivePayload
  ): Promise<void> => {
    if (!deps.worktreeService) {
      return;
    }
    await deps.worktreeService.setActiveWorktree(payload.worktreeId, ctx.senderWindow?.id, {
      silent: true,
    });
  };

  const handleWorktreeCreate = async (payload: {
    rootPath: string;
    options: CreateWorktreeOptions;
  }): Promise<string> => {
    if (
      !payload ||
      typeof payload !== "object" ||
      !payload.options ||
      typeof payload.options !== "object"
    ) {
      throw new Error("Invalid worktree create payload");
    }
    // Defense-in-depth: WorkspaceService.createWorktree also validates, but
    // throwing here surfaces a clean Error to the renderer without consuming
    // a rate-limit slot or spinning up the workspace-host round-trip for
    // obviously-invalid input. #7033.
    const branchValidation = validateBranchName(payload.options.newBranch);
    if (!branchValidation.valid) {
      throw new Error(branchValidation.error ?? "Invalid branch name");
    }
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
    try {
      deps.worktreeService?.invalidatePulseCache(worktreeId);
    } catch (error) {
      console.warn("[worktree.create] Failed to invalidate pulse cache:", error);
    }
    if (store.get("notificationSettings").uiFeedbackSoundEnabled) {
      playSoundFireAndForget("worktree-create");
    }
    return worktreeId;
  };

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

  // Recovery path for a project switch whose worktree load threw (#8400).
  // The switch forward-fails to the new project, so the current project is
  // already the one whose load failed — re-run loadProject for it rather than
  // re-issuing a no-op same-project switch.
  const handleWorktreeRetryProjectLoad = async (ctx: IpcContext): Promise<void> => {
    if (!deps.worktreeService) {
      throw new Error("Workspace service is not available");
    }
    const windowId = ctx.senderWindow?.id;
    if (windowId === undefined) {
      throw new Error("Couldn't identify the window to reload");
    }
    const project = projectStore.getCurrentProject();
    if (!project) {
      throw new Error("No active project to reload");
    }
    try {
      await deps.worktreeService.loadProject(project.path, windowId);
    } catch (error) {
      throw new Error(formatErrorMessage(error, "Failed to load worktrees"), { cause: error });
    }
  };

  const handleWorktreeDelete = async (
    ctx: IpcContext,
    payload: WorktreeDeletePayload
  ): Promise<void> => {
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
    try {
      deps.worktreeService?.invalidatePulseCache(payload.worktreeId);
    } catch (error) {
      console.warn("[worktree.delete] Failed to invalidate pulse cache:", error);
    }
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

  const namespace = defineIpcNamespace({
    name: "worktreeLifecycle",
    ops: {
      getAll: op(CHANNELS.WORKTREE_GET_ALL, handleWorktreeGetAll, { withContext: true }),
      refresh: op(CHANNELS.WORKTREE_REFRESH, handleWorktreeRefresh),
      setActive: op(CHANNELS.WORKTREE_SET_ACTIVE, handleWorktreeSetActive, { withContext: true }),
      create: op(CHANNELS.WORKTREE_CREATE, handleWorktreeCreate),
      restartService: op(CHANNELS.WORKTREE_RESTART_SERVICE, handleWorktreeRestartService, {
        withContext: true,
      }),
      retryProjectLoad: op(CHANNELS.WORKTREE_RETRY_PROJECT_LOAD, handleWorktreeRetryProjectLoad, {
        withContext: true,
      }),
      delete: op(CHANNELS.WORKTREE_DELETE, handleWorktreeDelete, { withContext: true }),
    },
  });

  return namespace.register();
}
