/**
 * One plugin `agentMcp` endpoint as a project's settings see it: what it is,
 * and whether the user has let this project's agents use it.
 */
export interface ProjectAgentToolEndpoint {
  /** Plugin instance key — what enablement is stored against. */
  pluginInstanceId: string;
  pluginDisplayName: string;
  endpointId: string;
  name: string;
  description?: string;
  enabled: boolean;
  /**
   * False for an endpoint that is on for this project but that no running
   * plugin currently offers here (the plugin was disabled, uninstalled or
   * changed its manifest). The answer is kept, so it is listed and can be
   * turned off; it can't be turned back on until the plugin offers it again.
   */
  available: boolean;
}

export interface ProjectAgentToolsSnapshot {
  endpoints: ProjectAgentToolEndpoint[];
  /**
   * Agents reach plugin endpoints over Daintree's MCP listener, so an endpoint
   * that is on does nothing while the listener is switched off.
   */
  mcpServerEnabled: boolean;
}

export interface SetProjectAgentToolEnabledPayload {
  pluginInstanceId: string;
  endpointId: string;
  enabled: boolean;
}
