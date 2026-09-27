import type {
  ProjectAgentToolsSnapshot,
  SetProjectAgentToolAccessPayload,
} from "@shared/types/ipc/pluginAgentMcp";

/**
 * Plugin agent-tool access. Both calls act on the project this view is bound
 * to — main resolves it from the sender — and both answer with the fresh list,
 * so nothing here is cached.
 */
export const pluginAgentMcpClient = {
  listProjectPlugins: (): Promise<ProjectAgentToolsSnapshot> =>
    window.electron.pluginAgentMcp.listProjectPlugins(),

  setPluginAccess: (
    payload: SetProjectAgentToolAccessPayload
  ): Promise<ProjectAgentToolsSnapshot> => window.electron.pluginAgentMcp.setPluginAccess(payload),
} as const;
