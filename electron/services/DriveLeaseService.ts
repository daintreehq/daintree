import { CHANNELS } from "../ipc/channels.js";
import { LOCAL_CLIENT_ID } from "../ipc/endpoint.js";
import type { ClientEndpoint, ClientRef, EndpointRegistry } from "../ipc/endpoint.js";
import { getEndpointRegistry } from "../ipc/endpointRegistry.js";
import { getLocalClientRef } from "../ipc/localEndpoint.js";
import { AppError } from "../utils/errorTypes.js";
import { getPtyClient } from "../window/serviceRefs.js";
import type { DriveLeaseHolder, DriveLeaseState } from "../../shared/types/remoteHosts.js";
import type { DriveLeaseEvent, DriveLeaseView } from "../../shared/types/ipc/driveLease.js";

/**
 * How long a lease stays reserved for its client after the holder's endpoint
 * closes. A dropped link already keeps its endpoints through the session's
 * resume window, so this only has to cover a view that reopens under a new
 * endpoint (a reload, a re-attached session).
 */
export const DEFAULT_DRIVE_LEASE_RELEASE_GRACE_MS = 15_000;

type LeaseRegistry = Pick<EndpointRegistry, "get" | "getForProject" | "getRemote" | "onChange">;

export interface DriveLeaseServiceOptions {
  registry?: LeaseRegistry;
  releaseGraceMs?: number;
  now?: () => number;
  /**
   * Receives the projects this machine's own windows may not resize (another
   * client drives them). Defaults to the pty-host through PtyClient.
   */
  applyResizeLease?: (projectIds: string[]) => void;
}

interface ProjectLease {
  holder: DriveLeaseHolder;
  /** Set while the holder's endpoint is gone and the lease waits for its client to come back. */
  releaseTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * One frontend drives a host project at a time; this is the Host's arbiter.
 *
 * The lease is enforced between clients, never within one: every window of the
 * holder's client keeps driving (two local windows behave exactly as they did
 * before), while another client's windows are driven elsewhere until they take
 * over. The holder endpoint is the single renderer that MCP dispatch and plugin
 * prompts target. The terminal resize lease follows it.
 */
export class DriveLeaseService {
  private readonly registry: LeaseRegistry;
  private readonly releaseGraceMs: number;
  private readonly now: () => number;
  private readonly applyResizeLease: (projectIds: string[]) => void;
  private readonly leases = new Map<string, ProjectLease>();
  private readonly clients = new Map<string, ClientRef>();
  private readonly listeners = new Set<(state: DriveLeaseState) => void>();
  private readonly offRegistry: () => void;
  private nextLeaseId = 1;
  private reconcileQueued = false;
  private publishedResizeLease = "";
  private disposed = false;

  constructor(options: DriveLeaseServiceOptions = {}) {
    this.registry = options.registry ?? getEndpointRegistry();
    this.releaseGraceMs = options.releaseGraceMs ?? DEFAULT_DRIVE_LEASE_RELEASE_GRACE_MS;
    this.now = options.now ?? Date.now;
    this.applyResizeLease =
      options.applyResizeLease ??
      ((projectIds) => getPtyClient()?.setResizeHeldElsewhere(projectIds));
    this.offRegistry = this.registry.onChange(() => this.queueReconcile());
    this.queueReconcile();
  }

  /**
   * Record who a remote endpoint belongs to, so the holder can name the
   * machine. The remote session layer calls it when an endpoint opens; the
   * entry goes when the endpoint closes.
   */
  noteEndpointClient(endpointId: string, client: ClientRef): void {
    if (this.disposed) return;
    this.clients.set(endpointId, client);
    // A lease granted before the note arrived names the machine by its id.
    for (const [projectId, lease] of this.leases) {
      const { holder } = lease;
      if (holder.endpointId !== endpointId || holder.clientName === client.clientName) continue;
      lease.holder = { ...holder, clientName: client.clientName };
      this.publish(projectId, lease.holder);
    }
  }

  /** Every holder change, for the remote session layer's LEASE_CHANGED frames. */
  onChange(listener: (state: DriveLeaseState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * The project's holder, granting it to the first attached endpoint when
   * nobody holds it. May name an endpoint that has just closed while its
   * client's reservation runs; use {@link getHolderEndpoint} to reach it.
   */
  getHolder(projectId: string): DriveLeaseHolder | null {
    this.reconcileProject(projectId);
    return this.leases.get(projectId)?.holder ?? null;
  }

  getState(projectId: string): DriveLeaseState {
    return { projectId, holder: this.getHolder(projectId) };
  }

  /** The live renderer that drives the project, or null when there is none attached. */
  getHolderEndpoint(projectId: string): ClientEndpoint | null {
    const holder = this.getHolder(projectId);
    if (!holder) return null;
    const endpoint = this.registry.get(holder.endpointId);
    // During a reservation the holder may have moved to another project.
    return endpoint && !endpoint.isClosed() && endpoint.projectId === projectId ? endpoint : null;
  }

  /** The project's lease as one endpoint sees it. */
  viewFor(projectId: string, endpoint: ClientEndpoint | null | undefined): DriveLeaseView {
    return this.buildView(projectId, this.getHolder(projectId), endpoint);
  }

  /**
   * Whether `endpoint` drives the project: its client holds the lease, or
   * nobody does. Resize, and later terminal input, are gated on this.
   */
  isDriving(projectId: string, endpoint: Pick<ClientEndpoint, "clientId">): boolean {
    const holder = this.getHolder(projectId);
    return holder === null || holder.clientId === endpoint.clientId;
  }

  /**
   * Hand the lease to `endpoint`. Explicit and always granted: the previous
   * driver's screen shows it has been taken, with the option to take it back.
   */
  takeOver(projectId: string, endpoint: ClientEndpoint): DriveLeaseHolder {
    if (this.disposed) {
      throw new AppError({ code: "UNSUPPORTED", message: "The drive lease service has stopped" });
    }
    if (endpoint.isClosed() || endpoint.projectId !== projectId) {
      throw new AppError({
        code: "VALIDATION",
        message: "Only a view attached to the project can take it over",
        userMessage: "This window isn't showing that project.",
      });
    }
    const current = this.leases.get(projectId);
    if (current && current.holder.endpointId === endpoint.endpointId) return current.holder;
    return this.grant(projectId, endpoint);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.offRegistry();
    for (const lease of this.leases.values()) {
      if (lease.releaseTimer) clearTimeout(lease.releaseTimer);
    }
    this.leases.clear();
    this.clients.clear();
    this.listeners.clear();
    this.publishResizeLease();
  }

  /**
   * Deferred a microtask so an endpoint that has just been added is fully
   * opened (its client noted) before a lease names it.
   */
  private queueReconcile(): void {
    if (this.reconcileQueued || this.disposed) return;
    this.reconcileQueued = true;
    queueMicrotask(() => {
      this.reconcileQueued = false;
      this.reconcileAll();
    });
  }

  private reconcileAll(): void {
    if (this.disposed) return;
    for (const [endpointId] of this.clients) {
      const endpoint = this.registry.get(endpointId);
      if (!endpoint || endpoint.isClosed()) this.clients.delete(endpointId);
    }
    const projects = new Set(this.leases.keys());
    for (const projectId of this.attachedProjects()) projects.add(projectId);
    for (const projectId of projects) this.reconcileProject(projectId);
  }

  /**
   * Local views read their project live and are not indexed by it, so only
   * remote endpoints announce projects here. A project only local windows
   * show gets its lease lazily, the first time anything asks.
   */
  private attachedProjects(): string[] {
    const out: string[] = [];
    for (const endpoint of this.registry.getRemote()) {
      if (endpoint.projectId) out.push(endpoint.projectId);
    }
    return out;
  }

  private reconcileProject(projectId: string): void {
    if (this.disposed) return;
    const lease = this.leases.get(projectId);
    const attached = this.registry.getForProject(projectId);
    if (!lease) {
      const first = attached[0];
      if (first) this.grant(projectId, first);
      return;
    }
    const holderEndpoint = this.registry.get(lease.holder.endpointId);
    const holderAttached =
      holderEndpoint !== undefined &&
      !holderEndpoint.isClosed() &&
      holderEndpoint.projectId === projectId;
    if (holderAttached) {
      if (lease.releaseTimer) {
        clearTimeout(lease.releaseTimer);
        lease.releaseTimer = null;
      }
      return;
    }
    // Another window of the same client carries on driving without a gap.
    const sameClient = attached.find((endpoint) => endpoint.clientId === lease.holder.clientId);
    if (sameClient) {
      this.grant(projectId, sameClient);
      return;
    }
    if (lease.releaseTimer) return;
    lease.releaseTimer = setTimeout(() => this.release(projectId, lease), this.releaseGraceMs);
    lease.releaseTimer.unref?.();
  }

  private release(projectId: string, lease: ProjectLease): void {
    if (this.leases.get(projectId) !== lease) return;
    lease.releaseTimer = null;
    const next = this.registry.getForProject(projectId)[0];
    if (next) {
      this.grant(projectId, next);
      return;
    }
    this.leases.delete(projectId);
    this.publish(projectId, null);
  }

  private grant(projectId: string, endpoint: ClientEndpoint): DriveLeaseHolder {
    const previous = this.leases.get(projectId);
    if (previous?.releaseTimer) clearTimeout(previous.releaseTimer);
    const client = this.clientOf(endpoint);
    const holder: DriveLeaseHolder = {
      leaseId: this.nextLeaseId++,
      endpointId: endpoint.endpointId,
      clientId: endpoint.clientId,
      clientName: client?.clientName ?? endpoint.clientId,
      isHostLocal: endpoint.kind === "local-view",
      acquiredAt: this.now(),
    };
    this.leases.set(projectId, { holder, releaseTimer: null });
    this.publish(projectId, holder);
    return holder;
  }

  private clientOf(endpoint: ClientEndpoint): ClientRef | null {
    if (endpoint.kind === "local-view" || endpoint.clientId === LOCAL_CLIENT_ID) {
      return getLocalClientRef();
    }
    return this.clients.get(endpoint.endpointId) ?? null;
  }

  private buildView(
    projectId: string,
    holder: DriveLeaseHolder | null,
    endpoint: ClientEndpoint | null | undefined
  ): DriveLeaseView {
    const clientId = endpoint?.clientId ?? LOCAL_CLIENT_ID;
    return {
      projectId,
      holder,
      drivingHere: holder === null || holder.clientId === clientId,
      isHolderEndpoint: holder !== null && endpoint?.endpointId === holder.endpointId,
      viewerIsHostLocal: endpoint ? endpoint.kind === "local-view" : true,
    };
  }

  private publish(projectId: string, holder: DriveLeaseHolder | null): void {
    this.publishResizeLease();
    for (const endpoint of this.registry.getForProject(projectId)) {
      const event: DriveLeaseEvent = {
        type: "changed",
        state: this.buildView(projectId, holder, endpoint),
      };
      try {
        endpoint.send({ type: "event", channel: CHANNELS.DRIVE_LEASE_EVENT, args: [event] });
      } catch {
        // A closing endpoint must not keep the others from hearing about it.
      }
    }
    const state: DriveLeaseState = { projectId, holder };
    for (const listener of [...this.listeners]) {
      try {
        listener(state);
      } catch (error) {
        console.error("[DriveLease] change listener failed:", error);
      }
    }
  }

  /** Projects another client drives: this machine's own windows must not resize their terminals. */
  private publishResizeLease(): void {
    const heldElsewhere: string[] = [];
    if (!this.disposed) {
      for (const [projectId, lease] of this.leases) {
        if (lease.holder.clientId !== LOCAL_CLIENT_ID) heldElsewhere.push(projectId);
      }
    }
    heldElsewhere.sort();
    const serialized = JSON.stringify(heldElsewhere);
    if (serialized === this.publishedResizeLease) return;
    // Nothing to tell a pty-host that has never heard of a lease.
    if (this.publishedResizeLease === "" && heldElsewhere.length === 0) return;
    this.publishedResizeLease = serialized;
    try {
      this.applyResizeLease(heldElsewhere);
    } catch (error) {
      console.error("[DriveLease] Failed to publish the resize lease:", error);
    }
  }
}

let service: DriveLeaseService | null = null;

export function getDriveLeaseService(): DriveLeaseService {
  service ??= new DriveLeaseService();
  return service;
}

/**
 * The service if something has started it (Host mode does), without starting
 * one: a check on a local-only path must not begin arbitrating leases.
 */
export function peekDriveLeaseService(): DriveLeaseService | null {
  return service;
}

/** @internal Tests only. */
export function _resetDriveLeaseServiceForTesting(next: DriveLeaseService | null = null): void {
  service?.dispose();
  service = next;
}
