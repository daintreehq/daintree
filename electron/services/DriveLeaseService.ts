import { CHANNELS } from "../ipc/channels.js";
import { LOCAL_CLIENT_ID } from "../ipc/endpoint.js";
import type { ClientEndpoint, ClientRef, EndpointRegistry } from "../ipc/endpoint.js";
import { getEndpointRegistry } from "../ipc/endpointRegistry.js";
import { getLocalClientRef } from "../ipc/localEndpoint.js";
import { AppError } from "../utils/errorTypes.js";
import { getPtyClient } from "../window/serviceRefs.js";
import type { DriveLeaseHolder, DriveLeaseState } from "../../shared/types/remoteHosts.js";
import type { PtyHostDriveLease } from "../../shared/types/pty-host.js";
import type { DriveLeaseEvent, DriveLeaseView } from "../../shared/types/ipc/driveLease.js";

/**
 * How long a lease stays reserved for its client after the holder's link drops
 * or its endpoint closes: long enough for a resume or a reloaded view to take
 * it back, short enough that nobody else waits long on a machine that went.
 */
export const DEFAULT_DRIVE_LEASE_RELEASE_GRACE_MS = 15_000;

type LeaseRegistry = Pick<EndpointRegistry, "get" | "getForProject" | "getRemote" | "onChange">;

export interface DriveLeaseServiceOptions {
  registry?: LeaseRegistry;
  releaseGraceMs?: number;
  now?: () => number;
  /**
   * Receives the leases a remote client is party to, for the pty-host to
   * enforce on port input and resizes. Defaults to the pty-host through
   * PtyClient.
   */
  applyDriveLeases?: (leases: PtyHostDriveLease[]) => void;
}

interface ProjectLease {
  holder: DriveLeaseHolder;
  /** The holder endpoint's handle, which is its pty-host port connection id. */
  holderHandle: number;
  /** Set while the holder is away and the lease waits for it, or its client, to come back. */
  releaseTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Who MCP dispatch should reach for a project. `reserved` is a holder that is
 * away (its link dropped, its view closed or moved) inside its grace window:
 * nobody else may act in its place until the grace runs out.
 */
export type DriveTarget =
  | { kind: "vacant" }
  | { kind: "reserved"; holder: DriveLeaseHolder }
  | { kind: "live"; holder: DriveLeaseHolder; endpoint: ClientEndpoint };

/**
 * One frontend drives a host project at a time; this is the Host's arbiter.
 *
 * Exactly one endpoint drives: the holder. The one exception is this machine's
 * own windows, which are one driver among themselves whenever the local client
 * holds — two local windows behave exactly as they did before any lease
 * existed. The holder endpoint is the single renderer that MCP dispatch and
 * plugin prompts target; terminal input and resizes follow it.
 */
export class DriveLeaseService {
  private readonly registry: LeaseRegistry;
  private readonly releaseGraceMs: number;
  private readonly now: () => number;
  private readonly applyDriveLeases: (leases: PtyHostDriveLease[]) => void;
  private readonly leases = new Map<string, ProjectLease>();
  private readonly clients = new Map<string, ClientRef>();
  /** Remote endpoints whose link is down: kept by the session, but nobody is there. */
  private readonly detached = new Set<string>();
  private readonly listeners = new Set<(state: DriveLeaseState) => void>();
  private readonly offRegistry: () => void;
  private nextLeaseId = 1;
  private reconcileQueued = false;
  private publishedDriveLeases = "";
  private disposed = false;

  constructor(options: DriveLeaseServiceOptions = {}) {
    this.registry = options.registry ?? getEndpointRegistry();
    this.releaseGraceMs = options.releaseGraceMs ?? DEFAULT_DRIVE_LEASE_RELEASE_GRACE_MS;
    this.now = options.now ?? Date.now;
    this.applyDriveLeases =
      options.applyDriveLeases ?? ((leases) => getPtyClient()?.setDriveLeases(leases));
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

  /**
   * The remote session layer reports a link dropping (`attached` false) or
   * resuming for its endpoints. A dropped holder starts the release grace at
   * once rather than when its session finally expires; a valid resume inside
   * the grace keeps the lease. Both are applied against whoever holds the lease
   * when they land, so neither can undo a takeover made in between.
   */
  noteEndpointTransport(endpointIds: Iterable<string>, attached: boolean): void {
    if (this.disposed) return;
    let changed = false;
    for (const endpointId of endpointIds) {
      if (attached ? this.detached.delete(endpointId) : !this.detached.has(endpointId)) {
        if (!attached) this.detached.add(endpointId);
        changed = true;
      }
    }
    if (!changed) return;
    for (const projectId of [...this.leases.keys()]) this.reconcileProject(projectId);
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

  /** Who drives the project right now, telling a holder that is away from nobody at all. */
  getDriveTarget(projectId: string): DriveTarget {
    const holder = this.getHolder(projectId);
    if (!holder) return { kind: "vacant" };
    const endpoint = this.registry.get(holder.endpointId);
    // During a reservation the holder may have moved to another project.
    return endpoint && this.isPresent(endpoint, projectId)
      ? { kind: "live", holder, endpoint }
      : { kind: "reserved", holder };
  }

  /** The live renderer that drives the project, or null when there is none attached. */
  getHolderEndpoint(projectId: string): ClientEndpoint | null {
    const target = this.getDriveTarget(projectId);
    return target.kind === "live" ? target.endpoint : null;
  }

  /** The project's lease as one endpoint sees it. */
  viewFor(projectId: string, endpoint: ClientEndpoint | null | undefined): DriveLeaseView {
    return this.buildView(projectId, this.getHolder(projectId), endpoint);
  }

  /**
   * Whether `endpoint` drives the project: it is the holder, nobody holds it,
   * or it and the holder are both this machine's own windows. Terminal input
   * and resizes are gated on this.
   */
  isDriving(projectId: string, endpoint: Pick<ClientEndpoint, "endpointId" | "clientId">): boolean {
    return drives(this.getHolder(projectId), endpoint);
  }

  /**
   * The lease `endpoint` drives the project under, for stamping the work it
   * sends so the pty-host can refuse it once a takeover has made it stale:
   * the lease id, null when nobody holds the project, or false when the
   * endpoint does not drive it.
   */
  drivingLeaseId(
    projectId: string,
    endpoint: Pick<ClientEndpoint, "endpointId" | "clientId">
  ): number | null | false {
    const holder = this.getHolder(projectId);
    if (!drives(holder, endpoint)) return false;
    return holder?.leaseId ?? null;
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
    this.detached.clear();
    this.listeners.clear();
    this.publishDriveLeases();
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
    for (const endpointId of [...this.clients.keys(), ...this.detached]) {
      const endpoint = this.registry.get(endpointId);
      if (!endpoint || endpoint.isClosed()) {
        this.clients.delete(endpointId);
        this.detached.delete(endpointId);
      }
    }
    const projects = new Set(this.leases.keys());
    for (const projectId of this.attachedProjects()) projects.add(projectId);
    for (const projectId of projects) this.reconcileProject(projectId);
    // A remote view joining or leaving a locally held project changes whether
    // the pty-host must arbitrate it, with no holder change to publish.
    this.publishDriveLeases();
  }

  /** Attached to the project with someone there: open, bound to it, and its link up. */
  private isPresent(endpoint: ClientEndpoint, projectId: string): boolean {
    return (
      !endpoint.isClosed() &&
      endpoint.projectId === projectId &&
      !this.detached.has(endpoint.endpointId)
    );
  }

  private presentFor(projectId: string): ClientEndpoint[] {
    return this.registry
      .getForProject(projectId)
      .filter((endpoint) => this.isPresent(endpoint, projectId));
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
    const attached = this.presentFor(projectId);
    if (!lease) {
      const first = attached[0];
      if (first) this.grant(projectId, first);
      return;
    }
    if (this.holderIsPresent(projectId, lease)) {
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
    const { leaseId } = lease.holder;
    lease.releaseTimer = setTimeout(() => this.release(projectId, leaseId), this.releaseGraceMs);
    lease.releaseTimer.unref?.();
  }

  private holderIsPresent(projectId: string, lease: ProjectLease): boolean {
    const endpoint = this.registry.get(lease.holder.endpointId);
    return endpoint !== undefined && this.isPresent(endpoint, projectId);
  }

  /** Fenced on the lease id: a grace that outlived a takeover, or a resume, releases nothing. */
  private release(projectId: string, leaseId: number): void {
    const lease = this.leases.get(projectId);
    if (!lease || lease.holder.leaseId !== leaseId) return;
    lease.releaseTimer = null;
    if (this.holderIsPresent(projectId, lease)) return;
    const next = this.presentFor(projectId)[0];
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
    this.leases.set(projectId, { holder, holderHandle: endpoint.handle, releaseTimer: null });
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
      drivingHere: drives(holder, { endpointId: endpoint?.endpointId ?? "", clientId }),
      isHolderEndpoint: holder !== null && endpoint?.endpointId === holder.endpointId,
      viewerIsHostLocal: endpoint ? endpoint.kind === "local-view" : true,
    };
  }

  private publish(projectId: string, holder: DriveLeaseHolder | null): void {
    this.publishDriveLeases();
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

  /**
   * The leases a remote client is party to — it holds the lease, or it has a
   * view on a project this machine's windows hold — for the pty-host to enforce
   * on port input and resizes. A project only this machine's windows show is
   * left out, so they arbitrate nothing among themselves.
   */
  private publishDriveLeases(): void {
    const table: PtyHostDriveLease[] = [];
    if (!this.disposed) {
      for (const [projectId, lease] of this.leases) {
        const remoteHolds = lease.holder.clientId !== LOCAL_CLIENT_ID;
        if (
          !remoteHolds &&
          !this.registry.getForProject(projectId).some((e) => e.kind === "remote-view")
        ) {
          continue;
        }
        table.push({
          projectId,
          leaseId: lease.holder.leaseId,
          holderConnection: remoteHolds ? lease.holderHandle : null,
        });
      }
    }
    table.sort((a, b) => (a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0));
    const serialized = JSON.stringify(table);
    if (serialized === this.publishedDriveLeases) return;
    // Nothing to tell a pty-host that has never heard of a lease.
    if (this.publishedDriveLeases === "" && table.length === 0) return;
    this.publishedDriveLeases = serialized;
    try {
      this.applyDriveLeases(table);
    } catch (error) {
      console.error("[DriveLease] Failed to publish the drive leases:", error);
    }
  }
}

function drives(
  holder: DriveLeaseHolder | null,
  endpoint: Pick<ClientEndpoint, "endpointId" | "clientId">
): boolean {
  if (holder === null || holder.endpointId === endpoint.endpointId) return true;
  return holder.clientId === LOCAL_CLIENT_ID && endpoint.clientId === LOCAL_CLIENT_ID;
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
