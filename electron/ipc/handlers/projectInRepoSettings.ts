import { CHANNELS } from "../channels.js";
import { projectStore } from "../../services/ProjectStore.js";
import {
  keepSharedVoiceDictionaryLocally,
  shareLocalVoiceDictionary,
} from "../../services/projectVoiceDictionary.js";
import type { HandlerDependencies } from "../types.js";
import type { Project } from "../../types/index.js";
import { typedHandle } from "../utils.js";

export function registerProjectInRepoSettingsHandlers(_deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const handleProjectEnableInRepoSettings = async (projectId: string): Promise<Project> => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    const project = projectStore.getProjectById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }
    const settings = await projectStore.getProjectSettings(projectId);

    // Enabling rewrites every project recipe over `.daintree/recipes/`. Any
    // destination already holding content this build can't represent would be
    // silently stripped and committed, so check them all up front and fail the
    // whole operation — a half-written batch with `inRepoSettings` flipped on is
    // worse than not enabling at all (#12261).
    const recipes = await projectStore.getRecipes(projectId);
    await projectStore.assertInRepoRecipesForwardCompatible(
      project.path,
      recipes.map((recipe) => recipe.name)
    );

    await projectStore.writeInRepoProjectIdentity(project.path, {
      id: project.id,
      name: project.name,
      emoji: project.emoji,
      color: project.color,
    });
    await projectStore.writeInRepoSettings(project.path, settings);
    await shareLocalVoiceDictionary(projectId);

    // Sync existing project recipes to .daintree/recipes/ (pre-flighted above).
    for (const recipe of recipes) {
      await projectStore.writeInRepoRecipe(project.path, recipe);
    }

    return projectStore.updateProject(projectId, {
      inRepoSettings: true,
      daintreeConfigPresent: true,
    });
  };
  handlers.push(
    typedHandle(CHANNELS.PROJECT_ENABLE_IN_REPO_SETTINGS, handleProjectEnableInRepoSettings)
  );

  const handleProjectDisableInRepoSettings = async (projectId: string): Promise<Project> => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    const project = projectStore.getProjectById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }
    await keepSharedVoiceDictionaryLocally(projectId);
    return projectStore.updateProject(projectId, { inRepoSettings: false });
  };
  handlers.push(
    typedHandle(CHANNELS.PROJECT_DISABLE_IN_REPO_SETTINGS, handleProjectDisableInRepoSettings)
  );

  return () => handlers.forEach((cleanup) => cleanup());
}
