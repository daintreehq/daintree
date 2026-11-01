import { randomUUID } from "node:crypto";
import { app } from "electron";
import { CHANNELS } from "../ipc/channels.js";
import {
  LOCAL_CLIENT_ID,
  isCanopyViewerEndpointId,
  isDeviceAnswerEndpointId,
  isSessionEndpoint,
} from "../ipc/endpoint.js";
import type { ClientEndpoint, ClientRef, EndpointRegistry } from "../ipc/endpoint.js";
import { getEndpointRegistry } from "../ipc/endpointRegistry.js";
import type { LeaseGate } from "../ipc/dispatcher.js";
import { getLocalClientRef, getLocalEndpoint } from "../ipc/localEndpoint.js";
import { AppError } from "../utils/errorTypes.js";
import { createLogger } from "../utils/logger.js";
import { createKeyedLogLimiter } from "../utils/keyedLogLimiter.js";
import { getChannelLeaseTarget } from "../ipc/channelLeasePolicy.js";
import {
  resolveLeaseTarget,
  type LeaseTargetResolution,
  type LeaseTargetResolvers,
} from "./driveLeaseTargets.js";
import { getPtyClient } from "../window/serviceRefs.js";
import { isLocalViewInActiveUse } from "./hostScreenActivity.js";
import { createFileReservationStore } from "./driveLeaseReservations.js";
import type {
  DriveLeaseHolder,
  DriveLeaseObservation,
  DriveLeaseState,
} from "../../shared/types/remoteHosts.js";
import type { PtyHostDriveLease } from "../../shared/types/pty-host.js";
import type {
  DriveLeaseEvent,
  DriveLeaseNavigation,
  DriveLeaseView,
} from "../../shared/types/ipc/driveLease.js";

const logger = createLogger("main:DriveLeaseService");
const refusalLogLimiter = createKeyedLogLimiter();

type GrantReason =
  | "vacant"
  | "explicit-takeover"
  | "conditional-claim"
  | "host-screen-in-use"
  | "same-client-or-install"
  | "grace-expired";

function holderContext(projectId: string, holder: DriveLeaseHolder) {
  return {
    projectId,
    leaseId: holder.leaseId,
    tenureId: holder.tenureId,
    endpointId: holder.endpointId,
    clientId: holder.clientId,
    clientName: holder.clientName,
    isHostLocal: holder.isHostLocal,
  };
}

/**
 * How long a lease stays reserved for its client after the holder's link drops
 * or its endpoint closes: long enough for a resume or a reloaded view to take
 * it back, short enough that nobody else waits long on a machine that went.
 */
export const DEFAULT_DRIVE_LEASE_RELEASE_GRACE_MS = 15_000;

/**
 * How long a project stays reserved, after this app starts, for the Shell that
 * drove it before a restart. Longer than the ordinary grace: that Shell only
 * learns the Host is back on its next reconnect attempt, which backs off to
 * 30 s (LinkClient), and then has to handshake and reopen its view.
 */
export const DEFAULT_RESTORED_RESERVATION_GRACE_MS = 45_000;

/** How long saves of a project's panels gather before its watchers are told. */
export const PANELS_CHANGED_DELAY_MS = 200;

/** How long saves of a project's composer drafts gather before its watchers are told. */
export const DRAFTS_CHANGED_DELAY_MS = 200;

/** How long a driver's moves gather before its watchers are told: the latest goes. */
export const NAVIGATION_CHANGED_DELAY_MS = 50;

type LeaseRegistry = Pick<EndpointRegistry, "get" | "getForProject" | "getRemote" | "onChange">;

/**
 * Who asks whether it drives: an endpoint, or a caller standing in for one. A
 * Canopy viewer or a device answering through a Shell carries that Shell's
 * link session, which the host assigned; its client id is only the Shell's word.
 */
export type DriveStanding = Pick<ClientEndpoint, "endpointId" | "clientId" | "linkSessionId">;

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
  /**
   * Where the remote holders are kept across a restart of this app, so a Shell
   * whose Host restarted under it finds its projects still reserved for it
   * rather than taken by whichever window opened them first. None by default.
   */
  reservations?: DriveLeaseReservationStore;
  restoredReservationGraceMs?: number;
  /**
   * Whether a window on this machine's own screen is in active use: the
   * endpoint is the active view of a focused window, and someone has used this
   * machine in the last few minutes. Nobody, by default.
   */
  isHostScreenInUse?: (endpoint: ClientEndpoint) => boolean;
}

/** A remote client that held a project's lease when this app last ran. */
export interface DriveLeaseReservation {
  clientId: string;
  clientName: string;
  /** Its Shell's install, when its HELLO named one: a relaunch of it takes the project back. */
  deviceId?: string;
  /** Carried across the restart: nobody else can have driven while this app was down. */
  tenureId?: string;
}

export interface DriveLeaseReservationStore {
  load(): Record<string, DriveLeaseReservation>;
  save(reservations: Record<string, DriveLeaseReservation>): void;
}

/**
 * A reserved lease's holder endpoint when the app started with the holder
 * already away: no endpoint has this id, and no pty-host connection has id 0
 * (a local view's is its positive WebContents id, a remote view's negative).
 */
const RESTORED_HOLDER_ENDPOINT_PREFIX = "restored:";
const RESTORED_HOLDER_CONNECTION = 0;

/** A holder, or a reservation read back, as the reservation file keeps it. */
function toReservation(entry: DriveLeaseReservation): DriveLeaseReservation {
  return {
    clientId: entry.clientId,
    clientName: entry.clientName,
    ...(entry.deviceId ? { deviceId: entry.deviceId } : {}),
    ...(entry.tenureId ? { tenureId: entry.tenureId } : {}),
  };
}

interface ProjectLease {
  holder: DriveLeaseHolder;
  /** The holder endpoint's handle, which is its pty-host port connection id. */
  holderHandle: number;
  /**
   * The Shell install the holder's HELLO named, kept here rather than on the
   * holder every Shell sees: a relaunch of that install, with a new client
   * id, carries on driving as another window of the holder's client does.
   */
  holderDeviceId: string | null;
  /** Set while the holder is away and the lease waits for it, or its client, to come back. */
  releaseTimer: ReturnType<typeof setTimeout> | null;
  /** When that wait runs out, by this machine's clock; null while the holder is there. */
  awayUntil: number | null;
}

/** The last holder of a project nobody holds now, whose tenure its client takes back. */
interface VacatedTenure {
  clientId: string;
  tenureId: string;
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
  private readonly reservations: DriveLeaseReservationStore | null;
  private readonly restoredReservationGraceMs: number;
  private readonly isHostScreenInUse: (endpoint: ClientEndpoint) => boolean;
  private savedReservations = "";
  private readonly leases = new Map<string, ProjectLease>();
  /**
   * Projects whose grace ran out with nobody there, kept for their last
   * holder's client until anyone else could have driven them: a Shell back
   * from a long outage still finds the project as it left it.
   */
  private readonly vacatedTenures = new Map<string, VacatedTenure>();
  private readonly clients = new Map<string, ClientRef>();
  /** Remote endpoints whose link is down: kept by the session, but nobody is there. */
  private readonly detached = new Set<string>();
  private readonly listeners = new Set<(state: DriveLeaseState) => void>();
  private readonly offRegistry: () => void;
  private nextLeaseId = 1;
  private reconcileQueued = false;
  private publishedDriveLeases = "";
  /** Pending watcher notices, keyed by notice type and project. */
  private readonly watcherNoticeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Each project's navigation as its driver last reported it. Held in memory
   * only, and kept across a change of holder: a view taking over starts from
   * where the driver it displaced was.
   */
  private readonly navigation = new Map<string, DriveLeaseNavigation>();
  private readonly navigationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(options: DriveLeaseServiceOptions = {}) {
    this.registry = options.registry ?? getEndpointRegistry();
    this.releaseGraceMs = options.releaseGraceMs ?? DEFAULT_DRIVE_LEASE_RELEASE_GRACE_MS;
    this.now = options.now ?? Date.now;
    this.applyDriveLeases =
      options.applyDriveLeases ?? ((leases) => getPtyClient()?.setDriveLeases(leases));
    this.reservations = options.reservations ?? null;
    this.restoredReservationGraceMs =
      options.restoredReservationGraceMs ?? DEFAULT_RESTORED_RESERVATION_GRACE_MS;
    this.isHostScreenInUse = options.isHostScreenInUse ?? (() => false);
    this.restoreReservations();
    this.offRegistry = this.registry.onChange(() => this.queueReconcile());
    this.queueReconcile();
  }

  /**
   * Each project a remote client held when this app last ran starts out held
   * for that client, away, inside a grace long enough for its Shell to
   * reconnect: coming back takes it straight back, and otherwise it goes to
   * whoever is there once the grace runs out, as when a holder's link drops.
   */
  private restoreReservations(): void {
    if (!this.reservations) return;
    let restored: Record<string, DriveLeaseReservation>;
    try {
      restored = this.reservations.load();
    } catch (error) {
      logger.error("Drive lease reservations could not be read", error);
      return;
    }
    for (const [projectId, reservation] of Object.entries(restored)) {
      const holder: DriveLeaseHolder = {
        leaseId: this.nextLeaseId++,
        tenureId: reservation.tenureId ?? randomUUID(),
        endpointId: `${RESTORED_HOLDER_ENDPOINT_PREFIX}${reservation.clientId}`,
        clientId: reservation.clientId,
        clientName: reservation.clientName,
        isHostLocal: false,
        acquiredAt: this.now(),
      };
      const lease: ProjectLease = {
        holder,
        holderHandle: RESTORED_HOLDER_CONNECTION,
        holderDeviceId: reservation.deviceId ?? null,
        releaseTimer: null,
        awayUntil: this.now() + this.restoredReservationGraceMs,
      };
      lease.releaseTimer = setTimeout(
        () => this.release(projectId, holder.leaseId),
        this.restoredReservationGraceMs
      );
      lease.releaseTimer.unref?.();
      this.leases.set(projectId, lease);
      logger.info("Drive lease reservation restored", {
        ...holderContext(projectId, holder),
        graceMs: this.restoredReservationGraceMs,
      });
    }
    // As the file has them, so a tenure given to one saved without it is
    // written with the next save rather than made up again after a restart.
    const loaded: Record<string, DriveLeaseReservation> = {};
    for (const projectId of Object.keys(restored).sort()) {
      loaded[projectId] = toReservation(restored[projectId]!);
    }
    this.savedReservations = JSON.stringify(loaded);
    this.publishDriveLeases();
  }

  private remoteHolders(): Record<string, DriveLeaseReservation> {
    const out: Record<string, DriveLeaseReservation> = {};
    const projectIds = [...this.leases.keys()].sort();
    for (const projectId of projectIds) {
      const { holder, holderDeviceId } = this.leases.get(projectId)!;
      if (holder.clientId === LOCAL_CLIENT_ID) continue;
      out[projectId] = toReservation({
        clientId: holder.clientId,
        clientName: holder.clientName,
        deviceId: holderDeviceId ?? undefined,
        tenureId: holder.tenureId,
      });
    }
    return out;
  }

  private saveReservations(): void {
    if (!this.reservations || this.disposed) return;
    const next = this.remoteHolders();
    const serialized = JSON.stringify(next);
    if (serialized === this.savedReservations) return;
    try {
      this.reservations.save(next);
      // Only once written: a failed save is tried again on the next change.
      this.savedReservations = serialized;
    } catch (error) {
      logger.error("Drive lease reservations could not be saved", error);
    }
  }

  /**
   * Record who a remote endpoint belongs to, so the holder can name the
   * machine and a relaunch of its install can be told from another Shell.
   * The remote session layer calls it when an endpoint opens; the entry goes
   * when the endpoint closes.
   */
  noteEndpointClient(endpointId: string, client: ClientRef): void {
    if (this.disposed) return;
    this.clients.set(endpointId, client);
    // A lease granted before the note arrived names the machine by its id,
    // and doesn't know its install.
    for (const [projectId, lease] of this.leases) {
      const { holder } = lease;
      if (holder.endpointId !== endpointId) continue;
      if (client.deviceId) lease.holderDeviceId = client.deviceId;
      if (holder.clientName === client.clientName) continue;
      lease.holder = { ...holder, clientName: client.clientName };
      this.publish(projectId, lease.holder);
    }
    if (!client.deviceId) return;
    this.saveReservations();
    // Its install may be the one a lease whose holder has gone waits for.
    this.queueReconcile();
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
    // Projects nobody holds too: a lease released while every view was away
    // goes to whoever comes back, or each returning view would drive at once.
    const projects = new Set([...this.leases.keys(), ...this.attachedProjects()]);
    for (const projectId of projects) this.reconcileProject(projectId);
  }

  /** Every holder change, for the remote session layer's LEASE_CHANGED frames. */
  onChange(listener: (state: DriveLeaseState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * The project's holder. Reading never gives it to another machine: a
   * metrics sample, a fleet check or a view looking at the lease must not make
   * a window that merely shows the project its driver. A read only moves it
   * to another window of the holder's own client or install, and starts (or
   * stops) the grace of a holder that has gone. May name an endpoint that has just closed
   * while its client's reservation runs; use {@link getHolderEndpoint} to
   * reach it.
   */
  getHolder(projectId: string): DriveLeaseHolder | null {
    this.reconcileProject(projectId, false);
    return this.leases.get(projectId)?.holder ?? null;
  }

  /**
   * The endpoint a lease nobody holds would go to, without granting it: for
   * checks that must treat a window already on the project as holding it.
   */
  nextHolderEndpoint(projectId: string): ClientEndpoint | null {
    if (this.disposed || this.leases.has(projectId)) return null;
    return this.successor(projectId, null) ?? null;
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

  /**
   * Every lease as it stands, for showing who drives what. Unlike the getters
   * above, reading this settles nothing: no lease moves and no grace starts,
   * ends or runs longer. Attach and transport changes already settle them.
   */
  snapshotLeases(): DriveLeaseObservation[] {
    if (this.disposed) return [];
    const out: DriveLeaseObservation[] = [];
    for (const [projectId, lease] of this.leases) {
      const live = this.holderIsPresent(projectId, lease);
      out.push({
        projectId,
        holder: { ...lease.holder },
        state: live ? "live" : "away",
        awayUntil: live ? null : lease.awayUntil,
      });
    }
    return out;
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
  isDriving(projectId: string, endpoint: DriveStanding): boolean {
    return drives(this.getHolder(projectId), endpoint);
  }

  /**
   * The lease `endpoint` drives the project under, for stamping the work it
   * sends so the pty-host can refuse it once a takeover has made it stale:
   * the lease id, null when nobody holds the project, or false when the
   * endpoint does not drive it.
   */
  drivingLeaseId(projectId: string, endpoint: DriveStanding): number | null | false {
    const holder = this.getHolder(projectId);
    if (!drives(holder, endpoint)) return false;
    return holder?.leaseId ?? null;
  }

  /**
   * Every project someone other than `endpoint` drives, with its holder: the
   * projects a call from it may not change.
   */
  projectsDrivenElsewhere(endpoint: DriveStanding): Map<string, DriveLeaseHolder> {
    const out = new Map<string, DriveLeaseHolder>();
    // The call may change a project nobody holds, which only a window of
    // the client that last held it may do without ending that tenure.
    for (const projectId of [...this.vacatedTenures.keys()]) this.settleVacatedTenure(projectId);
    const projects = new Set([...this.leases.keys(), ...this.attachedProjects()]);
    for (const projectId of projects) {
      const holder = this.getHolder(projectId);
      if (holder && !drives(holder, endpoint)) out.set(projectId, holder);
    }
    return out;
  }

  /**
   * Hand the lease to `endpoint`. Explicit and always granted: the previous
   * driver's screen shows it has been taken, with the option to take it back.
   * With `ifLeaseId`, granted only while the lease is still that one (null:
   * nobody holds it) and the Host's own screen isn't in use on the project;
   * otherwise the holder is returned, the Host's screen holding it when it
   * was in use with nobody holding it.
   */
  takeOver(projectId: string, endpoint: ClientEndpoint): DriveLeaseHolder;
  takeOver(
    projectId: string,
    endpoint: ClientEndpoint,
    options: { ifLeaseId?: number | null }
  ): DriveLeaseHolder | null;
  takeOver(
    projectId: string,
    endpoint: ClientEndpoint,
    options: { ifLeaseId?: number | null } = {}
  ): DriveLeaseHolder | null {
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
    if (options.ifLeaseId !== undefined) {
      const holder = this.getHolder(projectId);
      if ((holder?.leaseId ?? null) !== options.ifLeaseId) return holder;
      // A conditional claim is the one a view makes on opening the project. It
      // never takes the project from someone using the Host's own screen,
      // whatever the claiming client decided from its read: that view opens
      // read-only, and Take control is the explicit step.
      if (holder === null || holder.isHostLocal) {
        const inUse = this.presentFor(projectId).find((present) => this.hostScreenShows(present));
        if (inUse) return holder ?? this.grant(projectId, inUse, "host-screen-in-use");
      }
    }
    return this.grant(
      projectId,
      endpoint,
      options.ifLeaseId !== undefined ? "conditional-claim" : "explicit-takeover"
    );
  }

  /**
   * The project's saved panels changed: tell the views that watch it to read
   * them back. A burst of saves goes out as one notice, sent a fixed delay
   * after the first so a busy driver can't hold it back indefinitely; who
   * watches is decided when it goes, not when the save landed.
   */
  notifyPanelsChanged(projectId: string): void {
    this.notifyWatchers("panels-changed", projectId, PANELS_CHANGED_DELAY_MS);
  }

  /**
   * The driver saved the project's composer drafts: tell the views that watch
   * it to read them back, coalesced as {@link notifyPanelsChanged} is. The
   * notice carries no text; watchers read the drafts through the draft read.
   */
  notifyDraftsChanged(projectId: string): void {
    this.notifyWatchers("drafts-changed", projectId, DRAFTS_CHANGED_DELAY_MS);
  }

  private notifyWatchers(
    type: "panels-changed" | "drafts-changed",
    projectId: string,
    delayMs: number
  ): void {
    const key = `${type}:${projectId}`;
    if (this.disposed || this.watcherNoticeTimers.has(key)) return;
    const timer = setTimeout(() => {
      this.watcherNoticeTimers.delete(key);
      if (this.disposed) return;
      const holder = this.getHolder(projectId);
      if (holder === null) return;
      const event: DriveLeaseEvent = { type, projectId };
      for (const endpoint of this.registry.getForProject(projectId)) {
        if (drives(holder, endpoint)) continue;
        try {
          endpoint.send({ type: "event", channel: CHANNELS.DRIVE_LEASE_EVENT, args: [event] });
        } catch {
          // A closing endpoint must not keep the others from hearing about it.
        }
      }
    }, delayMs);
    timer.unref?.();
    this.watcherNoticeTimers.set(key, timer);
  }

  /**
   * The driver says where it is in the project. Kept, and passed on to the
   * views that watch it, only from a view that drives the project under the
   * lease it names: a report sent before a takeover landed is dropped.
   */
  reportNavigation(
    projectId: string,
    endpoint: ClientEndpoint,
    leaseId: number | null,
    navigation: DriveLeaseNavigation
  ): void {
    if (this.disposed || endpoint.isClosed() || endpoint.projectId !== projectId) return;
    if (this.drivingLeaseId(projectId, endpoint) !== leaseId) return;
    this.navigation.set(projectId, navigation);
    if (this.navigationTimers.has(projectId)) return;
    const timer = setTimeout(() => {
      this.navigationTimers.delete(projectId);
      if (this.disposed) return;
      const latest = this.navigation.get(projectId);
      if (!latest) return;
      const holder = this.getHolder(projectId);
      const event: DriveLeaseEvent = { type: "navigation-changed", projectId, navigation: latest };
      for (const watcher of this.registry.getForProject(projectId)) {
        if (drives(holder, watcher)) continue;
        try {
          watcher.send({ type: "event", channel: CHANNELS.DRIVE_LEASE_EVENT, args: [event] });
        } catch {
          // A closing endpoint must not keep the others from hearing about it.
        }
      }
    }, NAVIGATION_CHANGED_DELAY_MS);
    timer.unref?.();
    this.navigationTimers.set(projectId, timer);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.offRegistry();
    for (const timer of this.watcherNoticeTimers.values()) clearTimeout(timer);
    this.watcherNoticeTimers.clear();
    for (const timer of this.navigationTimers.values()) clearTimeout(timer);
    this.navigationTimers.clear();
    this.navigation.clear();
    for (const lease of this.leases.values()) {
      if (lease.releaseTimer) clearTimeout(lease.releaseTimer);
    }
    this.leases.clear();
    this.vacatedTenures.clear();
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
    // A project only this machine's windows show is never reconciled, and
    // they drive it while nobody holds it.
    for (const projectId of [...this.vacatedTenures.keys()]) this.settleVacatedTenure(projectId);
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

  /**
   * Who a lease goes to when its holder has gone or nobody holds it: another
   * window of the holder's own client or install, then the Host's own screen
   * while it is in use, then whoever is attached.
   */
  private successor(projectId: string, lease: ProjectLease | null): ClientEndpoint | undefined {
    const attached = this.presentFor(projectId);
    return (
      (lease ? this.continuer(attached, lease, true) : undefined) ??
      attached.find((endpoint) => this.hostScreenShows(endpoint)) ??
      attached[0]
    );
  }

  /**
   * Who carries on for a holder that has gone: another window of its client,
   * else, with `byInstall`, one of the same Shell install on a new launch. The
   * install is the Shell's own word, which hands over nothing Take control
   * doesn't.
   */
  private continuer(
    attached: ClientEndpoint[],
    lease: ProjectLease,
    byInstall: boolean
  ): ClientEndpoint | undefined {
    const { holder, holderDeviceId } = lease;
    return (
      attached.find((endpoint) => endpoint.clientId === holder.clientId) ??
      (byInstall && holderDeviceId !== null
        ? attached.find(
            (endpoint) => this.clients.get(endpoint.endpointId)?.deviceId === holderDeviceId
          )
        : undefined)
    );
  }

  /** The holder's endpoint won't come back: closed, its session ended, or restored after a restart. */
  private holderIsGone(lease: ProjectLease): boolean {
    const endpoint = this.registry.get(lease.holder.endpointId);
    return endpoint === undefined || endpoint.isClosed();
  }

  private hostScreenShows(endpoint: ClientEndpoint): boolean {
    if (endpoint.kind !== "local-view") return false;
    try {
      return this.isHostScreenInUse(endpoint);
    } catch {
      return false;
    }
  }

  private presentFor(projectId: string): ClientEndpoint[] {
    return this.registry
      .getForProject(projectId)
      .filter((endpoint) => this.isPresent(endpoint, projectId));
  }

  /**
   * Local views read their project live and are not indexed by it, so only
   * remote endpoints announce projects here. A project only local windows
   * show is held by nobody, which lets every local window drive it.
   */
  private attachedProjects(): string[] {
    const out: string[] = [];
    for (const endpoint of this.registry.getRemote()) {
      if (endpoint.projectId) out.push(endpoint.projectId);
    }
    return out;
  }

  /**
   * Settle a project's lease against who is attached. Only a change in who is
   * attached may grant a lease nobody holds (`mayGrant`); a read only moves a
   * held lease between windows of its own client or install and keeps the
   * grace of a holder that has gone running.
   */
  private reconcileProject(projectId: string, mayGrant = true): void {
    if (this.disposed) return;
    const lease = this.leases.get(projectId);
    if (!lease) {
      this.settleVacatedTenure(projectId);
      if (!mayGrant) return;
      const next = this.successor(projectId, null);
      if (next) this.grant(projectId, next, "vacant");
      return;
    }
    if (this.holderIsPresent(projectId, lease)) {
      if (lease.releaseTimer) {
        clearTimeout(lease.releaseTimer);
        lease.releaseTimer = null;
      }
      if (lease.awayUntil !== null) {
        lease.awayUntil = null;
        logger.info("Drive lease holder returned", holderContext(projectId, lease.holder));
        this.sendViews(projectId, lease.holder);
      }
      return;
    }
    // Another window of the same client carries on driving without a gap, and
    // so does the same install relaunched once the holder's endpoint is gone
    // for good: one whose link merely dropped keeps its grace for a resume,
    // even from another launch sharing its install's id. The same machine
    // keeps the project, so a read may do this much.
    const continuer = this.continuer(this.presentFor(projectId), lease, this.holderIsGone(lease));
    if (continuer) {
      this.grant(projectId, continuer, "same-client-or-install");
      return;
    }
    if (lease.releaseTimer) return;
    const { leaseId } = lease.holder;
    lease.releaseTimer = setTimeout(() => this.release(projectId, leaseId), this.releaseGraceMs);
    lease.releaseTimer.unref?.();
    // The holder stays the same, so no holder change goes out; the views say
    // it is away, and when control passes on without it.
    lease.awayUntil = this.now() + this.releaseGraceMs;
    logger.info("Drive lease holder away", {
      ...holderContext(projectId, lease.holder),
      graceMs: this.releaseGraceMs,
    });
    this.sendViews(projectId, lease.holder);
  }

  private holderIsPresent(projectId: string, lease: ProjectLease): boolean {
    const endpoint = this.registry.get(lease.holder.endpointId);
    // A remote view closed and opened again under its id is a new endpoint
    // with its own pty-host connection, which the old lease doesn't name.
    return (
      endpoint !== undefined &&
      endpoint.handle === lease.holderHandle &&
      this.isPresent(endpoint, projectId)
    );
  }

  /** Fenced on the lease id: a grace that outlived a takeover, or a resume, releases nothing. */
  private release(projectId: string, leaseId: number): void {
    const lease = this.leases.get(projectId);
    if (!lease || lease.holder.leaseId !== leaseId) return;
    lease.releaseTimer = null;
    if (this.holderIsPresent(projectId, lease)) {
      lease.awayUntil = null;
      logger.info("Drive lease holder returned", holderContext(projectId, lease.holder));
      this.sendViews(projectId, lease.holder);
      return;
    }
    logger.info("Drive lease grace expired", holderContext(projectId, lease.holder));
    const next = this.successor(projectId, lease);
    if (next) {
      this.grant(projectId, next, "grace-expired");
      return;
    }
    this.leases.delete(projectId);
    if (lease.holder.tenureId) {
      this.vacatedTenures.set(projectId, {
        clientId: lease.holder.clientId,
        tenureId: lease.holder.tenureId,
      });
    }
    logger.info("Drive lease released", holderContext(projectId, lease.holder));
    this.publish(projectId, null);
  }

  /**
   * End the tenure kept for a project nobody holds once a window of another
   * client is on it: with nobody holding it, that window drives it.
   */
  private settleVacatedTenure(projectId: string): void {
    const vacated = this.vacatedTenures.get(projectId);
    if (!vacated) return;
    const other = this.presentFor(projectId).find(
      (endpoint) => endpoint.clientId !== vacated.clientId
    );
    if (!other) return;
    this.vacatedTenures.delete(projectId);
    logger.info("Drive lease tenure ended while nobody held the project", {
      projectId,
      tenureId: vacated.tenureId,
      clientId: vacated.clientId,
      byEndpointId: other.endpointId,
      byClientId: other.clientId,
    });
  }

  private grant(
    projectId: string,
    endpoint: ClientEndpoint,
    reason: GrantReason
  ): DriveLeaseHolder {
    const previous = this.leases.get(projectId);
    if (previous?.releaseTimer) clearTimeout(previous.releaseTimer);
    if (!previous) this.settleVacatedTenure(projectId);
    const last = previous?.holder ?? this.vacatedTenures.get(projectId);
    this.vacatedTenures.delete(projectId);
    const client = this.clientOf(endpoint);
    // The project stays with one client, so nobody else drove it in between.
    const sameClient = last?.clientId === endpoint.clientId;
    const holder: DriveLeaseHolder = {
      leaseId: this.nextLeaseId++,
      tenureId: (sameClient ? last?.tenureId : undefined) ?? randomUUID(),
      endpointId: endpoint.endpointId,
      clientId: endpoint.clientId,
      clientName: client?.clientName ?? endpoint.clientId,
      isHostLocal: endpoint.kind === "local-view",
      acquiredAt: this.now(),
    };
    this.leases.set(projectId, {
      holder,
      holderHandle: endpoint.handle,
      holderDeviceId: client?.deviceId ?? null,
      releaseTimer: null,
      awayUntil: null,
    });
    logger.info(previous ? "Drive lease transferred" : "Drive lease granted", {
      ...holderContext(projectId, holder),
      reason,
      ...(previous
        ? {
            previousLeaseId: previous.holder.leaseId,
            previousEndpointId: previous.holder.endpointId,
            previousClientId: previous.holder.clientId,
            previousClientName: previous.holder.clientName,
          }
        : {}),
    });
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
    const driverNavigation = this.navigation.get(projectId);
    const lease = this.leases.get(projectId);
    const awayUntil =
      holder !== null && lease?.holder.leaseId === holder.leaseId ? lease.awayUntil : null;
    return {
      ...(driverNavigation ? { driverNavigation } : {}),
      ...(awayUntil !== null ? { holderAwayMs: Math.max(0, awayUntil - this.now()) } : {}),
      projectId,
      holder,
      drivingHere: drives(holder, endpoint ?? { endpointId: "", clientId }),
      isHolderEndpoint: holder !== null && endpoint?.endpointId === holder.endpointId,
      viewerIsHostLocal: endpoint ? endpoint.kind === "local-view" : true,
      heldByThisClient: holder !== null && holder.clientId === clientId,
      hostScreenInUse: this.presentFor(projectId).some((present) => this.hostScreenShows(present)),
    };
  }

  private publish(projectId: string, holder: DriveLeaseHolder | null): void {
    this.publishDriveLeases();
    this.saveReservations();
    this.sendViews(projectId, holder);
    const state: DriveLeaseState = { projectId, holder };
    for (const listener of [...this.listeners]) {
      try {
        listener(state);
      } catch (error) {
        logger.error("Drive lease change listener failed", error, { projectId });
      }
    }
  }

  /** Each view of the project gets the lease as it sees it. */
  private sendViews(projectId: string, holder: DriveLeaseHolder | null): void {
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
      logger.error("Drive leases could not be published", error);
    }
  }
}

function drives(holder: DriveLeaseHolder | null, endpoint: DriveStanding): boolean {
  if (holder === null || holder.endpointId === endpoint.endpointId) return true;
  // A Canopy panel reading this host from another machine, or a device paired
  // with that machine, types as that machine's windows do: it drives where a
  // view on its own link session holds the lease. The client id can't decide
  // it, since any Shell may claim another's in its HELLO.
  if (
    endpoint.linkSessionId !== undefined &&
    (isCanopyViewerEndpointId(endpoint.endpointId) || isDeviceAnswerEndpointId(endpoint.endpointId))
  ) {
    return isSessionEndpoint(endpoint.linkSessionId, holder.endpointId);
  }
  return holder.clientId === LOCAL_CLIENT_ID && endpoint.clientId === LOCAL_CLIENT_ID;
}

/** The refusal of a change to a project someone else drives, in the wording every such refusal uses. */
export function drivenElsewhereError(
  channel: string,
  projectId: string | null,
  holder: DriveLeaseHolder | null,
  caller?: Pick<ClientEndpoint, "endpointId" | "clientId">
): AppError {
  logRefusal(channel, projectId, holder, caller);
  return new AppError({
    code: "DRIVEN_ELSEWHERE",
    message: `${channel} changes ${projectId ?? "a project"}, which another window drives`,
    userMessage: holder
      ? `${holder.clientName} has control of this project. Take control first.`
      : "Another screen has control of this project. Take control first.",
    context: { channel, projectId },
  });
}

/** The refusal of a change that couldn't be traced to a project while another window drives one here. */
export function unmatchedTargetError(
  channel: string,
  reason: string,
  holder: DriveLeaseHolder | null = null,
  caller?: Pick<ClientEndpoint, "endpointId" | "clientId">
): AppError {
  logRefusal(channel, null, holder, caller);
  return new AppError({
    code: "DRIVEN_ELSEWHERE",
    message: `${channel} targets ${reason}, and another window drives a project here`,
    userMessage:
      "Another screen has control of a project on this host, and this change couldn't be matched to a project. Take control first.",
    context: { channel },
  });
}

function logRefusal(
  channel: string,
  projectId: string | null,
  holder: DriveLeaseHolder | null,
  caller?: Pick<ClientEndpoint, "endpointId" | "clientId">
): void {
  const suppressedCount = refusalLogLimiter.take(
    `${channel}:${caller?.endpointId ?? ""}:${holder?.leaseId ?? ""}`
  );
  if (suppressedCount === null) return;
  logger.info("Call refused: another window drives the project", {
    code: "DRIVEN_ELSEWHERE",
    channel,
    projectId,
    endpointId: caller?.endpointId,
    clientId: caller?.clientId,
    holderLeaseId: holder?.leaseId,
    holderClientId: holder?.clientId,
    holderClientName: holder?.clientName,
    suppressedCount,
  });
}

/**
 * The dispatcher's lease gate: a call on a channel that changes a project is
 * refused unless its caller drives that project, exactly as its terminal input
 * is. The project is the one the call targets, traced through this Host's own
 * records (`CHANNEL_LEASE_TARGETS`), not the one the caller is showing:
 * a view on A can't change B by naming B's repository. While every project
 * with a holder is one the caller drives, nothing needs tracing; otherwise a
 * call whose target can't be traced is refused rather than let through.
 */
export function createDriveLeaseGate(
  lease: Pick<DriveLeaseService, "projectsDrivenElsewhere">,
  resolvers: LeaseTargetResolvers
): LeaseGate {
  return (channel, caller, args) => {
    const endpoint = caller.kind === "link" ? caller.endpoint : getLocalEndpoint(caller.sender);
    const elsewhere = lease.projectsDrivenElsewhere(endpoint);
    if (elsewhere.size === 0) return null;
    const target = getChannelLeaseTarget(channel);
    if (target === null) {
      const [projectId, holder] = elsewhere.entries().next().value!;
      return drivenElsewhereError(channel, projectId, holder, endpoint);
    }
    const verdict = (
      resolution: LeaseTargetResolution,
      holders: Map<string, DriveLeaseHolder>
    ): AppError | null => {
      if (resolution.kind === "unresolved") {
        return unmatchedTargetError(
          channel,
          resolution.reason,
          holders.values().next().value ?? null,
          endpoint
        );
      }
      const projectIds = resolution.kind === "every" ? [...holders.keys()] : resolution.projectIds;
      for (const projectId of projectIds) {
        const holder = holders.get(projectId);
        if (holder) return drivenElsewhereError(channel, projectId, holder, endpoint);
      }
      return null;
    };
    const resolution = resolveLeaseTarget(target, args, endpoint.projectId, resolvers);
    // A lookup that answers later is judged against the leases as they stand
    // then: a takeover while it ran counts.
    return resolution instanceof Promise
      ? resolution.then((resolved) => verdict(resolved, lease.projectsDrivenElsewhere(endpoint)))
      : verdict(resolution, elsewhere);
  };
}

/**
 * Whether the endpoint may write the project's host-owned state (its saved
 * layout, drafts, active worktree): always when no lease service runs, which
 * is everyone who never turned on Host mode, else only while the lease is
 * vacant or the endpoint drives it. The endpoint is only looked up once a
 * lease service runs: a local view's is created on first read.
 */
export function mayWriteProjectState(
  projectId: string,
  getEndpoint: () => DriveStanding | null | undefined
): boolean {
  if (service === null) return true;
  const endpoint = getEndpoint();
  return endpoint != null && service.isDriving(projectId, endpoint);
}

let service: DriveLeaseService | null = null;

export function getDriveLeaseService(): DriveLeaseService {
  service ??= new DriveLeaseService({
    reservations: defaultReservationStore(),
    isHostScreenInUse: isLocalViewInActiveUse,
  });
  return service;
}

function defaultReservationStore(): DriveLeaseReservationStore | undefined {
  try {
    return createFileReservationStore(app.getPath("userData"));
  } catch {
    // No app paths (a unit test's mocked electron): leases just don't outlive the process.
    return undefined;
  }
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
