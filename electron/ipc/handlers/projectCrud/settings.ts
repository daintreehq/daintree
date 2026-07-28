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
import {
  typedHandle,
  typedHandleValidated,
  checkRateLimit,
  broadcastToRenderer,
} from "../../utils.js";
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
    if (remoteChanged) {
      // The renderer caches provider resolution per project and only drops it
      // on `forge:remote-changed` (#11155). That event is signature-gated on
      // `.git/config`, which a settings change never touches — so without this
      // broadcast the toolbar keeps resolving against the OLD remote until a
      // reload, which is the bug this fix exists to close (#11408).
      broadcastToRenderer(CHANNELS.EVENTS_PUSH, {
        name: "forge:remote-changed",
        payload: { projectId },
      });
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

  // Lists all git remotes (origin, upstream, …) with an optional parsed
  // owner/repo for remotes whose URL looks like a forge repo. Display-only
  // parse — provider routing resolves remotes through `parseRemote` instead.
  const handleProjectListRemotes = async (
    cwd: string
  ): Promise<
    Array<{ name: string; fetchUrl: string; parsedRepo: { owner: string; repo: string } | null }>
  > => {
    checkRateLimit(CHANNELS.PROJECT_LIST_REMOTES, 10, 10_000);
    if (typeof cwd !== "string" || !cwd) {
      throw new Error("Invalid working directory");
    }
    if (!path.isAbsolute(cwd)) {
      throw new Error("Working directory must be an absolute path");
    }
    const { GitService } = await import("../../../services/GitService.js");
    const remotes = await new GitService(cwd).listRemotes(cwd);
    const result = remotes.map((r) => ({
      name: r.name,
      fetchUrl: r.fetchUrl,
      parsedRepo: parseOwnerRepo(r.fetchUrl),
    }));
    result.sort((a, b) => {
      if (a.name === "origin") return -1;
      if (b.name === "origin") return 1;
      return a.name.localeCompare(b.name);
    });
    return result;
  };
  handlers.push(typedHandle(CHANNELS.PROJECT_LIST_REMOTES, handleProjectListRemotes));

  return () => handlers.forEach((cleanup) => cleanup());
}

/** Forge-agnostic owner/repo extraction from https or scp-style git remote URLs. */
function parseOwnerRepo(url: string): { owner: string; repo: string } | null {
  if (!url) return null;
  const normalized = url.replace(/^(?:ssh:\/\/)?git@([^/:]+)[/:]/, "https://$1/");
  try {
    const parsed = new URL(normalized);
    const parts = parsed.pathname
      .replace(/^\//, "")
      .replace(/\/$/, "")
      .replace(/\.git$/, "")
      .split("/");
    if (parts.length < 2 || !parts[0] || !parts[parts.length - 1]) return null;
    return { owner: parts[0], repo: parts[parts.length - 1] };
  } catch {
    return null;
  }
}
