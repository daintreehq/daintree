import { dialog } from "electron";
import path from "path";
import { CHANNELS } from "../../channels.js";
import { getWindowForWebContents } from "../../../window/webContentsRegistry.js";
import { projectStore } from "../../../services/ProjectStore.js";
import { broadcastToRenderer, typedHandle, typedHandleWithContext } from "../../utils.js";
import type { HandlerDependencies } from "../../types.js";
import type { Project } from "../../../types/index.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
import { AppError } from "../../../utils/errorTypes.js";

export function registerProjectCrudCoreHandlers(deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const handleProjectGetAll = async () => {
    return projectStore.getAllProjects();
  };
  handlers.push(typedHandle(CHANNELS.PROJECT_GET_ALL, handleProjectGetAll));

  const handleProjectGetCurrent = async (ctx: import("../../types.js").IpcContext) => {
    const senderWinForPvm = getWindowForWebContents(ctx.event.sender);
    const pvmCtx = senderWinForPvm
      ? deps.windowRegistry?.getByWindowId(senderWinForPvm.id)
      : undefined;
    const pvm = pvmCtx?.services?.projectViewManager ?? deps.projectViewManager;
    if (pvm) {
      const viewProjectId = pvm.getProjectIdForWebContents(ctx.event.sender.id);
      if (viewProjectId) {
        const project = projectStore.getProjectById(viewProjectId);
        if (project) return project;
        return null;
      }
      // PVM exists but this WebContents has no binding — an unbound new window.
      // Returning null lets the renderer show the WelcomeScreen instead of inheriting
      // the last-active project (#6015). Skip the worktree side-effect too: no port has
      // been brokered for this view, so the snapshot would be orphaned.
      return null;
    }

    const currentProject = projectStore.getCurrentProject();

    if (currentProject && deps.worktreeService) {
      const senderWindow = getWindowForWebContents(ctx.event.sender);
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
  handlers.push(typedHandleWithContext(CHANNELS.PROJECT_GET_CURRENT, handleProjectGetCurrent));

  const handleProjectAdd = async (projectPath: string) => {
    if (typeof projectPath !== "string" || !projectPath) {
      throw new Error("Invalid project path");
    }
    if (!path.isAbsolute(projectPath)) {
      throw new Error("Project path must be absolute");
    }
    const project = await projectStore.addProject(projectPath);
    broadcastToRenderer(CHANNELS.PROJECT_UPDATED, project);
    return project;
  };
  handlers.push(typedHandle(CHANNELS.PROJECT_ADD, handleProjectAdd));

  const handleProjectRemove = async (projectId: string) => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }

    if (deps.ptyClient) {
      await deps.ptyClient.killByProject(projectId).catch((err: unknown) => {
        console.error(`[IPC] project:remove: Failed to kill terminals for ${projectId}:`, err);
      });
    }

    await projectStore.removeProject(projectId);
    broadcastToRenderer(CHANNELS.PROJECT_REMOVED, projectId);
  };
  handlers.push(typedHandle(CHANNELS.PROJECT_REMOVE, handleProjectRemove));

  const handleProjectUpdate = async (projectId: string, updates: Partial<Project>) => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    if (typeof updates !== "object" || updates === null) {
      throw new Error("Invalid updates object");
    }
    const {
      inRepoSettings: _inRepo,
      frecencyScore: _fs,
      lastAccessedAt: _lat,
      ...safeUpdates
    } = updates;
    const updated = projectStore.updateProject(projectId, safeUpdates);
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
  handlers.push(typedHandle(CHANNELS.PROJECT_UPDATE, handleProjectUpdate));

  const handleProjectOpenDialog = async (ctx: import("../../types.js").IpcContext) => {
    const senderWindow = getWindowForWebContents(ctx.event.sender);
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
  handlers.push(typedHandleWithContext(CHANNELS.PROJECT_OPEN_DIALOG, handleProjectOpenDialog));

  const handleProjectClose = async (projectId: string, options?: { killTerminals?: boolean }) => {
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
      return { processesKilled: 0, terminalsKilled: 0 };
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
          processesKilled: 0,
          terminalsKilled: 0,
        };
      }
    } catch (error) {
      console.error(`[IPC] project:close: Failed to close project ${projectId}:`, error);
      throw new AppError({
        code: "INTERNAL",
        message: formatErrorMessage(error, "Failed to close project"),
        context: { projectId },
        cause: error instanceof Error ? error : undefined,
      });
    }
  };
  handlers.push(typedHandle(CHANNELS.PROJECT_CLOSE, handleProjectClose));

  const handleProjectCheckMissing = async (): Promise<string[]> => {
    return projectStore.checkMissingProjects();
  };
  handlers.push(typedHandle(CHANNELS.PROJECT_CHECK_MISSING, handleProjectCheckMissing));

  const handleProjectLocate = async (
    ctx: import("../../types.js").IpcContext,
    projectId: string
  ): Promise<Project | null> => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    const project = projectStore.getProjectById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const senderWindow = getWindowForWebContents(ctx.event.sender);
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
  handlers.push(typedHandleWithContext(CHANNELS.PROJECT_LOCATE, handleProjectLocate));

  return () => handlers.forEach((cleanup) => cleanup());
}
