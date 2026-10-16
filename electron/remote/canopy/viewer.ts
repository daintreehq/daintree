import type {
  ClientEndpoint,
  ClientRef,
  Disposable,
  EndpointInvocation,
  HostFrame,
} from "../../ipc/endpoint.js";
import type { IpcEnvelope } from "../../../shared/types/ipc/errors.js";
import type { CanopySnapshot } from "../../../shared/types/ipc/canopy.js";
import type { FleetSnapshot } from "../../../shared/types/ipc/fleet.js";
import {
  isCanopyHostChannel,
  isCanopyHostPushChannel,
  type CanopyHostPushChannel,
} from "../../../shared/types/ipc/canopyHost.js";
import { AppError } from "../../utils/errorTypes.js";
import { wrapSuccess } from "../../../shared/utils/ipcErrorSerialization.js";
import { allocateRemoteHandle } from "../endpointHandles.js";

export interface CanopyViewerParams {
  endpointId: string;
  clientId: string;
  /** A push the viewer's view should hear, already narrowed to Canopy's own. */
  onPush(channel: CanopyHostPushChannel, payload: unknown): void;
}

/** A Canopy panel this machine serves for a view that isn't one of its own. */
export interface CanopyViewer extends ClientEndpoint {
  close(): void;
}

/**
 * The caller a Canopy panel's calls run as on the machine it reads, when the
 * view showing it is bound elsewhere: a remote Shell's view reading this host,
 * or one of this Shell's remote-bound views reading This Mac.
 *
 * Like a viewless call's, it is never added to the endpoint registry, so no
 * broadcast, port, lease or plugin can address it. Canopy's handlers serve it
 * as they serve any remote view: its own handle keys its panel's state, and
 * closing it is that panel going away. It hears only Canopy's pushes.
 */
export function createCanopyViewer(params: CanopyViewerParams): CanopyViewer {
  const handle = allocateRemoteHandle();
  const listeners = new Set<() => void>();
  let closed = false;
  return {
    endpointId: params.endpointId,
    clientId: params.clientId,
    projectId: null,
    // A link caller wherever it runs, This Mac included: the dispatcher holds
    // it to the drive lease and the remote scope, as it does a remote view.
    kind: "remote-view",
    handle,
    send(frame: HostFrame): void {
      if (closed || !isCanopyHostPushChannel(frame.channel)) return;
      params.onPush(frame.channel, frame.args[0]);
    },
    request: (method) =>
      Promise.reject(
        new AppError({
          code: "UNSUPPORTED",
          message: `A Canopy viewer has no renderer to answer ${method}`,
        })
      ),
    onClose(cb: () => void): Disposable {
      if (closed) {
        queueMicrotask(cb);
        return { dispose: () => {} };
      }
      listeners.add(cb);
      return { dispose: () => listeners.delete(cb) };
    },
    isClosed: () => closed,
    close(): void {
      if (closed) return;
      closed = true;
      const pending = [...listeners];
      listeners.clear();
      for (const listener of pending) {
        try {
          listener();
        } catch (error) {
          console.error("[CanopyViewer] close listener failed:", error);
        }
      }
    },
  };
}

/** The snapshots every view of this machine is pushed, for viewers no broadcast reaches. */
export interface CanopyPushSource {
  observeCanopy(listener: (snapshot: CanopySnapshot) => void): () => void;
  /** Null while there is no fleet service yet; asked again on the next viewer. */
  observeFleet(listener: (snapshot: FleetSnapshot) => void): (() => void) | null;
}

export type CanopyViewerInvoke = (
  invocation: EndpointInvocation,
  channel: string,
  args: unknown[]
) => Promise<IpcEnvelope>;

export interface CanopyViewersDeps {
  source: CanopyPushSource;
  /** This machine's dispatcher, as a link call reaches it. */
  invoke: CanopyViewerInvoke;
}

/**
 * The viewers this machine serves, by a key their owner chooses. A viewer is
 * made by its first call and lasts until it is closed; this machine's
 * snapshots reach each one while any exists.
 */
export class CanopyViewers {
  private readonly viewers = new Map<string, CanopyViewer>();
  private offCanopy: (() => void) | null = null;
  private offFleet: (() => void) | null = null;

  constructor(private readonly deps: CanopyViewersDeps) {}

  /** Run one allowed Canopy call as the viewer `key`, making it with `params` if it's new. */
  invoke(
    key: string,
    params: () => CanopyViewerParams,
    client: ClientRef,
    channel: string,
    args: unknown[]
  ): Promise<IpcEnvelope> {
    if (!isCanopyHostChannel(channel)) {
      return Promise.reject(
        new AppError({
          code: "VALIDATION",
          message: `${channel} can't be called on another host's Canopy`,
        })
      );
    }
    let viewer = this.viewers.get(key);
    // An unwatch arriving after its panel was released ends nothing: it must
    // not open the panel again here to say so.
    if (!viewer && channel === "canopy:unwatch-terminal") {
      return Promise.resolve(wrapSuccess(undefined));
    }
    if (!viewer) {
      viewer = createCanopyViewer(params());
      this.viewers.set(key, viewer);
    }
    this.observe();
    return this.deps.invoke({ endpoint: viewer, client }, channel, args);
  }

  has(key: string): boolean {
    return this.viewers.has(key);
  }

  /** The panel went away: its state on this machine goes with it. */
  close(key: string): boolean {
    const viewer = this.viewers.get(key);
    if (!viewer) return false;
    this.viewers.delete(key);
    viewer.close();
    if (this.viewers.size === 0) this.unobserve();
    return true;
  }

  closeWhere(predicate: (key: string) => boolean): void {
    for (const key of [...this.viewers.keys()]) {
      if (predicate(key)) this.close(key);
    }
  }

  dispose(): void {
    this.closeWhere(() => true);
    this.unobserve();
  }

  private observe(): void {
    const fanOut = (channel: CanopyHostPushChannel, payload: unknown) => {
      const frame: HostFrame = { type: "event", channel, args: [payload] };
      for (const viewer of [...this.viewers.values()]) viewer.send(frame);
    };
    this.offCanopy ??= this.deps.source.observeCanopy((snapshot) =>
      fanOut("canopy:snapshot-updated", snapshot)
    );
    this.offFleet ??= this.deps.source.observeFleet((snapshot) =>
      fanOut("fleet:snapshot-updated", snapshot)
    );
  }

  private unobserve(): void {
    this.offCanopy?.();
    this.offCanopy = null;
    this.offFleet?.();
    this.offFleet = null;
  }
}
