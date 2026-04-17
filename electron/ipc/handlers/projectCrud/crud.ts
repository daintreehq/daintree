import { ipcMain, dialog } from "electron";
import path from "path";
import { CHANNELS } from "../../channels.js";
import { getWindowForWebContents } from "../../../window/webContentsRegistry.js";
import { projectStore } from "../../../services/ProjectStore.js";
import { broadcastToRenderer } from "../../utils.js";
import type { HandlerDependencies } from "../../types.js";
import type { Project } from "../../../types/index.js";

export function registerProjectCrudCoreHandlers(deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const handleProjectGetAll = async () => {
    return projectStore.getAllProjects();
  };
  ipcMain.handle(CHANNELS.PROJECT_GET_ALL, handleProjectGetAll);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_GET_ALL));

  const handleProjectGetCurrent = async (event: Electron.IpcMainInvokeEvent) => {
    // Multi-view: resolve the project from the sender's view
    const senderWinForPvm = getWindowForWebContents(event.sender);
    const pvmCtx = senderWinForPvm
      ? deps.windowRegistry?.getByWindowId(senderWinForPvm.id)
      : undefined;
    const pvm = pvmCtx?.services?.projectViewManager ?? deps.projectViewManager;
    if (pvm) {
      const viewProjectId = pvm.getProjectIdForWebContents(event.sender.id);
      if (viewProjectId) {
        const project = projectStore.getProjectById(viewProjectId);
        if (project) return project;
      }
    }

    // Fallback: global current project
    const currentProject = projectStore.getCurrentProject();

    if (currentProject && deps.worktreeService) {
      const senderWindow = getWindowForWebContents(event.sender);
      const windowId = senderWindow?.id ?? deps.mainWindow?.id;
      try {
        if (windowId !== undefined) {
          await deps.worktreeService.loadProject(currentProject.path, windowId);
        }
      } catch (err) {
        console.error("Failed to load worktrees for current project:", err);
      }
    }

    return currentProject;
  };
  ipcMain.handle(CHANNELS.PROJECT_GET_CURRENT, handleProjectGetCurrent);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_GET_CURRENT));

  const handleProjectAdd = async (_event: Electron.IpcMainInvokeEvent, projectPath: string) => {
    if (typeof projectPath !== "string" || !projectPath) {
      throw new Error("Invalid project path");
    }
    if (!path.isAbsolute(projectPath)) {
      throw new Error("Project path must be absolute");
    }
    const project = await projectStore.addProject(projectPath);
    // Notify all renderers so the project list stays in sync across views.
    broadcastToRenderer(CHANNELS.PROJECT_UPDATED, project);
    return project;
  };
  ipcMain.handle(CHANNELS.PROJECT_ADD, handleProjectAdd);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_ADD));

  const handleProjectRemove = async (_event: Electron.IpcMainInvokeEvent, projectId: string) => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }

    if (deps.ptyClient) {
      await deps.ptyClient.killByProject(projectId).catch((err: unknown) => {
        console.error(`[IPC] project:remove: Failed to kill terminals for ${projectId}:`, err);
      });
    }

    await projectStore.removeProject(projectId);
    // Notify all renderers so the project list stays in sync across views.
    broadcastToRenderer(CHANNELS.PROJECT_REMOVED, projectId);
  };
  ipcMain.handle(CHANNELS.PROJECT_REMOVE, handleProjectRemove);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_REMOVE));

  const handleProjectUpdate = async (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string,
    updates: Partial<Project>
  ) => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    if (typeof updates !== "object" || updates === null) {
      throw new Error("Invalid updates object");
    }
    // Strip control-plane and internal scoring fields
    const {
      inRepoSettings: _inRepo,
      frecencyScore: _fs,
      lastAccessedAt: _lat,
      ...safeUpdates
    } = updates;
    const updated = projectStore.updateProject(projectId, safeUpdates);
    // Notify all renderers so other project views (e.g., a newly-created
    // project view while the onboarding wizard is still running in the
    // originating welcome view) refresh their cached project data.
    broadcastToRenderer(CHANNELS.PROJECT_UPDATED, updated);
    if (
      updated.inRepoSettings &&
      (updates.name !== undefined || updates.emoji !== undefined || "color" in updates)
    ) {
      projectStore
        .writeInRepoProjectIdentity(updated.path, {
          name: updated.name,
          emoji: updated.emoji,
          color: updated.color,
        })
        .catch((err) => {
          console.warn(
            `[IPC] project:update: failed to sync .daintree/project.json for ${projectId}:`,
            err
          );
        });
    }
    return updated;
  };
  ipcMain.handle(CHANNELS.PROJECT_UPDATE, handleProjectUpdate);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_UPDATE));

  const handleProjectOpenDialog = async (event: Electron.IpcMainInvokeEvent) => {
    const senderWindow = getWindowForWebContents(event.sender);
    const dialogOpts = {
      properties: ["openDirectory" as const, "createDirectory" as const],
      title: "Open Git Repository",
    };
    const result = senderWindow
      ? await dialog.showOpenDialog(senderWindow, dialogOpts)
      : await dialog.showOpenDialog(dialogOpts);

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  };
  ipcMain.handle(CHANNELS.PROJECT_OPEN_DIALOG, handleProjectOpenDialog);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_OPEN_DIALOG));

  const handleProjectClose = async (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string,
    options?: { killTerminals?: boolean }
  ) => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }

    const killTerminals = options?.killTerminals ?? false;
    console.log(`[IPC] project:close: ${projectId} (killTerminals: ${killTerminals})`);

    const storeActiveProjectId = projectStore.getCurrentProjectId();

    if (projectId === storeActiveProjectId && !killTerminals) {
      throw new Error("Cannot close the active project. Switch to another project first.");
    }

    const project = projectStore.getProjectById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    if (!killTerminals && project.status === "closed") {
      return { success: true, processesKilled: 0, terminalsKilled: 0 };
    }

    try {
      const ptyStats = await deps.ptyClient!.getProjectStats(projectId);

      if (killTerminals) {
        const terminalsKilled = await deps.ptyClient!.killByProject(projectId);

        await projectStore.clearProjectState(projectId);

        if (projectId === storeActiveProjectId) {
          projectStore.clearCurrentProject();
        }
        projectStore.updateProjectStatus(projectId, "closed");

        console.log(
          `[IPC] project:close: Killed ${terminalsKilled} process(es) ` +
            `(${terminalsKilled} terminals)`
        );

        return {
          success: true,
          processesKilled: terminalsKilled,
          terminalsKilled,
        };
      } else {
        projectStore.updateProjectStatus(projectId, "background");
        if (deps.worktreeService) {
          deps.worktreeService.pauseProject(project.path);
        }

        console.log(
          `[IPC] project:close: Backgrounded project with ${ptyStats.terminalCount} running terminals`
        );

        return {
          success: true,
          processesKilled: 0,
          terminalsKilled: 0,
        };
      }
    } catch (error) {
      console.error(`[IPC] project:close: Failed to close project ${projectId}:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        processesKilled: 0,
        terminalsKilled: 0,
      };
    }
  };
  ipcMain.handle(CHANNELS.PROJECT_CLOSE, handleProjectClose);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_CLOSE));

  const handleProjectCheckMissing = async (
    _event: Electron.IpcMainInvokeEvent
  ): Promise<string[]> => {
    return projectStore.checkMissingProjects();
  };
  ipcMain.handle(CHANNELS.PROJECT_CHECK_MISSING, handleProjectCheckMissing);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_CHECK_MISSING));

  const handleProjectLocate = async (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string
  ): Promise<Project | null> => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    const project = projectStore.getProjectById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const senderWindow = getWindowForWebContents(_event.sender);
    const openOpts: Electron.OpenDialogOptions = {
      title: `Locate "${project.name}"`,
      properties: ["openDirectory"],
      defaultPath: path.dirname(project.path),
    };
    const result = senderWindow
      ? await dialog.showOpenDialog(senderWindow, openOpts)
      : await dialog.showOpenDialog(openOpts);

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const newPath = result.filePaths[0];
    return projectStore.relocateProject(projectId, newPath);
  };
  ipcMain.handle(CHANNELS.PROJECT_LOCATE, handleProjectLocate);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_LOCATE));

  return () => handlers.forEach((cleanup) => cleanup());
}
