import { ipcMain, dialog } from "electron";
import { getWindowForWebContents } from "../../window/webContentsRegistry.js";
import { distributePortsToView } from "../../window/portDistribution.js";
import path from "path";
import { CHANNELS } from "../channels.js";
import { projectStore } from "../../services/ProjectStore.js";
import { runCommandDetector } from "../../services/RunCommandDetector.js";
import { ProjectSwitchService } from "../../services/ProjectSwitchService.js";
import { broadcastToRenderer, sendToRenderer } from "../utils.js";
import type { HandlerDependencies } from "../types.js";
import type { Project, ProjectSettings } from "../../types/index.js";
import type {
  BulkProjectStats,
  ProjectSwitchOutgoingState,
} from "../../../shared/types/ipc/project.js";
import { sanitizeTerminals, sanitizeTerminalSizes, sanitizeDraftInputs } from "./terminalLayout.js";
import { sanitizeTabGroups } from "../../schemas/index.js";
import type { TabGroup } from "../../../shared/types/panel.js";
import { ProjectStatsService } from "../../services/ProjectStatsService.js";
import type {
  GitInitOptions,
  GitInitResult,
  GitInitProgressEvent,
} from "../../../shared/types/ipc/gitInit.js";
import type {
  CloneRepoOptions,
  CloneRepoResult,
  CloneRepoProgressEvent,
} from "../../../shared/types/ipc/gitClone.js";
import { createHardenedGit, createAuthenticatedGit } from "../../utils/hardenedGit.js";

let projectStatsServiceInstance: ProjectStatsService | null = null;

export function getProjectStatsService(): ProjectStatsService | null {
  return projectStatsServiceInstance;
}

export function registerProjectCrudHandlers(deps: HandlerDependencies): () => void {
  const mainWindow = deps.windowRegistry?.getPrimary()?.browserWindow ?? deps.mainWindow;
  const handlers: Array<() => void> = [];

  const projectSwitchService = deps.projectSwitchService ?? new ProjectSwitchService(deps);

  const projectStatsService = new ProjectStatsService(deps.ptyClient);
  projectStatsServiceInstance = projectStatsService;
  projectStatsService.start();
  handlers.push(() => {
    projectStatsService.stop();
    projectStatsServiceInstance = null;
  });

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
    return await projectStore.addProject(projectPath);
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
            `[IPC] project:update: failed to sync .canopy/project.json for ${projectId}:`,
            err
          );
        });
    }
    return updated;
  };
  ipcMain.handle(CHANNELS.PROJECT_UPDATE, handleProjectUpdate);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_UPDATE));

  const handleProjectSwitch = async (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string,
    outgoingState?: ProjectSwitchOutgoingState
  ) => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }

    const project = projectStore.getProjectById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    // Pre-apply the renderer's outgoing terminal state to the current project's
    // persisted state BEFORE the switch runs.
    const previousProjectId = projectStore.getCurrentProjectId();
    if (outgoingState && previousProjectId) {
      const validTerminals = outgoingState.terminals
        ? sanitizeTerminals(
            outgoingState.terminals,
            `project:switch/pre-apply(${previousProjectId})`
          )
        : undefined;
      const validSizes = outgoingState.terminalSizes
        ? sanitizeTerminalSizes(outgoingState.terminalSizes as Record<string, unknown>)
        : undefined;
      const validDrafts = outgoingState.draftInputs
        ? sanitizeDraftInputs(outgoingState.draftInputs as Record<string, unknown>)
        : undefined;
      const validTabGroups =
        outgoingState.tabGroups !== undefined
          ? (sanitizeTabGroups(
              outgoingState.tabGroups,
              `project:switch/pre-apply(${previousProjectId})`
            ) as TabGroup[])
          : undefined;
      const existing = await projectStore.getProjectState(previousProjectId);
      await projectStore.saveProjectState(previousProjectId, {
        ...(existing ?? { projectId: previousProjectId, sidebarWidth: 350, terminals: [] }),
        projectId: previousProjectId,
        ...(validTerminals !== undefined && { terminals: validTerminals }),
        ...(validSizes !== undefined && { terminalSizes: validSizes }),
        ...(validDrafts !== undefined && { draftInputs: validDrafts }),
        ...(validTabGroups !== undefined && { tabGroups: validTabGroups }),
        activeWorktreeId: outgoingState.activeWorktreeId,
      });
    }

    const senderWindowForPvm = getWindowForWebContents(_event.sender);
    const pvmCtx = senderWindowForPvm
      ? deps.windowRegistry?.getByWindowId(senderWindowForPvm.id)
      : undefined;
    const pvm = pvmCtx?.services?.projectViewManager ?? deps.projectViewManager;
    if (pvm) {
      // Multi-view path: swap WebContentsViews instead of resetting stores
      const { view, isNew } = await pvm.switchTo(projectId, project.path);

      // Update the main process global state
      await projectStore.setCurrentProject(projectId);

      // Always call loadProject so the WorkspaceClient's windowToProject
      // mapping points to the correct project.  Without this, reactivating a
      // cached view leaves the mapping pointing at the *previous* project,
      // causing sendToEntryWindows to route the old project's IPC events to
      // the newly-active view (cross-project worktree contamination).
      if (deps.worktreeService) {
        const senderWindow = getWindowForWebContents(_event.sender);
        const windowId = senderWindow?.id ?? deps.mainWindow?.id;
        if (windowId !== undefined) {
          try {
            await deps.worktreeService.loadProject(project.path, windowId);

            // Always attach a direct MessagePort.  For new views this is the
            // first port; for cached views it re-establishes the relay after a
            // potential host recreation (CLEANUP_GRACE_MS expiry).
            if (!view.webContents.isDestroyed()) {
              deps.worktreeService.attachDirectPort(windowId, view.webContents);

              // Broker new worktree port (Phase 1)
              const host = deps.worktreeService.getHostForProject(project.path);
              if (host && deps.worktreePortBroker) {
                deps.worktreePortBroker.brokerPort(host, view.webContents);
              }
            }
          } catch (err) {
            console.error("[ProjectSwitch] Failed to load worktrees:", err);
          }
        }

        // Register the new view's webContents in WindowRegistry
        if (isNew && deps.windowRegistry && senderWindow) {
          deps.windowRegistry.registerAppViewWebContents(senderWindow.id, view.webContents.id);
        }
      }

      // Notify PTY host of the active project and distribute a fresh
      // MessagePort to the new/reactivated view so terminal data flows.
      {
        const senderWindow = getWindowForWebContents(_event.sender);
        const windowId = senderWindow?.id ?? deps.mainWindow?.id;
        if (windowId !== undefined) {
          if (deps.ptyClient) {
            deps.ptyClient.onProjectSwitch(windowId, projectId);
          }

          // Distribute PTY MessagePort to the switched-to view
          const win = senderWindow ?? deps.mainWindow;
          if (win && deps.windowRegistry && !view.webContents.isDestroyed()) {
            const ctx = deps.windowRegistry.getByWindowId(win.id);
            if (ctx) {
              distributePortsToView(win, ctx, view.webContents, deps.ptyClient ?? null);
            }
          }
        }
      }

      return project;
    }

    // Fallback: legacy single-view switch path
    return await projectSwitchService.switchProject(projectId);
  };
  ipcMain.handle(CHANNELS.PROJECT_SWITCH, handleProjectSwitch);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_SWITCH));

  const handleProjectOpenDialog = async () => {
    const dialogOpts = {
      properties: ["openDirectory" as const, "createDirectory" as const],
      title: "Open Git Repository",
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, dialogOpts)
      : await dialog.showOpenDialog(dialogOpts);

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  };
  ipcMain.handle(CHANNELS.PROJECT_OPEN_DIALOG, handleProjectOpenDialog);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_OPEN_DIALOG));

  const handleProjectGetSettings = async (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string
  ): Promise<ProjectSettings> => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    return projectStore.getProjectSettings(projectId);
  };
  ipcMain.handle(CHANNELS.PROJECT_GET_SETTINGS, handleProjectGetSettings);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_GET_SETTINGS));

  const handleProjectSaveSettings = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: { projectId: string; settings: ProjectSettings }
  ): Promise<void> => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload");
    }
    const { projectId, settings } = payload;
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    if (!settings || typeof settings !== "object") {
      throw new Error("Invalid settings object");
    }
    const previousSettings = await projectStore.getProjectSettings(projectId);
    await projectStore.saveProjectSettings(projectId, settings);
    const project = projectStore.getProjectById(projectId);
    if (project?.inRepoSettings) {
      await projectStore.writeInRepoSettings(project.path, settings);
    }
    if (settings.githubRemote !== previousSettings.githubRemote) {
      const { clearGitHubCaches } = await import("../../services/GitHubService.js");
      clearGitHubCaches();
    }
  };
  ipcMain.handle(CHANNELS.PROJECT_SAVE_SETTINGS, handleProjectSaveSettings);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_SAVE_SETTINGS));

  const handleProjectDetectRunners = async (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string
  ) => {
    if (typeof projectId !== "string" || !projectId) {
      console.warn("[IPC] Invalid project ID for detect runners:", projectId);
      return [];
    }

    const project = projectStore.getProjectById(projectId);
    if (!project) {
      console.warn(`[IPC] Project not found for detect runners: ${projectId}`);
      return [];
    }

    return await runCommandDetector.detect(project.path);
  };
  ipcMain.handle(CHANNELS.PROJECT_DETECT_RUNNERS, handleProjectDetectRunners);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_DETECT_RUNNERS));

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

  const handleProjectReopen = async (
    event: Electron.IpcMainInvokeEvent,
    projectId: string,
    outgoingState?: ProjectSwitchOutgoingState
  ) => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }

    console.log(`[IPC] project:reopen: ${projectId}`);

    const project = projectStore.getProjectById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    if (project.status !== "background" && project.status !== "active") {
      throw new Error(
        `Cannot reopen project ${projectId} unless status is "background" or "active" (current: ${project.status ?? "unset"})`
      );
    }

    // Pre-apply outgoing terminal state
    const previousProjectId = projectStore.getCurrentProjectId();
    if (outgoingState && previousProjectId && previousProjectId !== projectId) {
      const validTerminals = outgoingState.terminals
        ? sanitizeTerminals(
            outgoingState.terminals,
            `project:reopen/pre-apply(${previousProjectId})`
          )
        : undefined;
      const validSizes = outgoingState.terminalSizes
        ? sanitizeTerminalSizes(outgoingState.terminalSizes as Record<string, unknown>)
        : undefined;
      const validDrafts = outgoingState.draftInputs
        ? sanitizeDraftInputs(outgoingState.draftInputs as Record<string, unknown>)
        : undefined;
      const validTabGroups =
        outgoingState.tabGroups !== undefined
          ? (sanitizeTabGroups(
              outgoingState.tabGroups,
              `project:reopen/pre-apply(${previousProjectId})`
            ) as TabGroup[])
          : undefined;
      const existing = await projectStore.getProjectState(previousProjectId);
      await projectStore.saveProjectState(previousProjectId, {
        ...(existing ?? { projectId: previousProjectId, sidebarWidth: 350, terminals: [] }),
        projectId: previousProjectId,
        ...(validTerminals !== undefined && { terminals: validTerminals }),
        ...(validSizes !== undefined && { terminalSizes: validSizes }),
        ...(validDrafts !== undefined && { draftInputs: validDrafts }),
        ...(validTabGroups !== undefined && { tabGroups: validTabGroups }),
        activeWorktreeId: outgoingState.activeWorktreeId,
      });
    }

    const senderWindowForPvm = getWindowForWebContents(event.sender);
    const pvmCtx = senderWindowForPvm
      ? deps.windowRegistry?.getByWindowId(senderWindowForPvm.id)
      : undefined;
    const pvm = pvmCtx?.services?.projectViewManager ?? deps.projectViewManager;
    if (pvm) {
      // Multi-view path: swap views
      const { view, isNew } = await pvm.switchTo(projectId, project.path);
      await projectStore.setCurrentProject(projectId);
      projectStore.updateProjectStatus(projectId, "active");

      // Resume workspace host before loading project
      if (deps.worktreeService) {
        deps.worktreeService.resumeProject(project.path);
      }

      // Always call loadProject — see comment in handleProjectSwitch above.
      if (deps.worktreeService) {
        const senderWindow = getWindowForWebContents(event.sender);
        const windowId = senderWindow?.id ?? deps.mainWindow?.id;
        if (windowId !== undefined) {
          try {
            await deps.worktreeService.loadProject(project.path, windowId);

            if (!view.webContents.isDestroyed()) {
              deps.worktreeService.attachDirectPort(windowId, view.webContents);

              // Broker new worktree port (Phase 1)
              const host = deps.worktreeService.getHostForProject(project.path);
              if (host && deps.worktreePortBroker) {
                deps.worktreePortBroker.brokerPort(host, view.webContents);
              }
            }
          } catch (err) {
            console.error("[ProjectReopen] Failed to load worktrees:", err);
          }
        }

        if (isNew && deps.windowRegistry && senderWindow) {
          deps.windowRegistry.registerAppViewWebContents(senderWindow.id, view.webContents.id);
        }
      }

      // Notify PTY host of the active project and distribute a fresh MessagePort
      {
        const senderWindow = getWindowForWebContents(event.sender);
        const windowId = senderWindow?.id ?? deps.mainWindow?.id;
        if (windowId !== undefined) {
          if (deps.ptyClient) {
            deps.ptyClient.onProjectSwitch(windowId, projectId);
          }

          const win = senderWindow ?? deps.mainWindow;
          if (win && deps.windowRegistry && !view.webContents.isDestroyed()) {
            const ctx = deps.windowRegistry.getByWindowId(win.id);
            if (ctx) {
              distributePortsToView(win, ctx, view.webContents, deps.ptyClient ?? null);
            }
          }
        }
      }

      return project;
    }

    // Fallback: legacy single-view path
    if (deps.worktreeService) {
      deps.worktreeService.resumeProject(project.path);
    }
    return await projectSwitchService.reopenProject(projectId);
  };
  ipcMain.handle(CHANNELS.PROJECT_REOPEN, handleProjectReopen);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_REOPEN));

  const handleProjectGetStats = async (_event: Electron.IpcMainInvokeEvent, projectId: string) => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }

    const ptyStats = await deps.ptyClient!.getProjectStats(projectId);

    const MEMORY_PER_TERMINAL_MB = 50;

    const estimatedMemoryMB = ptyStats.terminalCount * MEMORY_PER_TERMINAL_MB;

    return {
      processCount: ptyStats.terminalCount,
      terminalCount: ptyStats.terminalCount,
      estimatedMemoryMB,
      terminalTypes: ptyStats.terminalTypes,
      processIds: ptyStats.processIds,
    };
  };
  ipcMain.handle(CHANNELS.PROJECT_GET_STATS, handleProjectGetStats);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_GET_STATS));

  const handleProjectGetBulkStats = async (
    _event: Electron.IpcMainInvokeEvent,
    projectIds: string[]
  ): Promise<BulkProjectStats> => {
    if (!Array.isArray(projectIds)) {
      throw new Error("Invalid projectIds: must be an array");
    }

    const uniqueIds = [...new Set(projectIds.filter((id) => typeof id === "string" && id))];
    const MEMORY_PER_TERMINAL_MB = 50;

    // Fetch all terminals once and per-project stats in parallel (eliminates N+1 per-terminal IPC)
    const [allTerminals, statsResults] = await Promise.all([
      deps.ptyClient!.getAllTerminalsAsync(),
      Promise.allSettled(
        uniqueIds.map((id) => deps.ptyClient!.getProjectStats(id).then((s) => [id, s] as const))
      ),
    ]);

    // Group agent counts by projectId from the bulk terminal list
    const agentCounts = new Map<string, { active: number; waiting: number }>();
    for (const id of uniqueIds) {
      agentCounts.set(id, { active: 0, waiting: 0 });
    }
    for (const terminal of allTerminals) {
      if (!terminal.projectId) continue;
      const counts = agentCounts.get(terminal.projectId);
      if (!counts) continue;
      if (terminal.isTrashed) continue;
      if (terminal.kind === "dev-preview") continue;
      if (terminal.hasPty === false) continue;
      if (terminal.kind !== "agent" && !terminal.agentId) continue;

      if (terminal.agentState === "waiting") {
        counts.waiting += 1;
      } else if (terminal.agentState === "working" || terminal.agentState === "running") {
        counts.active += 1;
      }
    }

    const result: BulkProjectStats = {};
    for (const entry of statsResults) {
      if (entry.status === "fulfilled") {
        const [id, ptyStats] = entry.value;
        const counts = agentCounts.get(id) ?? { active: 0, waiting: 0 };
        result[id] = {
          processCount: ptyStats.terminalCount,
          terminalCount: ptyStats.terminalCount,
          estimatedMemoryMB: ptyStats.terminalCount * MEMORY_PER_TERMINAL_MB,
          terminalTypes: ptyStats.terminalTypes,
          processIds: ptyStats.processIds,
          activeAgentCount: counts.active,
          waitingAgentCount: counts.waiting,
        };
      }
    }
    return result;
  };
  ipcMain.handle(CHANNELS.PROJECT_GET_BULK_STATS, handleProjectGetBulkStats);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_GET_BULK_STATS));

  const handleProjectCreateFolder = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: { parentPath: string; folderName: string }
  ): Promise<string> => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload");
    }
    const { parentPath, folderName } = payload;
    if (typeof parentPath !== "string" || !parentPath.trim()) {
      throw new Error("Invalid parent path");
    }
    if (typeof folderName !== "string" || !folderName.trim()) {
      throw new Error("Folder name is required");
    }
    if (!path.isAbsolute(parentPath)) {
      throw new Error("Parent path must be absolute");
    }

    const trimmed = folderName.trim();

    if (trimmed.includes("/") || trimmed.includes("\\") || trimmed === ".." || trimmed === ".") {
      throw new Error("Folder name must not contain path separators or dot segments");
    }

    const fs = await import("fs");

    try {
      const parentStat = await fs.promises.stat(parentPath);
      if (!parentStat.isDirectory()) {
        throw new Error("Parent path is not a directory");
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new Error("Parent directory does not exist");
      }
      throw err;
    }

    const fullPath = path.join(parentPath, trimmed);

    const normalizedParent = path.resolve(parentPath);
    const normalizedFull = path.resolve(fullPath);
    if (!normalizedFull.startsWith(normalizedParent + path.sep)) {
      throw new Error("Folder name resolves outside of the parent directory");
    }

    try {
      await fs.promises.mkdir(fullPath, { recursive: false });
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        throw new Error(`Folder "${trimmed}" already exists in this location`);
      }
      if (code === "EACCES" || code === "EPERM") {
        throw new Error("Permission denied: cannot create folder in this location");
      }
      if (code === "ENOSPC") {
        throw new Error("Not enough disk space to create the folder");
      }
      throw err;
    }
    return fullPath;
  };
  ipcMain.handle(CHANNELS.PROJECT_CREATE_FOLDER, handleProjectCreateFolder);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_CREATE_FOLDER));

  const handleProjectInitGit = async (
    _event: Electron.IpcMainInvokeEvent,
    directoryPath: string
  ): Promise<void> => {
    if (typeof directoryPath !== "string" || !directoryPath) {
      throw new Error("Invalid directory path");
    }
    if (!path.isAbsolute(directoryPath)) {
      throw new Error("Project path must be absolute");
    }

    const fs = await import("fs");
    const stats = await fs.promises.stat(directoryPath);
    if (!stats.isDirectory()) {
      throw new Error("Path is not a directory");
    }

    const git = createHardenedGit(directoryPath);
    await git.init();
  };
  ipcMain.handle(CHANNELS.PROJECT_INIT_GIT, handleProjectInitGit);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_INIT_GIT));

  const handleProjectInitGitGuided = async (
    event: Electron.IpcMainInvokeEvent,
    options: GitInitOptions
  ): Promise<GitInitResult> => {
    if (!options || typeof options !== "object") {
      throw new Error("Invalid options object");
    }

    const senderWindow = getWindowForWebContents(event.sender);

    const {
      directoryPath,
      createInitialCommit = true,
      initialCommitMessage = "Initial commit",
      createGitignore = true,
      gitignoreTemplate = "node",
    } = options;

    if (typeof directoryPath !== "string" || !directoryPath) {
      throw new Error("Invalid directory path");
    }
    if (!path.isAbsolute(directoryPath)) {
      throw new Error("Project path must be absolute");
    }

    const completedSteps: GitInitProgressEvent["step"][] = [];

    const emitProgress = (
      step: GitInitProgressEvent["step"],
      status: GitInitProgressEvent["status"],
      message: string,
      error?: string
    ) => {
      const progressEvent: GitInitProgressEvent = {
        step,
        status,
        message,
        error,
        timestamp: Date.now(),
      };
      if (senderWindow && !senderWindow.isDestroyed()) {
        sendToRenderer(senderWindow, CHANNELS.PROJECT_INIT_GIT_PROGRESS, progressEvent);
      } else {
        broadcastToRenderer(CHANNELS.PROJECT_INIT_GIT_PROGRESS, progressEvent);
      }
    };

    try {
      const fs = await import("fs");
      const stats = await fs.promises.stat(directoryPath);
      if (!stats.isDirectory()) {
        throw new Error("Path is not a directory");
      }

      const git = createHardenedGit(directoryPath);

      emitProgress("init", "start", "Initializing Git repository...");
      await git.init();
      completedSteps.push("init");
      emitProgress("init", "success", "Git repository initialized");

      if (createGitignore && gitignoreTemplate !== "none") {
        emitProgress("gitignore", "start", "Creating .gitignore file...");
        const gitignoreContent = getGitignoreTemplate(gitignoreTemplate);
        if (!gitignoreContent) {
          emitProgress(
            "gitignore",
            "error",
            "Invalid gitignore template",
            `Unknown template: ${gitignoreTemplate}`
          );
          throw new Error(`Invalid gitignore template: ${gitignoreTemplate}`);
        }
        const gitignorePath = path.join(directoryPath, ".gitignore");
        const gitignoreExists = await fs.promises
          .access(gitignorePath)
          .then(() => true)
          .catch(() => false);
        if (gitignoreExists) {
          completedSteps.push("gitignore");
          emitProgress("gitignore", "success", "Skipping .gitignore (already exists)");
        } else {
          await fs.promises.writeFile(gitignorePath, gitignoreContent, "utf-8");
          completedSteps.push("gitignore");
          emitProgress("gitignore", "success", ".gitignore file created");
        }
      }

      if (createInitialCommit) {
        emitProgress("add", "start", "Staging files for initial commit...");
        await git.add(".");
        completedSteps.push("add");
        emitProgress("add", "success", "Files staged");

        emitProgress("commit", "start", "Creating initial commit...");
        try {
          await git.commit(initialCommitMessage);
          completedSteps.push("commit");
          emitProgress("commit", "success", `Committed: ${initialCommitMessage}`);
        } catch (commitError) {
          const errorMsg = commitError instanceof Error ? commitError.message : String(commitError);
          if (errorMsg.includes("user.email") || errorMsg.includes("user.name")) {
            emitProgress(
              "commit",
              "error",
              "Git user identity not configured",
              "Please configure git user.name and user.email before creating commits"
            );
            emitProgress("complete", "success", "Git initialization complete (no initial commit)");
            return {
              success: true,
              completedSteps,
            };
          }
          throw commitError;
        }
      }

      emitProgress("complete", "success", "Git initialization complete");
      return { success: true, completedSteps };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      emitProgress("error", "error", "Git initialization failed", errorMessage);
      return {
        success: false,
        error: errorMessage,
        completedSteps,
      };
    }
  };

  function getGitignoreTemplate(template: string): string | null {
    switch (template) {
      case "node":
        return `# Node.js
node_modules/
npm-debug.log*
yarn-debug.log*
yarn-error.log*
.npm
.yarn
.pnp.*

# Environment
.env
.env.local
.env.*.local

# Build outputs
dist/
build/
out/
.next/
.nuxt/

# OS
.DS_Store
Thumbs.db

# IDE
.vscode/
.idea/
*.swp
*.swo
*~
`;
      case "python":
        return `# Python
__pycache__/
*.py[cod]
*$py.class
*.so
.Python
env/
venv/
ENV/
.venv

# Distribution
build/
dist/
*.egg-info/

# Testing
.pytest_cache/
.coverage
htmlcov/

# OS
.DS_Store
Thumbs.db

# IDE
.vscode/
.idea/
*.swp
`;
      case "minimal":
        return `# OS
.DS_Store
Thumbs.db

# IDE
.vscode/
.idea/
*.swp
`;
      default:
        return null;
    }
  }

  ipcMain.handle(CHANNELS.PROJECT_INIT_GIT_GUIDED, handleProjectInitGitGuided);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_INIT_GIT_GUIDED));

  let cloneAbortController: AbortController | null = null;

  const handleProjectCloneRepo = async (
    event: Electron.IpcMainInvokeEvent,
    options: CloneRepoOptions
  ): Promise<CloneRepoResult> => {
    if (!options || typeof options !== "object") {
      throw new Error("Invalid options object");
    }

    const senderWindow = getWindowForWebContents(event.sender);

    const { url, parentPath, folderName, shallowClone } = options;

    if (typeof url !== "string" || !url.trim()) {
      throw new Error("Repository URL is required");
    }
    if (!/^https?:\/\//i.test(url) && !/^git@/i.test(url)) {
      throw new Error("Only HTTP(S) and SSH (git@) URLs are supported");
    }
    if (typeof parentPath !== "string" || !parentPath.trim()) {
      throw new Error("Parent path is required");
    }
    if (!path.isAbsolute(parentPath)) {
      throw new Error("Parent path must be absolute");
    }
    if (typeof folderName !== "string" || !folderName.trim()) {
      throw new Error("Folder name is required");
    }

    const trimmedFolder = folderName.trim();
    if (
      trimmedFolder.includes("/") ||
      trimmedFolder.includes("\\") ||
      trimmedFolder === ".." ||
      trimmedFolder === "."
    ) {
      throw new Error("Folder name must not contain path separators or dot segments");
    }

    const targetPath = path.join(parentPath, trimmedFolder);
    const normalizedParent = path.resolve(parentPath);
    const normalizedTarget = path.resolve(targetPath);
    if (!normalizedTarget.startsWith(normalizedParent + path.sep)) {
      throw new Error("Folder name resolves outside of the parent directory");
    }

    const fs = await import("fs");

    try {
      const parentStat = await fs.promises.stat(parentPath);
      if (!parentStat.isDirectory()) {
        throw new Error("Parent path is not a directory");
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new Error("Parent directory does not exist", { cause: err });
      }
      throw err;
    }

    const targetExists = await fs.promises
      .access(targetPath)
      .then(() => true)
      .catch(() => false);
    if (targetExists) {
      throw new Error(`Folder "${trimmedFolder}" already exists in this location`);
    }

    const emitProgress = (stage: string, progress: number, message: string) => {
      const progressEvent: CloneRepoProgressEvent = {
        stage,
        progress,
        message,
        timestamp: Date.now(),
      };
      if (senderWindow && !senderWindow.isDestroyed()) {
        sendToRenderer(senderWindow, CHANNELS.PROJECT_CLONE_PROGRESS, progressEvent);
      } else {
        broadcastToRenderer(CHANNELS.PROJECT_CLONE_PROGRESS, progressEvent);
      }
    };

    cloneAbortController = new AbortController();

    try {
      emitProgress("starting", 0, "Starting clone...");

      const git = createAuthenticatedGit(parentPath, {
        signal: cloneAbortController.signal,
        progress({ stage, progress }) {
          emitProgress(stage, progress, `${stage}: ${progress}%`);
        },
        extraConfig: ["transfer.bundleURI=false"],
      });

      git.env({ ...process.env, GIT_TERMINAL_PROMPT: "0" });

      await git.clone(url, trimmedFolder, shallowClone ? ["--depth", "1"] : []);

      emitProgress("complete", 100, "Clone complete");
      return { success: true, clonedPath: targetPath };
    } catch (error) {
      const wasCancelled =
        cloneAbortController?.signal.aborted ||
        (error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.message)));

      // Clean up partial clone
      const partialExists = await fs.promises
        .access(targetPath)
        .then(() => true)
        .catch(() => false);
      if (partialExists) {
        await fs.promises.rm(targetPath, { recursive: true, force: true }).catch(() => {});
      }

      if (wasCancelled) {
        emitProgress("cancelled", 0, "Clone cancelled");
        return { success: false, cancelled: true, error: "Clone cancelled" };
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      emitProgress("error", 0, `Clone failed: ${errorMessage}`);
      return { success: false, error: errorMessage };
    } finally {
      cloneAbortController = null;
    }
  };
  ipcMain.handle(CHANNELS.PROJECT_CLONE_REPO, handleProjectCloneRepo);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_CLONE_REPO));

  const handleProjectCloneCancel = async (_event: Electron.IpcMainInvokeEvent): Promise<void> => {
    if (cloneAbortController) {
      cloneAbortController.abort();
    }
  };
  ipcMain.handle(CHANNELS.PROJECT_CLONE_CANCEL, handleProjectCloneCancel);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_CLONE_CANCEL));

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
