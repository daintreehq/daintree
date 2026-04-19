import { projectClient } from "@/clients";
import type { FleetSavedScope, ProjectSettings } from "@shared/types/project";

export const fleetScopesController = {
  loadScopes: async (projectId: string): Promise<FleetSavedScope[]> => {
    const settings: Partial<ProjectSettings> | null = await projectClient.getSettings(projectId);
    return settings?.fleetSavedScopes ?? [];
  },

  saveScopes: async (projectId: string, scopes: FleetSavedScope[]): Promise<void> => {
    const settings: Partial<ProjectSettings> | null =
      (await projectClient.getSettings(projectId)) ?? {};
    // projectClient.saveSettings requires ProjectSettings but the IPC handler
    // is lenient — same pattern as projectActions.ts saveSettings call.
    await projectClient.saveSettings(projectId, {
      ...settings,
      fleetSavedScopes: scopes,
    } as ProjectSettings);
  },
};
