import { hostname } from "node:os";
import type { WebContents } from "electron";
import { getProjectForWebContents } from "../window/webContentsRegistry.js";
import { AppError } from "../utils/errorTypes.js";
import { LOCAL_CLIENT_ID } from "./endpoint.js";
import type { ClientEndpoint, ClientRef, Disposable, HostFrame } from "./endpoint.js";
import { getEndpointRegistry } from "./endpointRegistry.js";

let localClient: ClientRef | null = null;

/** The Shell of this process, shared by every local view. */
export function getLocalClientRef(): ClientRef {
  localClient ??= {
    clientId: LOCAL_CLIENT_ID,
    clientName: safeHostname(),
    platform: process.platform as ClientRef["platform"],
    kind: "local",
  };
  return localClient;
}

function safeHostname(): string {
  try {
    return hostname();
  } catch {
    return "localhost";
  }
}

/**
 * A local project view seen as an endpoint. The project binding is read live
 * from the view registry rather than cached, so a view that is rebound to
 * another project is addressed correctly without a rebind notification.
 */
class LocalViewEndpoint implements ClientEndpoint {
  readonly kind = "local-view" as const;
  readonly clientId = LOCAL_CLIENT_ID;
  readonly endpointId: string;
  readonly handle: number;
  private closed = false;
  private readonly closeListeners = new Set<() => void>();

  constructor(readonly webContents: WebContents) {
    this.handle = webContents.id;
    this.endpointId = `local:${webContents.id}`;
  }

  get projectId(): string | null {
    return getProjectForWebContents(this.handle);
  }

  send(frame: HostFrame): void {
    if (this.closed) return;
    const wc = this.webContents;
    if (typeof wc.isDestroyed === "function" && wc.isDestroyed()) return;
    try {
      wc.send(frame.channel, ...frame.args);
    } catch {
      // Silently ignore send failures during view initialization/disposal.
    }
  }

  /**
   * Local views answer server → client requests through their existing
   * request/response IPC channels (MCP dispatch, plugin prompts), so there is
   * nothing to correlate here yet.
   */
  request(method: string): Promise<unknown> {
    return Promise.reject(
      new AppError({
        code: "UNSUPPORTED",
        message: `Local view endpoints do not accept requests (${method})`,
      })
    );
  }

  onClose(cb: () => void): Disposable {
    if (this.closed) {
      queueMicrotask(cb);
      return { dispose: () => {} };
    }
    this.closeListeners.add(cb);
    return {
      dispose: () => {
        this.closeListeners.delete(cb);
      },
    };
  }

  isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const listeners = [...this.closeListeners];
    this.closeListeners.clear();
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        console.error("[LocalViewEndpoint] close listener failed:", error);
      }
    }
  }
}

const endpointsByWebContentsId = new Map<number, LocalViewEndpoint>();

/**
 * The endpoint for a local sender, created on first use and disposed when its
 * `WebContents` is destroyed.
 */
export function getLocalEndpoint(webContents: WebContents): ClientEndpoint {
  const existing = endpointsByWebContentsId.get(webContents.id);
  if (existing && existing.webContents === webContents && !existing.isClosed()) {
    return existing;
  }
  if (existing) disposeLocalEndpoint(webContents.id);

  const endpoint = new LocalViewEndpoint(webContents);
  // `destroyed` has already fired for a dead sender; registering it would leak.
  if (typeof webContents.isDestroyed === "function" && webContents.isDestroyed()) {
    endpoint.close();
    return endpoint;
  }
  endpointsByWebContentsId.set(webContents.id, endpoint);
  getEndpointRegistry().add(endpoint);
  if (typeof webContents.once === "function") {
    webContents.once("destroyed", () => {
      if (endpointsByWebContentsId.get(endpoint.handle) === endpoint) {
        disposeLocalEndpoint(endpoint.handle);
      }
    });
  }
  return endpoint;
}

export function disposeLocalEndpoint(webContentsId: number): void {
  const endpoint = endpointsByWebContentsId.get(webContentsId);
  if (!endpoint) return;
  endpointsByWebContentsId.delete(webContentsId);
  endpoint.close();
  getEndpointRegistry().remove(endpoint.endpointId);
}

/** @internal Tests only. */
export function _resetLocalEndpointsForTesting(): void {
  for (const endpoint of endpointsByWebContentsId.values()) endpoint.close();
  endpointsByWebContentsId.clear();
  localClient = null;
}
