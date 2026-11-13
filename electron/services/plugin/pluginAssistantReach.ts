/**
 * Which loaded plugin actions opted into the project Assistant's MCP tools
 * (#16751), as main's plugin registry knows them right now. The MCP tier gate
 * reads it here instead of importing the plugin service, which loads lazily:
 * until it has loaded and installed itself there is no plugin action to reach,
 * and the answer is no.
 */
export interface PluginAssistantReachSource {
  has(actionId: string): boolean;
  ids(): readonly string[];
}

let current: PluginAssistantReachSource | null = null;

/** Install the live source. Returns an uninstall that leaves a newer source alone. */
export function setPluginAssistantReachSource(source: PluginAssistantReachSource): () => void {
  current = source;
  return () => {
    if (current === source) current = null;
  };
}

export function isPluginAssistantReachAction(actionId: string): boolean {
  return current?.has(actionId) ?? false;
}

export function pluginAssistantReachActionIds(): readonly string[] {
  return current?.ids() ?? [];
}
