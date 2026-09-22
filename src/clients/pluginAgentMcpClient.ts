import type {
  ProjectAgentToolsSnapshot,
  SetProjectAgentToolEnabledPayload,
} from "@shared/types/ipc/pluginAgentMcp";

/**
 * Per-project consent for plugin agent tools. Both calls act on the project
 * this view is bound to — main resolves it from the sender — and both answer
 * with the fresh list, so nothing here is cached.
 */
export const pluginAgentMcpClient = {
  listProjectEndpoints: (): Promise<ProjectAgentToolsSnapshot> =>
    window.electron.pluginAgentMcp.listProjectEndpoints(),

  setProjectEndpointEnabled: (
    payload: SetProjectAgentToolEnabledPayload
  ): Promise<ProjectAgentToolsSnapshot> =>
    window.electron.pluginAgentMcp.setProjectEndpointEnabled(payload),
} as const;
