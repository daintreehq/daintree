import type { AgentMcpEndpointRegistration } from "./types.js";

type RegistryListener = (pluginInstanceId: string, endpointId: string) => void;

/** Which group each grouped tool of a roster is in, as one comparable string; empty with no groups. */
function groupingOf(registration: AgentMcpEndpointRegistration): string {
  return registration.tools
    .filter((tool) => tool.group !== undefined)
    .map((tool) => `${tool.name}=${tool.group!.id}:${tool.group!.access}`)
    .sort()
    .join(",");
}

/**
 * Live tool rosters, keyed by plugin instance then endpoint. Keyed by instance
 * and never by manifest id: two projects can each load their own copy of the
 * same project plugin, and dropping one must not drop the other.
 */
export class AgentMcpEndpointRegistry {
  private readonly endpoints = new Map<string, Map<string, AgentMcpEndpointRegistration>>();
  private readonly listeners = new Set<RegistryListener>();
  private readonly regroupListeners = new Set<RegistryListener>();
  /**
   * The last grouping each endpoint registered, kept after its roster is
   * dropped: a reload unregisters before the next generation registers, and
   * comparing against nothing would miss a tool that moved group across it.
   */
  private readonly groupings = new Map<string, Map<string, string>>();

  /**
   * Bind a roster, replacing any earlier one for the same endpoint. The
   * returned disposer removes this registration only — once a later
   * registration has replaced it, the disposer does nothing.
   */
  register(registration: AgentMcpEndpointRegistration): () => void {
    const { pluginInstanceId, endpointId } = registration;
    let groupings = this.groupings.get(pluginInstanceId);
    if (!groupings) {
      groupings = new Map();
      this.groupings.set(pluginInstanceId, groupings);
    }
    const grouping = groupingOf(registration);
    const previous = groupings.get(endpointId);
    groupings.set(endpointId, grouping);
    // Before the roster is bound, so no grant issued against the old grouping
    // ever lists or calls the new one.
    if (previous !== undefined && previous !== grouping)
      this.emitTo(this.regroupListeners, pluginInstanceId, endpointId);
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

  /**
   * Fires before a roster is bound whose tools sit in different groups from the
   * endpoint's last roster, this generation's or an earlier one's.
   */
  onDidRegroup(listener: RegistryListener): () => void {
    this.regroupListeners.add(listener);
    return () => {
      this.regroupListeners.delete(listener);
    };
  }

  clear(): void {
    this.endpoints.clear();
    this.groupings.clear();
  }

  private emit(pluginInstanceId: string, endpointId: string): void {
    this.emitTo(this.listeners, pluginInstanceId, endpointId);
  }

  private emitTo(
    listeners: ReadonlySet<RegistryListener>,
    pluginInstanceId: string,
    endpointId: string
  ): void {
    for (const listener of listeners) {
      try {
        listener(pluginInstanceId, endpointId);
      } catch (err) {
        console.error("[PluginAgentMcp] registry listener threw:", err);
      }
    }
  }
}

export const agentMcpEndpointRegistry = new AgentMcpEndpointRegistry();
