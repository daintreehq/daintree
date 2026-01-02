import { ipcMain, dialog, shell } from "electron";
import path from "path";
import os from "os";
import { CHANNELS } from "../channels.js";
import { openExternalUrl } from "../../utils/openExternal.js";
import { projectStore } from "../../services/ProjectStore.js";
import { runCommandDetector } from "../../services/RunCommandDetector.js";
import { ProjectSwitchService } from "../../services/ProjectSwitchService.js";
import type { HandlerDependencies } from "../types.js";
import type {
  SystemOpenExternalPayload,
  SystemOpenPathPayload,
  Project,
  ProjectSettings,
} from "../../types/index.js";

export function registerProjectHandlers(deps: HandlerDependencies): () => void {
  const { mainWindow, worktreeService, cliAvailabilityService } = deps;
  const handlers: Array<() => void> = [];

  const projectSwitchService = new ProjectSwitchService({
    mainWindow: deps.mainWindow,
    ptyClient: deps.ptyClient,
    worktreeService: deps.worktreeService,
    eventBuffer: deps.eventBuffer,
  });

  const handleSystemOpenExternal = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: SystemOpenExternalPayload
  ) => {
    console.log("[IPC] system:open-external called with:", payload.url);
    try {
      await openExternalUrl(payload.url);
      console.log("[IPC] system:open-external completed successfully");
    } catch (error) {
      console.error("[IPC] Failed to open external URL:", error);
      throw error;
    }
  };
  ipcMain.handle(CHANNELS.SYSTEM_OPEN_EXTERNAL, handleSystemOpenExternal);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SYSTEM_OPEN_EXTERNAL));

  const handleSystemOpenPath = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: SystemOpenPathPayload
  ) => {
    const fs = await import("fs");
    const path = await import("path");

    try {
      if (!path.isAbsolute(payload.path)) {
        throw new Error("Only absolute paths are allowed");
      }
      await fs.promises.access(payload.path);
      await shell.openPath(payload.path);
    } catch (error) {
      console.error("Failed to open path:", error);
      throw error;
    }
  };
  ipcMain.handle(CHANNELS.SYSTEM_OPEN_PATH, handleSystemOpenPath);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SYSTEM_OPEN_PATH));

  const handleSystemCheckCommand = async (
    _event: Electron.IpcMainInvokeEvent,
    command: string
  ): Promise<boolean> => {
    if (typeof command !== "string" || !command.trim()) {
      return false;
    }

    if (!/^[a-zA-Z0-9._-]+$/.test(command)) {
      console.warn(`Command "${command}" contains invalid characters, rejecting`);
      return false;
    }

    try {
      const { execFileSync } = await import("child_process");
      const checkCmd = process.platform === "win32" ? "where" : "which";
      execFileSync(checkCmd, [command], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  ipcMain.handle(CHANNELS.SYSTEM_CHECK_COMMAND, handleSystemCheckCommand);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SYSTEM_CHECK_COMMAND));

  const handleSystemCheckDirectory = async (
    _event: Electron.IpcMainInvokeEvent,
    directoryPath: string
  ): Promise<boolean> => {
    if (typeof directoryPath !== "string" || !directoryPath.trim()) {
      return false;
    }

    const path = await import("path");
    if (!path.isAbsolute(directoryPath)) {
      console.warn(`Directory path "${directoryPath}" is not absolute, rejecting`);
      return false;
    }

    try {
      const fs = await import("fs");
      const stats = await fs.promises.stat(directoryPath);
      return stats.isDirectory();
    } catch {
      return false;
    }
  };
  ipcMain.handle(CHANNELS.SYSTEM_CHECK_DIRECTORY, handleSystemCheckDirectory);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SYSTEM_CHECK_DIRECTORY));

  const handleSystemGetHomeDir = async () => {
    return os.homedir();
  };
  ipcMain.handle(CHANNELS.SYSTEM_GET_HOME_DIR, handleSystemGetHomeDir);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SYSTEM_GET_HOME_DIR));

  const handleSystemGetCliAvailability = async () => {
    if (!cliAvailabilityService) {
      console.warn("[IPC] CliAvailabilityService not available");
      return { claude: false, gemini: false, codex: false };
    }

    const cached = cliAvailabilityService.getAvailability();
    if (cached) {
      return cached;
    }

    return await cliAvailabilityService.checkAvailability();
  };
  ipcMain.handle(CHANNELS.SYSTEM_GET_CLI_AVAILABILITY, handleSystemGetCliAvailability);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SYSTEM_GET_CLI_AVAILABILITY));

  const handleSystemRefreshCliAvailability = async () => {
    if (!cliAvailabilityService) {
      console.warn("[IPC] CliAvailabilityService not available");
      return { claude: false, gemini: false, codex: false };
    }

    return await cliAvailabilityService.refresh();
  };
  ipcMain.handle(CHANNELS.SYSTEM_REFRESH_CLI_AVAILABILITY, handleSystemRefreshCliAvailability);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SYSTEM_REFRESH_CLI_AVAILABILITY));

  const handleProjectGetAll = async () => {
    return projectStore.getAllProjects();
  };
  ipcMain.handle(CHANNELS.PROJECT_GET_ALL, handleProjectGetAll);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_GET_ALL));

  const handleProjectGetCurrent = async () => {
    const currentProject = projectStore.getCurrentProject();

    if (currentProject && worktreeService) {
      try {
        await worktreeService.loadProject(currentProject.path);
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
    return projectStore.updateProject(projectId, updates);
  };
  ipcMain.handle(CHANNELS.PROJECT_UPDATE, handleProjectUpdate);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_UPDATE));

  const handleProjectSwitch = async (_event: Electron.IpcMainInvokeEvent, projectId: string) => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }

    return await projectSwitchService.switchProject(projectId);
  };
  ipcMain.handle(CHANNELS.PROJECT_SWITCH, handleProjectSwitch);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_SWITCH));

  const handleProjectOpenDialog = async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory"],
      title: "Open Git Repository",
    });

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
    return projectStore.saveProjectSettings(projectId, settings);
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

    if (projectId === storeActiveProjectId) {
      throw new Error("Cannot close the active project. Switch to another project first.");
    }

    const project = projectStore.getProjectById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    // If project is already closed and we're not killing, no-op
    if (!killTerminals && project.status === "closed") {
      return { success: true, processesKilled: 0, terminalsKilled: 0 };
    }

    try {
      const ptyStats = await deps.ptyClient.getProjectStats(projectId);

      if (killTerminals) {
        // Kill terminals when explicitly requested (freeing resources completely)
        const terminalsKilled = await deps.ptyClient.killByProject(projectId);

        // Clear persisted state
        await projectStore.clearProjectState(projectId);

        // Set status to 'closed' (no running processes)
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
        // Background mode: just mark as background, terminals keep running
        projectStore.updateProjectStatus(projectId, "background");

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

  const handleProjectReopen = async (_event: Electron.IpcMainInvokeEvent, projectId: string) => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }

    console.log(`[IPC] project:reopen: ${projectId}`);

    const project = projectStore.getProjectById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    // Reopen is only meaningful for background projects
    if (project.status !== "background") {
      throw new Error(
        `Cannot reopen project ${projectId} unless status is "background" (current: ${project.status ?? "unset"})`
      );
    }

    // Use the switch service which handles all the cleanup/load logic
    return await projectSwitchService.reopenProject(projectId);
  };
  ipcMain.handle(CHANNELS.PROJECT_REOPEN, handleProjectReopen);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_REOPEN));

  const handleProjectGetStats = async (_event: Electron.IpcMainInvokeEvent, projectId: string) => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }

    const ptyStats = await deps.ptyClient.getProjectStats(projectId);

    // Estimate memory (rough approximation)
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

  return () => handlers.forEach((cleanup) => cleanup());
}
