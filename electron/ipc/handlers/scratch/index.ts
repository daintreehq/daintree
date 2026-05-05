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
import type { WebContentsView } from "electron";
import { CHANNELS } from "../../channels.js";
import { broadcastToRenderer, typedHandle, typedHandleWithContext } from "../../utils.js";
import { getWindowForWebContents } from "../../../window/webContentsRegistry.js";
import { distributePortsToView } from "../../../window/portDistribution.js";
import { scratchStore } from "../../../services/ScratchStore.js";
import { projectStore } from "../../../services/ProjectStore.js";
import type { HandlerDependencies } from "../../types.js";
import type { Scratch } from "../../../../shared/types/scratch.js";

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

  return () => handlers.forEach((cleanup) => cleanup());
}
