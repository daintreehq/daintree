import { ipcMain } from "electron";
import { getWindowForWebContents } from "../../../window/webContentsRegistry.js";
import { CHANNELS } from "../../channels.js";
import { store } from "../../../store.js";
import type { HandlerDependencies } from "../../types.js";
import type { WorktreeSetActivePayload, WorktreeDeletePayload } from "../../../types/index.js";
import { fileSearchService } from "../../../services/FileSearchService.js";
import { soundService } from "../../../services/SoundService.js";
import { checkRateLimit, waitForRateLimitSlot } from "../../utils.js";
import { WORKTREE_RATE_LIMIT_KEY, WORKTREE_RATE_LIMIT_INTERVAL_MS } from "./constants.js";

export function registerWorktreeLifecycleHandlers(deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const handleWorktreeGetAll = async (event: Electron.IpcMainInvokeEvent) => {
    if (!deps.worktreeService) {
      return [];
    }
    const senderWindow = getWindowForWebContents(event.sender);
    return await deps.worktreeService.getAllStatesAsync(senderWindow?.id);
  };
  ipcMain.handle(CHANNELS.WORKTREE_GET_ALL, handleWorktreeGetAll);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.WORKTREE_GET_ALL));

  const handleWorktreeRefresh = async () => {
    if (!deps.worktreeService) {
      return;
    }
    await deps.worktreeService.refresh();
  };
  ipcMain.handle(CHANNELS.WORKTREE_REFRESH, handleWorktreeRefresh);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.WORKTREE_REFRESH));

  const handleWorktreeSetActive = async (
    event: Electron.IpcMainInvokeEvent,
    payload: WorktreeSetActivePayload
  ) => {
    if (!deps.worktreeService) {
      return;
    }
    const senderWindow = getWindowForWebContents(event.sender);
    const windowId = senderWindow?.id;
    await deps.worktreeService.setActiveWorktree(payload.worktreeId, windowId, { silent: true });
  };
  ipcMain.handle(CHANNELS.WORKTREE_SET_ACTIVE, handleWorktreeSetActive);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.WORKTREE_SET_ACTIVE));

  const handleWorktreeCreate = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: {
      rootPath: string;
      options: { baseBranch: string; newBranch: string; path: string; fromRemote?: boolean };
    }
  ): Promise<string> => {
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
      soundService.play("worktree-create");
    }
    return worktreeId;
  };
  ipcMain.handle(CHANNELS.WORKTREE_CREATE, handleWorktreeCreate);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.WORKTREE_CREATE));

  const handleWorktreeDelete = async (
    event: Electron.IpcMainInvokeEvent,
    payload: WorktreeDeletePayload
  ) => {
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
    const senderWindow = getWindowForWebContents(event.sender);
    const states = await deps.worktreeService.getAllStatesAsync(senderWindow?.id);
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
      soundService.play("worktree-delete");
    }
    // Clean up persisted issue association
    const issueMap = store.get("worktreeIssueMap", {});
    if (issueMap[payload.worktreeId]) {
      const { [payload.worktreeId]: _, ...rest } = issueMap;
      store.set("worktreeIssueMap", rest);
    }
  };
  ipcMain.handle(CHANNELS.WORKTREE_DELETE, handleWorktreeDelete);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.WORKTREE_DELETE));

  return () => handlers.forEach((cleanup) => cleanup());
}
