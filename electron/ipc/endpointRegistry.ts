import type { ClientEndpoint, Disposable, EndpointRegistry } from "./endpoint.js";

interface Entry {
  endpoint: ClientEndpoint;
  closeSubscription: Disposable;
}

/**
 * Local views join lazily, on their first IPC call, and their project binding
 * is read live from the view registry, so `rebind` only moves remote
 * endpoints. Broadcast helpers still reach local views through `WebContents`
 * and ask this registry for remote endpoints only.
 */
export class EndpointRegistryImpl implements EndpointRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly byHandle = new Map<number, ClientEndpoint>();
  private remoteCount = 0;
  private readonly listeners = new Set<() => void>();

  add(endpoint: ClientEndpoint): void {
    if (this.entries.has(endpoint.endpointId)) this.detach(endpoint.endpointId);
    const closeSubscription = endpoint.onClose(() => {
      if (this.entries.get(endpoint.endpointId)?.endpoint === endpoint) {
        this.remove(endpoint.endpointId);
      }
    });
    this.entries.set(endpoint.endpointId, { endpoint, closeSubscription });
    this.byHandle.set(endpoint.handle, endpoint);
    if (endpoint.kind === "remote-view") this.remoteCount++;
    this.emitChange();
  }

  remove(endpointId: string): void {
    if (this.detach(endpointId)) this.emitChange();
  }

  get(endpointId: string): ClientEndpoint | undefined {
    return this.entries.get(endpointId)?.endpoint;
  }

  getByHandle(handle: number): ClientEndpoint | undefined {
    return this.byHandle.get(handle);
  }

  getForProject(projectId: string): ClientEndpoint[] {
    const result: ClientEndpoint[] = [];
    for (const { endpoint } of this.entries.values()) {
      if (endpoint.projectId === projectId && !endpoint.isClosed()) result.push(endpoint);
    }
    return result;
  }

  getRemote(): ClientEndpoint[] {
    const result: ClientEndpoint[] = [];
    if (this.remoteCount === 0) return result;
    for (const { endpoint } of this.entries.values()) {
      if (endpoint.kind === "remote-view" && !endpoint.isClosed()) result.push(endpoint);
    }
    return result;
  }

  /** Cheap guard for hot broadcast paths: true while any remote endpoint is attached. */
  hasRemote(): boolean {
    return this.remoteCount > 0;
  }

  rebind(endpointId: string, projectId: string | null): void {
    const endpoint = this.entries.get(endpointId)?.endpoint;
    if (!endpoint || endpoint.kind !== "remote-view") return;
    if (endpoint.projectId === projectId) return;
    endpoint.projectId = projectId;
    this.emitChange();
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private detach(endpointId: string): boolean {
    const entry = this.entries.get(endpointId);
    if (!entry) return false;
    this.entries.delete(endpointId);
    if (this.byHandle.get(entry.endpoint.handle) === entry.endpoint) {
      this.byHandle.delete(entry.endpoint.handle);
    }
    if (entry.endpoint.kind === "remote-view") this.remoteCount--;
    entry.closeSubscription.dispose();
    return true;
  }

  private emitChange(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        console.error("[EndpointRegistry] change listener failed:", error);
      }
    }
  }
}

let registry: EndpointRegistryImpl | null = null;

export function getEndpointRegistry(): EndpointRegistryImpl {
  registry ??= new EndpointRegistryImpl();
  return registry;
}

/** @internal Tests only. */
export function _resetEndpointRegistryForTesting(): void {
  registry = null;
}
