import { randomUUID } from "node:crypto";
import type { ClientRef } from "../../ipc/endpoint.js";
import {
  isCanopyHostChannel,
  type CanopyHostEvent,
  type CanopyHostPushChannel,
} from "../../../shared/types/ipc/canopyHost.js";
import type { CanopySnapshot, CanopyTerminalData } from "../../../shared/types/ipc/canopy.js";
import type { FleetSnapshot } from "../../../shared/types/ipc/fleet.js";
import { isIpcEnvelope } from "../../../shared/types/ipc/errors.js";
import { LOCAL_HOST_ID, isLocalHostId, type HostId } from "../../../shared/types/remoteHosts.js";
import { deserializeError } from "../../../shared/utils/ipcErrorSerialization.js";
import { AppError } from "../../utils/errorTypes.js";
import type { EventMessage } from "../link/messages.js";
import { CANOPY_VIEWER_ENDPOINT_PREFIX, CanopyLinkMethod } from "./linkMethods.js";
import type { CanopyViewers } from "./viewer.js";

export interface CanopyHostConnection {
  callHost(method: string, payload: unknown): Promise<unknown>;
}

export interface CanopyHostsClientOptions {
  manager: {
    get(hostId: HostId): CanopyHostConnection | undefined;
    connect(hostId: HostId): unknown;
    touch(hostId: HostId): void;
    addUseCheck(check: (hostId: HostId) => boolean): () => void;
    onSessionOpened(listener: (hostId: HostId) => void): () => void;
    onViewerEvent(listener: (hostId: HostId, event: EventMessage) => void): () => void;
  };
  registry: {
    get(hostId: HostId): unknown;
    onChange(listener: () => void): () => void;
  };
  /** The host a view is bound to, or null for one of this machine's. */
  hostForView(webContentsId: number): HostId | null;
  /** This machine's Canopy, for a remote-bound view reading This Mac. */
  local: CanopyViewers;
  localClient: ClientRef;
  /** Push to one view; false when it is gone. */
  send(webContentsId: number, event: CanopyHostEvent): boolean;
  /** Told once when the view reloads or goes away, which ends every panel it showed. */
  watchView(webContentsId: number, onGone: () => void): () => void;
  newViewerId?: () => string;
}

interface Subscription {
  webContentsId: number;
  hostId: HostId;
  viewerId: string;
}

interface ViewRecord {
  hosts: Map<HostId, Subscription>;
  unwatch: () => void;
}

function invalid(message: string): AppError {
  return new AppError({ code: "VALIDATION", message });
}

function eventFor(
  hostId: HostId,
  channel: CanopyHostPushChannel,
  payload: unknown
): CanopyHostEvent {
  switch (channel) {
    case "canopy:snapshot-updated":
      return { kind: "canopy-snapshot", hostId, snapshot: payload as CanopySnapshot };
    case "fleet:snapshot-updated":
      return { kind: "fleet-snapshot", hostId, snapshot: payload as FleetSnapshot };
    case "canopy:terminal-data":
      return { kind: "terminal-data", hostId, chunk: payload as CanopyTerminalData };
  }
}

/**
 * Canopy reading a host the view isn't bound to: another remote host, or This
 * Mac from a remote-bound view. A view's own host is never reached this way;
 * its Canopy calls take the view's ordinary route, exactly as before.
 *
 * Each view gets one viewer per host it reads, which the host serves with its
 * own Canopy handlers and consent. Its pushes come back tagged with the id
 * this Shell knows the host by, and the link stays up while any view reads it.
 */
export class CanopyHostsClient {
  private readonly views = new Map<number, ViewRecord>();
  private readonly byViewer = new Map<string, Subscription>();
  private readonly disposers: Array<() => void> = [];

  constructor(private readonly options: CanopyHostsClientOptions) {}

  start(): void {
    const { manager, registry } = this.options;
    this.disposers.push(
      manager.addUseCheck((hostId) => this.isRead(hostId)),
      manager.onViewerEvent((hostId, event) => this.onViewerEvent(hostId, event)),
      // A fresh or resumed link: the host's viewers went with the old one.
      manager.onSessionOpened((hostId) => this.resync(hostId)),
      registry.onChange(() => this.dropRemovedHosts())
    );
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
    for (const webContentsId of [...this.views.keys()]) this.releaseView(webContentsId);
    this.options.local.dispose();
  }

  /** Whether any view reads the host through Canopy right now. */
  isRead(hostId: HostId): boolean {
    for (const sub of this.byViewer.values()) if (sub.hostId === hostId) return true;
    return false;
  }

  async invoke(
    webContentsId: number,
    hostId: unknown,
    channel: unknown,
    args: unknown
  ): Promise<unknown> {
    const target = this.targetOf(webContentsId, hostId);
    if (!isCanopyHostChannel(channel)) {
      throw invalid(`${String(channel)} can't be called on another host's Canopy`);
    }
    if (!Array.isArray(args)) throw invalid("args must be an array");
    const sub = this.subscribe(webContentsId, target);
    if (isLocalHostId(target)) {
      const envelope = await this.options.local.invoke(
        sub.viewerId,
        () => ({
          endpointId: CANOPY_VIEWER_ENDPOINT_PREFIX + sub.viewerId,
          clientId: this.options.localClient.clientId,
          kind: "local-view",
          onPush: (pushed, payload) => {
            if (this.byViewer.get(sub.viewerId) !== sub) return;
            this.options.send(webContentsId, eventFor(LOCAL_HOST_ID, pushed, payload));
          },
        }),
        this.options.localClient,
        channel,
        args
      );
      if (!envelope.ok) throw deserializeError(envelope.error);
      return envelope.data;
    }
    this.options.manager.touch(target);
    const connection = this.options.manager.get(target);
    if (!connection) {
      // Dialled now; the view hears `resync` once it's up and asks again.
      this.options.manager.connect(target);
      throw new AppError({
        code: "HOST_DISCONNECTED",
        message: `Host ${target} is not connected`,
        userMessage: "Couldn't reach this host. Check that it is on and try again.",
      });
    }
    const answer = await connection.callHost(CanopyLinkMethod.INVOKE, {
      viewerId: sub.viewerId,
      channel,
      args,
    });
    if (!isIpcEnvelope(answer)) {
      throw new AppError({ code: "INTERNAL", message: `Host ${target} sent an invalid answer` });
    }
    if (!answer.ok) throw deserializeError(answer.error);
    return answer.data;
  }

  /** The view's panel stopped reading the host: its state there goes too. */
  release(webContentsId: number, hostId: unknown): void {
    if (typeof hostId !== "string") return;
    const record = this.views.get(webContentsId);
    const sub = record?.hosts.get(isLocalHostId(hostId) ? LOCAL_HOST_ID : hostId);
    if (!record || !sub) return;
    this.drop(sub);
    if (record.hosts.size === 0) {
      this.views.delete(webContentsId);
      record.unwatch();
    }
  }

  private targetOf(webContentsId: number, hostId: unknown): HostId {
    if (typeof hostId !== "string" || hostId.length === 0 || hostId.length > 64) {
      throw invalid("hostId must be a non-empty string");
    }
    const target = isLocalHostId(hostId) ? LOCAL_HOST_ID : hostId;
    if (!isLocalHostId(target) && !this.options.registry.get(target)) {
      throw new AppError({
        code: "NOT_FOUND",
        message: `No host with id "${target}"`,
        userMessage: "That host isn't in the host list.",
      });
    }
    const own = this.options.hostForView(webContentsId) ?? LOCAL_HOST_ID;
    if (own === target) {
      throw invalid("A view's own host is read through its own Canopy, not by naming it");
    }
    return target;
  }

  private subscribe(webContentsId: number, hostId: HostId): Subscription {
    let record = this.views.get(webContentsId);
    if (!record) {
      const created: ViewRecord = { hosts: new Map(), unwatch: () => {} };
      this.views.set(webContentsId, created);
      created.unwatch = this.options.watchView(webContentsId, () => {
        if (this.views.get(webContentsId) === created) this.releaseView(webContentsId);
      });
      record = created;
    }
    let sub = record.hosts.get(hostId);
    if (!sub) {
      const viewerId = this.options.newViewerId?.() ?? randomUUID();
      sub = { webContentsId, hostId, viewerId };
      record.hosts.set(hostId, sub);
      this.byViewer.set(viewerId, sub);
    }
    return sub;
  }

  private drop(sub: Subscription): void {
    if (this.byViewer.get(sub.viewerId) !== sub) return;
    this.byViewer.delete(sub.viewerId);
    this.views.get(sub.webContentsId)?.hosts.delete(sub.hostId);
    if (isLocalHostId(sub.hostId)) {
      this.options.local.close(sub.viewerId);
      return;
    }
    this.options.manager
      .get(sub.hostId)
      ?.callHost(CanopyLinkMethod.RELEASE, { viewerId: sub.viewerId })
      .catch(() => {
        // A host that can't hear it now dropped the viewer with its link.
      });
    // The idle release counts from the last panel reading the host, not from its first.
    this.options.manager.touch(sub.hostId);
  }

  private releaseView(webContentsId: number): void {
    const record = this.views.get(webContentsId);
    if (!record) return;
    this.views.delete(webContentsId);
    record.unwatch();
    for (const sub of [...record.hosts.values()]) this.drop(sub);
  }

  private onViewerEvent(hostId: HostId, event: EventMessage): void {
    const viewerId = event.endpointId?.slice(CANOPY_VIEWER_ENDPOINT_PREFIX.length);
    const sub = viewerId === undefined ? undefined : this.byViewer.get(viewerId);
    // Only the host the viewer was opened on speaks for it.
    if (!sub || sub.hostId !== hostId) return;
    const channel = event.channel;
    if (
      channel !== "canopy:snapshot-updated" &&
      channel !== "fleet:snapshot-updated" &&
      channel !== "canopy:terminal-data"
    ) {
      return;
    }
    this.options.send(sub.webContentsId, eventFor(hostId, channel, event.args[0]));
  }

  private resync(hostId: HostId): void {
    for (const sub of [...this.byViewer.values()]) {
      if (sub.hostId !== hostId) continue;
      if (!this.options.send(sub.webContentsId, { kind: "resync", hostId })) {
        this.releaseView(sub.webContentsId);
      }
    }
  }

  private dropRemovedHosts(): void {
    for (const sub of [...this.byViewer.values()]) {
      if (isLocalHostId(sub.hostId) || this.options.registry.get(sub.hostId)) continue;
      this.drop(sub);
      const record = this.views.get(sub.webContentsId);
      if (record && record.hosts.size === 0) {
        this.views.delete(sub.webContentsId);
        record.unwatch();
      }
    }
  }
}
