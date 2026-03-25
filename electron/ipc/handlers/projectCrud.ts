import { ipcMain, dialog } from "electron";
import path from "path";
import { CHANNELS } from "../channels.js";
import { projectStore } from "../../services/ProjectStore.js";
import { runCommandDetector } from "../../services/RunCommandDetector.js";
import { ProjectSwitchService } from "../../services/ProjectSwitchService.js";
import { sendToRenderer } from "../utils.js";
import { randomUUID } from "crypto";
import type { HandlerDependencies } from "../types.js";
import type { Project, ProjectSettings } from "../../types/index.js";
import type { BulkProjectStats, BulkProjectStatsEntry } from "../../../shared/types/ipc/project.js";
import type {
  GitInitOptions,
  GitInitResult,
  GitInitProgressEvent,
} from "../../../shared/types/ipc/gitInit.js";
import { createHardenedGit } from "../../utils/hardenedGit.js";

export function registerProjectCrudHandlers(deps: HandlerDependencies): () => void {
  const { mainWindow } = deps;
  const handlers: Array<() => void> = [];

  const projectSwitchService = deps.projectSwitchService ?? new ProjectSwitchService(deps);

  const handleProjectGetAll = async () => {
    return projectStore.getAllProjects();
  };
  ipcMain.handle(CHANNELS.PROJECT_GET_ALL, handleProjectGetAll);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_GET_ALL));

  const handleProjectGetCurrent = async () => {
    const currentProject = projectStore.getCurrentProject();

    if (currentProject && deps.worktreeService) {
      try {
        await deps.worktreeService.loadProject(currentProject.path);
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

    if (deps.projectMcpManager) {
      await deps.projectMcpManager.stopForProject(projectId).catch((err: unknown) => {
        console.error(`[IPC] project:remove: Failed to stop MCP servers for ${projectId}:`, err);
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
    // Strip control-plane fields — use project:enable/disable-in-repo-settings instead
    const { inRepoSettings: _inRepo, ...safeUpdates } = updates;
    const updated = projectStore.updateProject(projectId, safeUpdates);
    if (
      updated.inRepoSettings &&
      (updates.name !== undefined || updates.emoji !== undefined || updates.color !== undefined)
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
      properties: ["openDirectory", "createDirectory"],
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
    await projectStore.saveProjectSettings(projectId, settings);
    const project = projectStore.getProjectById(projectId);
    if (project?.inRepoSettings) {
      await projectStore.writeInRepoSettings(project.path, settings);
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

        if (deps.projectMcpManager) {
          await deps.projectMcpManager.stopForProject(projectId).catch((err: unknown) => {
            console.error(`[IPC] project:close: Failed to stop MCP servers for ${projectId}:`, err);
          });
        }

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

  const handleProjectMcpGetStatuses = (_event: Electron.IpcMainInvokeEvent, projectId: string) => {
    if (typeof projectId !== "string" || !projectId) return [];
    return deps.projectMcpManager?.getStatuses(projectId) ?? [];
  };
  ipcMain.handle(CHANNELS.PROJECT_MCP_GET_STATUSES, handleProjectMcpGetStatuses);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_MCP_GET_STATUSES));

  const handleProjectReopen = async (_event: Electron.IpcMainInvokeEvent, projectId: string) => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }

    console.log(`[IPC] project:reopen: ${projectId}`);

    const project = projectStore.getProjectById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    if (project.status === "active") {
      console.log(
        `[IPC] project:reopen: Project ${projectId} already active, emitting switch event`
      );
      const switchId = randomUUID();
      sendToRenderer(mainWindow, CHANNELS.PROJECT_ON_SWITCH, {
        project,
        switchId,
      });
      return project;
    }

    if (project.status !== "background") {
      throw new Error(
        `Cannot reopen project ${projectId} unless status is "background" (current: ${project.status ?? "unset"})`
      );
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

    const entries = await Promise.allSettled(
      uniqueIds.map(async (projectId): Promise<[string, BulkProjectStatsEntry]> => {
        const [ptyStats, terminalIds] = await Promise.all([
          deps.ptyClient!.getProjectStats(projectId),
          deps.ptyClient!.getTerminalsForProjectAsync(projectId),
        ]);

        let activeAgentCount = 0;
        let waitingAgentCount = 0;

        const terminalInfos = await Promise.all(
          terminalIds.map((id) => deps.ptyClient!.getTerminalAsync(id))
        );

        for (const terminal of terminalInfos) {
          if (!terminal) continue;
          if (terminal.kind === "dev-preview") continue;
          if (terminal.hasPty === false) continue;

          const isAgent = terminal.kind === "agent" || !!terminal.agentId;
          if (!isAgent) continue;

          if (terminal.agentState === "waiting") {
            waitingAgentCount += 1;
          } else if (terminal.agentState === "working" || terminal.agentState === "running") {
            activeAgentCount += 1;
          }
        }

        return [
          projectId,
          {
            processCount: ptyStats.terminalCount,
            terminalCount: ptyStats.terminalCount,
            estimatedMemoryMB: ptyStats.terminalCount * MEMORY_PER_TERMINAL_MB,
            terminalTypes: ptyStats.terminalTypes,
            processIds: ptyStats.processIds,
            activeAgentCount,
            waitingAgentCount,
          },
        ];
      })
    );

    const result: BulkProjectStats = {};
    for (const entry of entries) {
      if (entry.status === "fulfilled") {
        const [id, stats] = entry.value;
        result[id] = stats;
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
    _event: Electron.IpcMainInvokeEvent,
    options: GitInitOptions
  ): Promise<GitInitResult> => {
    if (!options || typeof options !== "object") {
      throw new Error("Invalid options object");
    }

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
      if (mainWindow.isDestroyed()) {
        return;
      }
      const event: GitInitProgressEvent = {
        step,
        status,
        message,
        error,
        timestamp: Date.now(),
      };
      mainWindow.webContents.send(CHANNELS.PROJECT_INIT_GIT_PROGRESS, event);
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

    const result = await dialog.showOpenDialog({
      title: `Locate "${project.name}"`,
      properties: ["openDirectory"],
      defaultPath: path.dirname(project.path),
    });

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
