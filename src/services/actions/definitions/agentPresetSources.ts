import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";
import type { AgentPresetSources } from "./agentPresetMutation";

/**
 * The stores a user-preset write is planned against (#16047): the ones Settings
 * writes through and the launcher resolves from, so a preset the confirm
 * preview describes is the one a launch will pick. Repository presets count
 * only when the loaded snapshot belongs to `projectId`; the store is reused
 * across project switches.
 */
export function readPresetWriteSources(projectId: string | undefined): AgentPresetSources {
  const project = useProjectPresetsStore.getState();
  return {
    settings: useAgentSettingsStore.getState().settings,
    ccrPresetsByAgent: useCcrPresetsStore.getState().ccrPresetsByAgent,
    projectPresetsByAgent:
      projectId !== undefined && project.hydratedProjectId === projectId
        ? project.presetsByAgent
        : undefined,
  };
}
