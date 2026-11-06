import type {
  ClientEndpoint,
  Disposable,
  EndpointGroup,
  EndpointRequestOptions,
  HostFrame,
  RemoteEndpointCloseCause,
} from "../../ipc/endpoint.js";
import { AppError } from "../../utils/errorTypes.js";
import { allocateRemoteHandle } from "../endpointHandles.js";

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
  /** The link session it belongs to, the id the Shell logs for the same link. */
  readonly linkSessionId: string;
  projectId: string | null;
  /** The Shell's name for this open of `clientEndpointId`; null from a Shell that names none. */
  readonly openId: string | null;
  /** Every endpoint of the same link session shares it. */
  readonly group: EndpointGroup | undefined;
  /** Bumped on every rebind; answers to requests made under an older binding are stale. */
  generation = 0;
  private closed = false;
  private _closeCause: RemoteEndpointCloseCause | null = null;
  private readonly closeListeners = new Set<() => void>();
  private readonly pending = new Set<(error: Error) => void>();

  constructor(
    params: {
      endpointId: string;
      clientEndpointId: string;
      clientId: string;
      linkSessionId: string;
      projectId: string | null;
      openId?: string | null;
      handle?: number;
      group?: EndpointGroup;
    },
    private readonly transport: RemoteEndpointTransport
  ) {
    this.endpointId = params.endpointId;
    this.clientEndpointId = params.clientEndpointId;
    this.clientId = params.clientId;
    this.linkSessionId = params.linkSessionId;
    this.projectId = params.projectId;
    this.openId = params.openId ?? null;
    this.group = params.group;
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

  /** Why it closed, readable by its close listeners; null while open or when nobody said. */
  get closeCause(): RemoteEndpointCloseCause | null {
    return this._closeCause;
  }

  close(cause?: RemoteEndpointCloseCause): void {
    if (this.closed) return;
    this.closed = true;
    this._closeCause = cause ?? null;
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
