import type { AgentMcpEndpointRegistration } from "./types.js";

type RegistryListener = (pluginInstanceId: string, endpointId: string) => void;

/**
 * Live tool rosters, keyed by plugin instance then endpoint. Keyed by instance
 * and never by manifest id: two projects can each load their own copy of the
 * same project plugin, and dropping one must not drop the other.
 */
export class AgentMcpEndpointRegistry {
  private readonly endpoints = new Map<string, Map<string, AgentMcpEndpointRegistration>>();
  private readonly listeners = new Set<RegistryListener>();

  /**
   * Bind a roster, replacing any earlier one for the same endpoint. The
   * returned disposer removes this registration only — once a later
   * registration has replaced it, the disposer does nothing.
   */
  register(registration: AgentMcpEndpointRegistration): () => void {
    const { pluginInstanceId, endpointId } = registration;
    let byEndpoint = this.endpoints.get(pluginInstanceId);
    if (!byEndpoint) {
      byEndpoint = new Map();
      this.endpoints.set(pluginInstanceId, byEndpoint);
    }
    byEndpoint.set(endpointId, registration);
    this.emit(pluginInstanceId, endpointId);
    return () => {
      const current = this.endpoints.get(pluginInstanceId);
      if (current?.get(endpointId) !== registration) return;
      current.delete(endpointId);
      if (current.size === 0) this.endpoints.delete(pluginInstanceId);
      this.emit(pluginInstanceId, endpointId);
    };
  }

  get(pluginInstanceId: string, endpointId: string): AgentMcpEndpointRegistration | undefined {
    return this.endpoints.get(pluginInstanceId)?.get(endpointId);
  }

  /** Drop every roster an instance registered. */
  unregisterPlugin(pluginInstanceId: string): void {
    const byEndpoint = this.endpoints.get(pluginInstanceId);
    if (!byEndpoint) return;
    this.endpoints.delete(pluginInstanceId);
    for (const endpointId of byEndpoint.keys()) this.emit(pluginInstanceId, endpointId);
  }

  /** Fires after any roster for an endpoint is bound, replaced or dropped. */
  onDidChange(listener: RegistryListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  clear(): void {
    this.endpoints.clear();
  }

  private emit(pluginInstanceId: string, endpointId: string): void {
    for (const listener of this.listeners) {
      try {
        listener(pluginInstanceId, endpointId);
      } catch (err) {
        console.error("[PluginAgentMcp] registry listener threw:", err);
      }
    }
  }
}

export const agentMcpEndpointRegistry = new AgentMcpEndpointRegistry();
