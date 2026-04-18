/**
 * Project settings and provisioning handlers — settings I/O, runner detection,
 * and folder provisioning for new projects.
 */

import path from "path";
import { CHANNELS } from "../../channels.js";
import { projectStore } from "../../../services/ProjectStore.js";
import { runCommandDetector } from "../../../services/RunCommandDetector.js";
import { typedHandle } from "../../utils.js";
import type { ProjectSettings } from "../../../types/index.js";

export function registerProjectSettingsHandlers(): () => void {
  const handlers: Array<() => void> = [];

  const handleProjectGetSettings = async (projectId: string): Promise<ProjectSettings> => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    return projectStore.getProjectSettings(projectId);
  };
  handlers.push(typedHandle(CHANNELS.PROJECT_GET_SETTINGS, handleProjectGetSettings));

  const handleProjectSaveSettings = async (payload: {
    projectId: string;
    settings: ProjectSettings;
  }): Promise<void> => {
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
      const { clearGitHubCaches } = await import("../../../services/GitHubService.js");
      clearGitHubCaches();
    }
  };
  handlers.push(typedHandle(CHANNELS.PROJECT_SAVE_SETTINGS, handleProjectSaveSettings));

  const handleProjectDetectRunners = async (projectId: string) => {
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
  handlers.push(typedHandle(CHANNELS.PROJECT_DETECT_RUNNERS, handleProjectDetectRunners));

  const handleProjectCreateFolder = async (payload: {
    parentPath: string;
    folderName: string;
  }): Promise<string> => {
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
  handlers.push(typedHandle(CHANNELS.PROJECT_CREATE_FOLDER, handleProjectCreateFolder));

  return () => handlers.forEach((cleanup) => cleanup());
}
