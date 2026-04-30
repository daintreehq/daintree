import { CHANNELS } from "../channels.js";
import { projectStore } from "../../services/ProjectStore.js";
import type { HandlerDependencies } from "../types.js";
import type { AgentPreset } from "../../../shared/config/agentRegistry.js";
import { typedHandle } from "../utils.js";

export function registerProjectPresetsHandlers(_deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const handleGetInRepoPresets = async (
    projectId: string
  ): Promise<Record<string, AgentPreset[]>> => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    const project = projectStore.getProjectById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }
    return projectStore.readInRepoPresets(project.path);
  };
  handlers.push(typedHandle(CHANNELS.PROJECT_GET_INREPO_PRESETS, handleGetInRepoPresets));

  return () => handlers.forEach((cleanup) => cleanup());
}
