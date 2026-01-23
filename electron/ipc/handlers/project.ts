import { ipcMain, dialog, shell } from "electron";
import path from "path";
import os from "os";
import { CHANNELS } from "../channels.js";
import { openExternalUrl } from "../../utils/openExternal.js";
import { projectStore } from "../../services/ProjectStore.js";
import { runCommandDetector } from "../../services/RunCommandDetector.js";
import { ProjectSwitchService } from "../../services/ProjectSwitchService.js";
import type { HandlerDependencies } from "../types.js";
import type { Project, ProjectSettings, TerminalRecipe } from "../../types/index.js";
import {
  SystemOpenExternalPayloadSchema,
  SystemOpenPathPayloadSchema,
  TerminalSnapshotSchema,
  filterValidTerminalEntries,
} from "../../schemas/index.js";
import type { TerminalSnapshot } from "../../types/index.js";

export function registerProjectHandlers(deps: HandlerDependencies): () => void {
  const { mainWindow, worktreeService, cliAvailabilityService, agentVersionService, agentUpdateHandler } = deps;
  const handlers: Array<() => void> = [];

  const projectSwitchService = new ProjectSwitchService({
    mainWindow: deps.mainWindow,
    ptyClient: deps.ptyClient,
    worktreeService: deps.worktreeService,
    eventBuffer: deps.eventBuffer,
  });

  const handleSystemOpenExternal = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: unknown
  ) => {
    const parseResult = SystemOpenExternalPayloadSchema.safeParse(payload);
    if (!parseResult.success) {
      console.error("[IPC] system:open-external validation failed:", parseResult.error.format());
      throw new Error(`Invalid payload: ${parseResult.error.message}`);
    }

    const { url } = parseResult.data;
    console.log("[IPC] system:open-external called with:", url);
    try {
      await openExternalUrl(url);
      console.log("[IPC] system:open-external completed successfully");
    } catch (error) {
      console.error("[IPC] Failed to open external URL:", error);
      throw error;
    }
  };
  ipcMain.handle(CHANNELS.SYSTEM_OPEN_EXTERNAL, handleSystemOpenExternal);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SYSTEM_OPEN_EXTERNAL));

  const handleSystemOpenPath = async (_event: Electron.IpcMainInvokeEvent, payload: unknown) => {
    const parseResult = SystemOpenPathPayloadSchema.safeParse(payload);
    if (!parseResult.success) {
      console.error("[IPC] system:open-path validation failed:", parseResult.error.format());
      throw new Error(`Invalid payload: ${parseResult.error.message}`);
    }

    const { path: targetPath } = parseResult.data;
    const fs = await import("fs");
    const pathModule = await import("path");

    try {
      if (!pathModule.isAbsolute(targetPath)) {
        throw new Error("Only absolute paths are allowed");
      }
      await fs.promises.access(targetPath);
      const errorString = await shell.openPath(targetPath);
      if (errorString) {
        throw new Error(`Failed to open path: ${errorString}`);
      }
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

  const handleSystemGetAgentVersions = async () => {
    if (!agentVersionService) {
      console.warn("[IPC] AgentVersionService not available");
      return [];
    }

    return await agentVersionService.getVersions();
  };
  ipcMain.handle(CHANNELS.SYSTEM_GET_AGENT_VERSIONS, handleSystemGetAgentVersions);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SYSTEM_GET_AGENT_VERSIONS));

  const handleSystemRefreshAgentVersions = async () => {
    if (!agentVersionService) {
      console.warn("[IPC] AgentVersionService not available");
      return [];
    }

    return await agentVersionService.getVersions(true);
  };
  ipcMain.handle(CHANNELS.SYSTEM_REFRESH_AGENT_VERSIONS, handleSystemRefreshAgentVersions);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SYSTEM_REFRESH_AGENT_VERSIONS));

  const handleSystemGetAgentUpdateSettings = async () => {
    const { store } = await import("../../store.js");
    return store.get("agentUpdateSettings", {
      autoCheck: true,
      checkFrequencyHours: 24,
      lastAutoCheck: null,
    });
  };
  ipcMain.handle(CHANNELS.SYSTEM_GET_AGENT_UPDATE_SETTINGS, handleSystemGetAgentUpdateSettings);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SYSTEM_GET_AGENT_UPDATE_SETTINGS));

  const handleSystemSetAgentUpdateSettings = async (
    _event: Electron.IpcMainInvokeEvent,
    settings: import("../../types/index.js").AgentUpdateSettings
  ) => {
    if (
      !settings ||
      typeof settings.autoCheck !== "boolean" ||
      typeof settings.checkFrequencyHours !== "number" ||
      !Number.isFinite(settings.checkFrequencyHours) ||
      settings.checkFrequencyHours < 1 ||
      settings.checkFrequencyHours > 168 ||
      (settings.lastAutoCheck !== null &&
        (typeof settings.lastAutoCheck !== "number" || !Number.isFinite(settings.lastAutoCheck)))
    ) {
      throw new Error("Invalid AgentUpdateSettings");
    }

    const { store } = await import("../../store.js");
    store.set("agentUpdateSettings", settings);
  };
  ipcMain.handle(CHANNELS.SYSTEM_SET_AGENT_UPDATE_SETTINGS, handleSystemSetAgentUpdateSettings);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SYSTEM_SET_AGENT_UPDATE_SETTINGS));

  const handleSystemStartAgentUpdate = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: import("../../types/index.js").StartAgentUpdatePayload
  ) => {
    if (!agentUpdateHandler) {
      throw new Error("AgentUpdateHandler not available");
    }

    if (
      !payload ||
      !payload.agentId ||
      typeof payload.agentId !== "string" ||
      (payload.method !== undefined && typeof payload.method !== "string")
    ) {
      throw new Error("Invalid StartAgentUpdatePayload");
    }

    return await agentUpdateHandler.startUpdate(payload);
  };
  ipcMain.handle(CHANNELS.SYSTEM_START_AGENT_UPDATE, handleSystemStartAgentUpdate);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SYSTEM_START_AGENT_UPDATE));

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

    if (projectId === storeActiveProjectId && !killTerminals) {
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

        // Set status to 'closed' (no running processes) unless this is the active project
        if (projectId !== storeActiveProjectId) {
          projectStore.updateProjectStatus(projectId, "closed");
        }

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

    const simpleGit = await import("simple-git");
    const git = simpleGit.simpleGit(directoryPath);
    await git.init();
  };
  ipcMain.handle(CHANNELS.PROJECT_INIT_GIT, handleProjectInitGit);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_INIT_GIT));

  const handleProjectGetRecipes = async (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string
  ): Promise<TerminalRecipe[]> => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    return projectStore.getRecipes(projectId);
  };
  ipcMain.handle(CHANNELS.PROJECT_GET_RECIPES, handleProjectGetRecipes);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_GET_RECIPES));

  const handleProjectSaveRecipes = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: { projectId: string; recipes: TerminalRecipe[] }
  ): Promise<void> => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload");
    }
    const { projectId, recipes } = payload;
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    if (!Array.isArray(recipes)) {
      throw new Error("Invalid recipes array");
    }
    return projectStore.saveRecipes(projectId, recipes);
  };
  ipcMain.handle(CHANNELS.PROJECT_SAVE_RECIPES, handleProjectSaveRecipes);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_SAVE_RECIPES));

  const handleProjectAddRecipe = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: { projectId: string; recipe: TerminalRecipe }
  ): Promise<void> => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload");
    }
    const { projectId, recipe } = payload;
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    if (!recipe || typeof recipe !== "object") {
      throw new Error("Invalid recipe");
    }
    // Validate recipe projectId matches
    if (recipe.projectId !== projectId) {
      throw new Error("Recipe projectId does not match target project");
    }
    // Validate required fields
    if (!recipe.id || !recipe.name || !Array.isArray(recipe.terminals)) {
      throw new Error("Recipe missing required fields (id, name, terminals)");
    }
    if (typeof recipe.createdAt !== "number") {
      throw new Error("Recipe createdAt must be a number");
    }
    return projectStore.addRecipe(projectId, recipe);
  };
  ipcMain.handle(CHANNELS.PROJECT_ADD_RECIPE, handleProjectAddRecipe);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_ADD_RECIPE));

  const handleProjectUpdateRecipe = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: {
      projectId: string;
      recipeId: string;
      updates: Partial<Omit<TerminalRecipe, "id" | "projectId" | "createdAt">>;
    }
  ): Promise<void> => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload");
    }
    const { projectId, recipeId, updates } = payload;
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    if (typeof recipeId !== "string" || !recipeId) {
      throw new Error("Invalid recipe ID");
    }
    if (!updates || typeof updates !== "object") {
      throw new Error("Invalid updates");
    }
    return projectStore.updateRecipe(projectId, recipeId, updates);
  };
  ipcMain.handle(CHANNELS.PROJECT_UPDATE_RECIPE, handleProjectUpdateRecipe);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_UPDATE_RECIPE));

  const handleProjectDeleteRecipe = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: { projectId: string; recipeId: string }
  ): Promise<void> => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload");
    }
    const { projectId, recipeId } = payload;
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    if (typeof recipeId !== "string" || !recipeId) {
      throw new Error("Invalid recipe ID");
    }
    return projectStore.deleteRecipe(projectId, recipeId);
  };
  ipcMain.handle(CHANNELS.PROJECT_DELETE_RECIPE, handleProjectDeleteRecipe);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_DELETE_RECIPE));

  const handleProjectGetTerminals = async (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string
  ): Promise<TerminalSnapshot[]> => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    const state = await projectStore.getProjectState(projectId);
    return state?.terminals ?? [];
  };
  ipcMain.handle(CHANNELS.PROJECT_GET_TERMINALS, handleProjectGetTerminals);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_GET_TERMINALS));

  const handleProjectSetTerminals = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: { projectId: string; terminals: TerminalSnapshot[] }
  ): Promise<void> => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload");
    }
    const { projectId, terminals } = payload;
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    if (!Array.isArray(terminals)) {
      throw new Error("Invalid terminals array");
    }

    // Validate and filter terminal entries
    const validTerminals = filterValidTerminalEntries(
      terminals,
      TerminalSnapshotSchema,
      `project:set-terminals(${projectId})`
    );

    // Get existing state or create a default one
    const existingState = await projectStore.getProjectState(projectId);
    const newState = {
      projectId,
      activeWorktreeId: existingState?.activeWorktreeId,
      sidebarWidth: existingState?.sidebarWidth ?? 350,
      terminals: validTerminals,
      terminalLayout: existingState?.terminalLayout,
      focusMode: existingState?.focusMode,
      focusPanelState: existingState?.focusPanelState,
    };

    await projectStore.saveProjectState(projectId, newState);
  };
  ipcMain.handle(CHANNELS.PROJECT_SET_TERMINALS, handleProjectSetTerminals);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_SET_TERMINALS));

  const handleProjectGetFocusMode = async (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string
  ): Promise<{
    focusMode: boolean;
    focusPanelState?: { sidebarWidth: number; diagnosticsOpen: boolean };
  }> => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    const state = await projectStore.getProjectState(projectId);
    return {
      focusMode: state?.focusMode ?? false,
      focusPanelState: state?.focusPanelState,
    };
  };
  ipcMain.handle(CHANNELS.PROJECT_GET_FOCUS_MODE, handleProjectGetFocusMode);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_GET_FOCUS_MODE));

  const handleProjectSetFocusMode = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: {
      projectId: string;
      focusMode: boolean;
      focusPanelState?: { sidebarWidth: number; diagnosticsOpen: boolean };
    }
  ): Promise<void> => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload");
    }
    const { projectId, focusMode, focusPanelState } = payload;
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    if (typeof focusMode !== "boolean") {
      throw new Error("Invalid focusMode value");
    }

    // Validate focusPanelState if provided (check !== undefined to allow explicit null)
    let validFocusPanelState: { sidebarWidth: number; diagnosticsOpen: boolean } | undefined;
    if (focusPanelState !== undefined && focusPanelState !== null) {
      if (
        typeof focusPanelState !== "object" ||
        typeof focusPanelState.sidebarWidth !== "number" ||
        typeof focusPanelState.diagnosticsOpen !== "boolean"
      ) {
        throw new Error("Invalid focusPanelState structure");
      }
      // Validate sidebarWidth is finite and in reasonable range
      if (
        !Number.isFinite(focusPanelState.sidebarWidth) ||
        focusPanelState.sidebarWidth < 0 ||
        focusPanelState.sidebarWidth > 10000
      ) {
        throw new Error("Invalid sidebarWidth: must be finite and between 0-10000");
      }
      validFocusPanelState = {
        sidebarWidth: focusPanelState.sidebarWidth,
        diagnosticsOpen: focusPanelState.diagnosticsOpen,
      };
    }

    // Get existing state or create a default one
    const existingState = await projectStore.getProjectState(projectId);
    const newState = {
      projectId,
      activeWorktreeId: existingState?.activeWorktreeId,
      sidebarWidth: existingState?.sidebarWidth ?? 350,
      terminals: existingState?.terminals ?? [],
      terminalLayout: existingState?.terminalLayout,
      focusMode,
      focusPanelState: validFocusPanelState,
    };

    await projectStore.saveProjectState(projectId, newState);
  };
  ipcMain.handle(CHANNELS.PROJECT_SET_FOCUS_MODE, handleProjectSetFocusMode);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_SET_FOCUS_MODE));

  return () => handlers.forEach((cleanup) => cleanup());
}
