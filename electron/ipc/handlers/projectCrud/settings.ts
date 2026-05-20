/**
 * Project settings and provisioning handlers — settings I/O, runner detection,
 * and folder provisioning for new projects.
 */

import path from "path";
import { CHANNELS } from "../../channels.js";
import { projectStore } from "../../../services/ProjectStore.js";
import type * as RunCommandDetectorModule from "../../../services/RunCommandDetector.js";

let cachedRunCommandDetector: typeof RunCommandDetectorModule.runCommandDetector | null = null;
async function getRunCommandDetector(): Promise<
  typeof RunCommandDetectorModule.runCommandDetector
> {
  if (!cachedRunCommandDetector) {
    const mod = await import("../../../services/RunCommandDetector.js");
    cachedRunCommandDetector = mod.runCommandDetector;
  }
  return cachedRunCommandDetector;
}
import { z } from "zod";
import { typedHandle, typedHandleValidated } from "../../utils.js";
import { validateFolderName } from "../../../../shared/utils/folderName.js";
import { ProjectSettingsSaveSchema } from "../../../services/projectSettingsCodec.js";
import type { ProjectSettings } from "../../../types/index.js";
import type { HandlerDependencies } from "../../types.js";

export function registerProjectSettingsHandlers(deps: HandlerDependencies = {}): () => void {
  const handlers: Array<() => void> = [];

  const handleProjectGetSettings = async (projectId: string): Promise<ProjectSettings> => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    return projectStore.getProjectSettings(projectId);
  };
  handlers.push(typedHandle(CHANNELS.PROJECT_GET_SETTINGS, handleProjectGetSettings));

  const ProjectSaveSettingsPayloadSchema = z.object({
    projectId: z.string().min(1),
    settings: ProjectSettingsSaveSchema,
  });

  const handleProjectSaveSettings = async (
    payload: z.output<typeof ProjectSaveSettingsPayloadSchema>
  ): Promise<void> => {
    const { projectId, settings } = payload;
    const previousSettings = await projectStore.getProjectSettings(projectId);
    await projectStore.saveProjectSettings(projectId, settings as ProjectSettings);
    const project = projectStore.getProjectById(projectId);
    if (project?.inRepoSettings) {
      await projectStore.writeInRepoSettings(project.path, settings as ProjectSettings);
    }
    const previousRemote = previousSettings.forgeRemote ?? previousSettings.githubRemote;
    const nextRemote = settings.forgeRemote ?? settings.githubRemote;
    const remoteChanged = nextRemote !== previousRemote;
    if (remoteChanged) {
      const { clearGitHubCaches } = await import("../../../services/GitHubService.js");
      clearGitHubCaches();
    }
    // Re-resolve the workspace host's PR provider when the provider override
    // or selected remote changes — otherwise the running host keeps the
    // provider it resolved at load-project and stored settings drift out of
    // sync with the resolved provider (#8456). No-ops when no host is loaded.
    const providerOverrideChanged =
      (settings.forgeProviderOverride ?? null) !== (previousSettings.forgeProviderOverride ?? null);
    if (remoteChanged || providerOverrideChanged) {
      const projectPath = project?.path;
      if (projectPath) {
        void deps.worktreeService?.updateForgeSettings(projectPath).catch((error) => {
          console.warn("[IPC] Failed to push forge settings to workspace host:", error);
        });
      }
    }
  };
  handlers.push(
    typedHandleValidated(
      CHANNELS.PROJECT_SAVE_SETTINGS,
      ProjectSaveSettingsPayloadSchema,
      handleProjectSaveSettings
    )
  );

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

    const detector = await getRunCommandDetector();
    return await detector.detect(project.path);
  };
  handlers.push(typedHandle(CHANNELS.PROJECT_DETECT_RUNNERS, handleProjectDetectRunners));

  const handleProjectGetNotificationOverrides = async (
    projectIds: string[]
  ): Promise<
    Record<string, Partial<import("../../../../shared/types/ipc/api.js").NotificationSettings>>
  > => {
    if (!Array.isArray(projectIds)) {
      throw new Error("Invalid project IDs");
    }
    const valid = projectIds.filter((id): id is string => typeof id === "string" && id.length > 0);
    const unique = [...new Set(valid)];
    return projectStore.getProjectNotificationOverrides(unique);
  };
  handlers.push(
    typedHandle(CHANNELS.PROJECT_GET_NOTIFICATION_OVERRIDES, handleProjectGetNotificationOverrides)
  );

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
    if (typeof folderName !== "string") {
      throw new Error("Folder name is required");
    }
    if (!path.isAbsolute(parentPath)) {
      throw new Error("Parent path must be absolute");
    }

    const folderNameError = validateFolderName(folderName);
    if (folderNameError) {
      throw new Error(folderNameError);
    }
    const trimmed = folderName.trim();

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
