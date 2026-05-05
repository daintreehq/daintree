/**
 * Scratch (one-off agent workspace) IPC handlers — CRUD + switch.
 *
 * Scratch entities are deliberately separate from Project: their own table,
 * their own current-id pointer in `app_state`, their own switch handler that
 * skips git/worktree calls. Folders live under `userData/scratches/{uuid}/`
 * and never invoke `WorktreeService` (non-git directories) or
 * `ProjectSwitchService` (which validates against `projects`).
 */
import { randomUUID } from "crypto";
import { dialog, type WebContentsView } from "electron";
import fs from "fs/promises";
import path from "path";
import { CHANNELS } from "../../channels.js";
import { broadcastToRenderer, typedHandle, typedHandleWithContext } from "../../utils.js";
import { getWindowForWebContents } from "../../../window/webContentsRegistry.js";
import { distributePortsToView } from "../../../window/portDistribution.js";
import { scratchStore } from "../../../services/ScratchStore.js";
import { projectStore } from "../../../services/ProjectStore.js";
import { addProjectByPath } from "../projectCrud/crud.js";
import { logError } from "../../../utils/logger.js";
import type { HandlerDependencies } from "../../types.js";
import type { Scratch } from "../../../../shared/types/scratch.js";
import type { ScratchSaveAsProjectResult } from "../../../../shared/types/ipc/scratch.js";

export function registerScratchHandlers(deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const handleGetAll = async (): Promise<Scratch[]> => scratchStore.getAllScratches();
  handlers.push(typedHandle(CHANNELS.SCRATCH_GET_ALL, handleGetAll));

  const handleGetCurrent = async (): Promise<Scratch | null> => scratchStore.getCurrentScratch();
  handlers.push(typedHandle(CHANNELS.SCRATCH_GET_CURRENT, handleGetCurrent));

  const handleCreate = async (name?: string): Promise<Scratch> => {
    const scratch = await scratchStore.createScratch(name);
    broadcastToRenderer(CHANNELS.SCRATCH_UPDATED, scratch);
    return scratch;
  };
  handlers.push(typedHandle(CHANNELS.SCRATCH_CREATE, handleCreate));

  const handleUpdate = async (
    scratchId: string,
    updates: { name?: string; lastOpened?: number }
  ): Promise<Scratch> => {
    if (typeof scratchId !== "string" || !scratchId) {
      throw new Error("Invalid scratch ID");
    }
    if (typeof updates !== "object" || updates === null) {
      throw new Error("Invalid updates object");
    }
    const updated = scratchStore.updateScratch(scratchId, updates);
    broadcastToRenderer(CHANNELS.SCRATCH_UPDATED, updated);
    return updated;
  };
  handlers.push(typedHandle(CHANNELS.SCRATCH_UPDATE, handleUpdate));

  const handleRemove = async (scratchId: string): Promise<void> => {
    if (typeof scratchId !== "string" || !scratchId) {
      throw new Error("Invalid scratch ID");
    }

    if (deps.ptyClient) {
      await deps.ptyClient.killByProject(scratchId).catch((err: unknown) => {
        console.error(`[IPC] scratch:remove: Failed to kill terminals for ${scratchId}:`, err);
      });
    }

    await scratchStore.removeScratch(scratchId);
    broadcastToRenderer(CHANNELS.SCRATCH_REMOVED, scratchId);
  };
  handlers.push(typedHandle(CHANNELS.SCRATCH_REMOVE, handleRemove));

  const handleSwitch = async (
    ctx: import("../../types.js").IpcContext,
    scratchId: string
  ): Promise<Scratch> => {
    if (typeof scratchId !== "string" || !scratchId) {
      throw new Error("Invalid scratch ID");
    }

    const scratch = scratchStore.getScratchById(scratchId);
    if (!scratch) {
      throw new Error(`Scratch not found: ${scratchId}`);
    }

    // Resolve the per-window ProjectViewManager (the same view manager handles
    // scratches; PVM is keyed on opaque string IDs and has no entity-type
    // assumptions, so a UUID scratch ID coexists with SHA256 project IDs).
    const senderWindow = getWindowForWebContents(ctx.event.sender);
    const pvmCtx = senderWindow ? deps.windowRegistry?.getByWindowId(senderWindow.id) : undefined;
    const pvm = pvmCtx?.services?.projectViewManager ?? deps.projectViewManager;

    // Run the PVM switch first; if it throws, the canonical pointers stay
    // pointed at the previous state so an app restart hydrates a coherent
    // workspace. Mirrors the project:switch flow where `setCurrentProject` is
    // only called after `pvm.switchTo()` resolves.
    let activeView: WebContentsView | null = null;
    if (pvm) {
      const result = await pvm.switchTo(scratchId, scratch.path);
      activeView = result.view;
    }

    // Now commit canonical pointers — scratch active, project cleared.
    // Mutually exclusive with project: clear the project pointer so the
    // renderer's `getCurrentProject` does not race-restore the previous project.
    const updated = scratchStore.setCurrentScratch(scratchId);
    projectStore.clearCurrentProject();

    // Tell the PTY host the active workspace changed. PtyClient treats the ID
    // as an opaque string and the path as a working directory, so passing a
    // scratch UUID + scratch dir is supported by the existing protocol.
    const windowId = senderWindow?.id ?? deps.mainWindow?.id;
    if (windowId !== undefined && deps.ptyClient) {
      deps.ptyClient.onProjectSwitch(windowId, scratchId, scratch.path);
    }

    // Distribute a fresh PTY MessagePort to the active view. Without this,
    // terminals spawned in the scratch can't reach the PTY host.
    if (windowId !== undefined && senderWindow && deps.windowRegistry) {
      const wctx = deps.windowRegistry.getByWindowId(senderWindow.id);
      if (wctx) {
        const targetWc = activeView?.webContents ?? ctx.event.sender;
        if (!targetWc.isDestroyed()) {
          distributePortsToView(senderWindow, wctx, targetWc, deps.ptyClient ?? null);
        }
      }
    }

    const switchId = randomUUID();
    broadcastToRenderer(CHANNELS.SCRATCH_ON_SWITCH, { scratch: updated, switchId });

    return updated;
  };
  handlers.push(typedHandleWithContext(CHANNELS.SCRATCH_SWITCH, handleSwitch));

  /**
   * Save-as-Project — opens a directory picker, copies the scratch folder to
   * the chosen destination, and registers the destination as a regular
   * project. Copy (not move) so a failed registration leaves the scratch
   * intact; the original scratch is NOT deleted by this handler. The renderer
   * prompts the user separately and calls `scratch:remove` if they confirm.
   */
  const handleSaveAsProject = async (
    ctx: import("../../types.js").IpcContext,
    scratchId: string
  ): Promise<ScratchSaveAsProjectResult> => {
    if (typeof scratchId !== "string" || !scratchId) {
      throw new Error("Invalid scratch ID");
    }

    const scratch = scratchStore.getScratchById(scratchId);
    if (!scratch) {
      throw new Error(`Scratch not found: ${scratchId}`);
    }

    const senderWindow = getWindowForWebContents(ctx.event.sender);
    const dialogOpts: Electron.OpenDialogOptions = {
      title: "Save scratch as project",
      buttonLabel: "Save here",
      properties: ["openDirectory", "createDirectory"],
    };
    const result = senderWindow
      ? await dialog.showOpenDialog(senderWindow, dialogOpts)
      : await dialog.showOpenDialog(dialogOpts);

    if (result.canceled || result.filePaths.length === 0) {
      return { status: "cancelled" };
    }

    const destinationPath = result.filePaths[0]!;
    if (!path.isAbsolute(destinationPath)) {
      throw new Error("Destination path must be absolute");
    }

    // Refuse if the user picked the scratch directory itself or a path inside
    // the scratch — `fs.cp` would recurse into the destination it's writing.
    const normalizedScratch = path.resolve(scratch.path);
    const normalizedDest = path.resolve(destinationPath);
    if (
      normalizedDest === normalizedScratch ||
      normalizedDest.startsWith(normalizedScratch + path.sep)
    ) {
      throw new Error("Destination cannot be inside the scratch folder");
    }

    // Reject pre-existing non-empty destinations so we never silently merge
    // the scratch contents into another project. The dialog's `createDirectory`
    // option lets users make a fresh folder right from the picker.
    try {
      const entries = await fs.readdir(destinationPath);
      if (entries.length > 0) {
        throw new Error("Destination folder is not empty. Choose an empty folder.");
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
      // ENOENT means the dir doesn't exist; fs.cp will create it.
    }

    try {
      await fs.cp(scratch.path, destinationPath, {
        recursive: true,
        preserveTimestamps: true,
        errorOnExist: false,
      });
    } catch (error) {
      logError(
        `[IPC] scratch:save-as-project: copy failed for ${scratchId} -> ${destinationPath}`,
        error
      );
      throw error;
    }

    const project = await addProjectByPath(destinationPath);
    return { status: "saved", project, destinationPath };
  };
  handlers.push(typedHandleWithContext(CHANNELS.SCRATCH_SAVE_AS_PROJECT, handleSaveAsProject));

  return () => handlers.forEach((cleanup) => cleanup());
}
