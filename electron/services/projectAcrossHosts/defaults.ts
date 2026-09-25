import os from "node:os";
import path from "node:path";
import { app } from "electron";
import { projectStore } from "../ProjectStore.js";
import { ProjectIdentityFiles } from "../ProjectIdentityFiles.js";
import { getOperationRegistry } from "../operations/index.js";
import { getWorkspaceClientRef } from "../../window/serviceRefs.js";
import { probeGitLfsAvailable } from "../../workspace-host/worktreeUtils.js";
import { generateWorktreePath } from "../../../shared/utils/pathPattern.js";
import { defaultGitFactory } from "./gitOps.js";
import { ProjectAcrossHostsService } from "./service.js";
import type { ProjectAcrossHostsDeps } from "./types.js";

const identityFiles = new ProjectIdentityFiles();

export function createDefaultProjectAcrossHostsDeps(): ProjectAcrossHostsDeps {
  return {
    git: defaultGitFactory,
    listProjects: () => projectStore.getAllProjects(),
    getProject: (projectId) => projectStore.getProjectById(projectId),
    registerProject: async (projectPath) => {
      const { addProjectByPath } = await import("../../ipc/handlers/projectCrud/crud.js");
      return addProjectByPath(projectPath);
    },
    readCommittedProjectId: async (projectPath) =>
      (await identityFiles.readInRepoProjectIdentity(projectPath)).id ?? null,
    readInRepoRecipes: (projectPath) => projectStore.readInRepoRecipes(projectPath),
    defaultRecipeId: async (projectId) =>
      (await projectStore.getProjectSettings(projectId)).defaultWorktreeRecipeId ?? null,
    createWorktree: async (projectPath, options) => {
      const client = getWorkspaceClientRef();
      if (!client) throw new Error("Workspace service is not available");
      // With no window on the project there's no load to ride on; start its
      // workspace host on its own, as a viewless worktree create does.
      if (client.getHostForProject(projectPath) === undefined) client.prewarmProject(projectPath);
      await client.waitForReady();
      return client.createWorktree(projectPath, options);
    },
    worktreePathFor: async (projectPath, branch) => {
      const { resolveWorktreePattern } = await import("../../utils/worktreePattern.js");
      return generateWorktreePath(projectPath, branch, await resolveWorktreePattern(projectPath));
    },
    focusWorktree: (projectId, worktreeId) =>
      projectStore.enqueueProjectStateUpdate(projectId, (existing) => ({
        ...(existing ?? { projectId, sidebarWidth: 350, terminals: [] }),
        activeWorktreeId: worktreeId,
      })),
    operations: () => getOperationRegistry(),
    clone: async (options) => {
      const { executeClone } = await import("../../ipc/handlers/projectCrud/gitClone.js");
      return executeClone(options);
    },
    probeGitLfs: () => probeGitLfsAvailable(),
    homeDir: () => os.homedir(),
    bundleDir: () => path.join(app.getPath("temp"), "daintree-bundles"),
  };
}

let service: ProjectAcrossHostsService | null = null;

/** This process's host-side project service, for its own windows and for remote Shells. */
export function getProjectAcrossHostsService(): ProjectAcrossHostsService {
  service ??= new ProjectAcrossHostsService(createDefaultProjectAcrossHostsDeps());
  return service;
}

export function _resetProjectAcrossHostsServiceForTest(
  next: ProjectAcrossHostsService | null = null
): void {
  service = next;
}
