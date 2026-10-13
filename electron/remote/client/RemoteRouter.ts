import type { IpcEnvelope } from "../../../shared/types/ipc/errors.js";
import {
  isLocalHostId,
  parseHostScopedKey,
  type HostId,
} from "../../../shared/types/remoteHosts.js";
import type { RemoteRouter } from "../../ipc/endpoint.js";
import { hostDisconnectedEnvelope } from "../link/envelopes.js";
import type { RemoteHostManager } from "./RemoteHostManager.js";
import type { WindowHostBinding } from "./WindowHostBinding.js";

/** A call this Shell is forwarding to a host on behalf of one of its own views. */
export interface ForwardedInvoke {
  hostId: HostId;
  webContentsId: number;
  /** The view's project as the host knows it, from this machine's own view key. */
  hostProjectId: string | null;
  channel: string;
  args: unknown[];
}

const forwardObservers = new Set<(call: ForwardedInvoke) => void>();

/**
 * Watch calls the Shell forwarded that the host answered successfully, for
 * Shell-side records of what its views had a host create (a dev preview's
 * origin, for one). A refused or failed call is never reported.
 */
export function observeForwardedInvokes(observer: (call: ForwardedInvoke) => void): () => void {
  forwardObservers.add(observer);
  return () => forwardObservers.delete(observer);
}

export interface SenderLookup {
  /** The view's host-scoped project key, or null for a view with no project. */
  projectKeyFor(webContentsId: number): string | null;
  windowIdFor(webContentsId: number): number | null;
  /** Run `callback` once the sender's WebContents is destroyed. */
  onGone?(webContentsId: number, callback: () => void): void;
}

interface RetainedRoute {
  /** The host the view's calls last went to, null for this machine. */
  hostId: HostId | null;
  /** The view's host-scoped project key, or null for a view that had none. */
  projectKey: string | null;
}

/**
 * Decides, per sender, whether a call leaves this machine. A project view's
 * host is part of its key (`toHostScopedKey`), so a local view is never
 * forwarded even inside a window attached to a host; a view with no project
 * yet (the project picker) follows its window's binding.
 *
 * A view keeps its last route once the lookups stop knowing it: the view
 * lifecycle unregisters a view (and a closing window) before closing it, and
 * the close still fires the view's flushes (layout, drafts, terminal kills).
 * Answered by whatever the window is bound to by then, a host project at the
 * same path as a local clone would write over the local project's state, and
 * a local view's would land on the host.
 */
export class RemoteRouterImpl implements RemoteRouter {
  private readonly retained = new Map<number, RetainedRoute>();

  constructor(
    private readonly manager: RemoteHostManager,
    private readonly bindings: WindowHostBinding,
    private readonly senders: SenderLookup
  ) {}

  hostForSender(webContentsId: number): HostId | null {
    const key = this.senders.projectKeyFor(webContentsId);
    if (key !== null) return this.retain(webContentsId, hostOfKey(key), key);
    const last = this.retained.get(webContentsId);
    // A project view only loses its key when it is being torn down.
    if (last?.projectKey) return last.hostId;
    const windowId = this.senders.windowIdFor(webContentsId);
    if (windowId === null) return last?.hostId ?? null;
    const hostId = this.bindings.get(windowId);
    return this.retain(webContentsId, isLocalHostId(hostId) ? null : hostId, null);
  }

  forwardInvoke(
    hostId: HostId,
    webContentsId: number,
    channel: string,
    args: unknown[]
  ): Promise<IpcEnvelope> {
    const connection = this.manager.get(hostId);
    if (!connection) {
      return Promise.resolve(hostDisconnectedEnvelope(`host ${hostId} is not connected`));
    }
    const hostProjectId = this.hostProjectId(webContentsId);
    const call = connection.invoke(webContentsId, hostProjectId, channel, args);
    if (forwardObservers.size === 0) return call;
    return call.then((envelope) => {
      if (!envelope.ok) return envelope;
      for (const observer of forwardObservers) {
        try {
          observer({ hostId, webContentsId, hostProjectId, channel, args });
        } catch {
          // An observer must never change the call's answer.
        }
      }
      return envelope;
    });
  }

  forwardSend(hostId: HostId, webContentsId: number, channel: string, args: unknown[]): void {
    this.manager.get(hostId)?.send(webContentsId, this.hostProjectId(webContentsId), channel, args);
  }

  /** The project id as the host knows it: the bare id inside the view's key. */
  private hostProjectId(webContentsId: number): string | null {
    const key =
      this.senders.projectKeyFor(webContentsId) ??
      this.retained.get(webContentsId)?.projectKey ??
      null;
    return key === null ? null : parseHostScopedKey(key).projectId;
  }

  /** Kept for the life of the sender's WebContents, and dropped with it. */
  private retain(webContentsId: number, hostId: HostId | null, projectKey: string | null) {
    const known = this.retained.get(webContentsId);
    if (known) {
      known.hostId = hostId;
      known.projectKey = projectKey;
      return hostId;
    }
    this.retained.set(webContentsId, { hostId, projectKey });
    this.senders.onGone?.(webContentsId, () => this.retained.delete(webContentsId));
    return hostId;
  }
}

function hostOfKey(key: string): HostId | null {
  const { hostId } = parseHostScopedKey(key);
  return isLocalHostId(hostId) ? null : hostId;
}
