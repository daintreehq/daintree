import type {
  ClientEndpoint,
  Disposable,
  EndpointRequestOptions,
  HostFrame,
} from "../../ipc/endpoint.js";
import { AppError } from "../../utils/errorTypes.js";

/**
 * How a remote endpoint reaches its Shell: the session it currently rides,
 * which changes when a dropped link is resumed.
 */
export interface RemoteEndpointTransport {
  sendEvent(endpoint: RemoteViewEndpoint, frame: HostFrame): void;
  request(
    endpoint: RemoteViewEndpoint,
    method: string,
    payload: unknown,
    options: EndpointRequestOptions | undefined
  ): Promise<unknown>;
}

let nextHandle = -1;

/**
 * Negative and never reused within a process, so a remote handle can't collide
 * with a `WebContents` id or with an endpoint that has since closed.
 */
export function allocateRemoteHandle(): number {
  const handle = nextHandle;
  nextHandle = handle <= -Number.MAX_SAFE_INTEGER ? -1 : handle - 1;
  return handle;
}

function disconnected(message: string): AppError {
  return new AppError({
    code: "HOST_DISCONNECTED",
    message,
    userMessage: "The window that was asked is no longer attached.",
  });
}

/**
 * One renderer on a remote Shell, as the Host sees it. `endpointId` is unique
 * on this Host (namespaced by session); `clientEndpointId` is the Shell's own
 * name for it and is what crosses the link.
 */
export class RemoteViewEndpoint implements ClientEndpoint {
  readonly kind = "remote-view" as const;
  readonly endpointId: string;
  readonly clientEndpointId: string;
  readonly clientId: string;
  readonly handle: number;
  projectId: string | null;
  /** Bumped on every rebind; answers to requests made under an older binding are stale. */
  generation = 0;
  private closed = false;
  private readonly closeListeners = new Set<() => void>();
  private readonly pending = new Set<(error: Error) => void>();

  constructor(
    params: {
      endpointId: string;
      clientEndpointId: string;
      clientId: string;
      projectId: string | null;
      handle?: number;
    },
    private readonly transport: RemoteEndpointTransport
  ) {
    this.endpointId = params.endpointId;
    this.clientEndpointId = params.clientEndpointId;
    this.clientId = params.clientId;
    this.projectId = params.projectId;
    this.handle = params.handle ?? allocateRemoteHandle();
  }

  send(frame: HostFrame): void {
    if (this.closed) return;
    this.transport.sendEvent(this, frame);
  }

  request(method: string, payload: unknown, options?: EndpointRequestOptions): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(disconnected(`Endpoint ${this.endpointId} is closed (${method})`));
    }
    const generation = this.generation;
    return new Promise<unknown>((resolve, reject) => {
      const fail = (error: Error) => {
        if (!this.pending.delete(fail)) return;
        reject(error);
      };
      this.pending.add(fail);
      this.transport.request(this, method, payload, options).then(
        (value) => {
          if (!this.pending.delete(fail)) return;
          if (generation !== this.generation) {
            reject(
              new AppError({
                code: "STALE_GENERATION",
                message: `Answer to ${method} arrived after the endpoint was rebound`,
              })
            );
            return;
          }
          resolve(value);
        },
        (error: unknown) => fail(error instanceof Error ? error : new Error(String(error)))
      );
    });
  }

  /** The registry moves `projectId`; this makes anything asked under the old binding stale. */
  markRebound(): void {
    this.generation++;
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
    for (const fail of [...this.pending]) {
      fail(disconnected(`Endpoint ${this.endpointId} closed before it answered`));
    }
    const listeners = [...this.closeListeners];
    this.closeListeners.clear();
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        console.error("[RemoteViewEndpoint] close listener failed:", error);
      }
    }
  }
}
