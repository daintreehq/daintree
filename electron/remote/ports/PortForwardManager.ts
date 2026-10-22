import crypto from "node:crypto";
import type net from "node:net";
import type { RemoteUpstreamResolution } from "../../services/DevPreviewProxyService.js";
import type {
  ForwardPortPayload,
  HostListeningPort,
  PortForward,
} from "../../../shared/types/ipc/portForwards.js";
import { isValidRemoteHostId, type HostId } from "../../../shared/types/remoteHosts.js";
import type { BoundLoopbackEndpoint } from "../../../shared/utils/urlUtils.js";
import { AppError } from "../../utils/errorTypes.js";
import { defaultSshSpawner, type SshSpawner } from "../client/sshTransport.js";
import type { LinkSession } from "../link/session.js";
import {
  HostListenerListSchema,
  PortLinkMethod,
  PreviewResolutionSchema,
  type PreviewResolution,
} from "./linkMethods.js";
import {
  listenIpv6Relay,
  listenLoopback,
  probeFreeLoopbackPort,
  type LoopbackListener,
} from "./localListener.js";
import {
  buildPortForwardArgs,
  resolveMuxControlPath,
  runSshMuxCommand,
  type SshMuxTarget,
} from "./sshForward.js";
import { PortStreamMux } from "./streamForwarder.js";

/**
 * The Shell's port forwards: a local port per Host port, so this machine's
 * browser, dev-preview proxy and system browser reach servers running on a
 * Host as if they were local. A forward goes through the Host's SSH
 * ControlMaster when there is one (`ssh -O forward`), and otherwise through a
 * local listener whose connections ride the link as streams.
 *
 * One forward per (host, remote port), whatever asked for it, kept while
 * something holds it: the user's own Forward port… until it is stopped, each
 * browser panel and dev preview that asked for it until it lets go, and a
 * sign-in callback or a page opened in the system browser until its
 * connections have been idle a while. Only what Daintree carries itself shows
 * that last kind's use, so a forward held for that alone rides link streams,
 * never the ControlMaster.
 *
 * A forward counts (is listed, and admits a webview) only while the session
 * it rides is open. An ssh forward belongs to the ControlMaster that was
 * running when it was added: when that session closes the master may be gone
 * and its local port free for any other process, so the forward is retired
 * and added again on the next session, on whatever port is free by then.
 */

export type PortForwardOrigin = PortForward["origin"];

export interface PortForwardManagerDeps {
  /** The host's live link session, or null when it has none. */
  sessionFor(hostId: HostId): LinkSession | null;
  /**
   * The host a local view claimed a preview subdomain for, or null. Only that
   * host is asked to resolve it: no other host can answer for it.
   */
  previewOwner?(subdomain: string): HostId | null;
  isKnownHost(hostId: HostId): boolean;
  /** The ControlMaster to add forwards to, or null to use link streams. */
  sshMuxFor?(hostId: HostId): SshMuxTarget | null;
  spawn?: SshSpawner;
  onChange?(forwards: PortForward[]): void;
  now?(): number;
  /** How long a sign-in callback forward may sit idle before it closes. */
  oauthIdleMs?: number;
  /** How long a panel's release waits, so a remount that asks again keeps the same forward. */
  panelReleaseGraceMs?: number;
  /** A host's name for copy, or null for a host not in the list. */
  hostName?(hostId: HostId): string | null;
}

/**
 * What keeps a forward. `manual` is the user's own request, which lasts until
 * stopped; `owners` are browser panels (`panel:<view>:<panel>`) and dev
 * previews (`preview:<subdomain>`), each letting go on its own; `idle` is a
 * sign-in callback or a system-browser page, kept while it is in use.
 */
interface Hold {
  manual: PortForwardOrigin | null;
  owners: Set<string>;
  idle: boolean;
}

function isLasting(hold: Hold | undefined): boolean {
  return hold !== undefined && (hold.manual !== null || hold.owners.size > 0);
}

function isHeld(hold: Hold | undefined): boolean {
  return isLasting(hold) || hold?.idle === true;
}

/** What the forward is listed as: the most lasting reason it is held for. */
function originOf(hold: Hold | undefined, fallback: PortForwardOrigin): PortForwardOrigin {
  if (!hold) return fallback;
  if (hold.manual) return hold.manual;
  const owners = [...hold.owners];
  if (owners.some((owner) => owner.startsWith(PREVIEW_OWNER))) return "dev-preview";
  if (owners.some((owner) => owner.startsWith(PANEL_OWNER))) return "browser-panel";
  return "oauth-callback";
}

function previewOwner(subdomain: string): string {
  return `${PREVIEW_OWNER}${subdomain}`;
}

interface ActiveForward {
  info: PortForward;
  driver:
    | { kind: "stream"; listener: LoopbackListener; sockets: Set<net.Socket> }
    /**
     * `session` is the one open when ssh added it: the forward dies with its
     * master. ssh holds 127.0.0.1; `relay` holds [::1] beside it, when there is one.
     */
    | {
        kind: "ssh";
        mux: SshMuxTarget;
        /** The master's expanded control path the forward was asked with; its cancel uses it too. */
        resolved: string | null;
        session: LinkSession;
        relay: LoopbackListener | null;
      };
  /** The loopback addresses the local port is held on. */
  addresses: string[];
  idleTimer: ReturnType<typeof setTimeout> | null;
}

interface Recreation {
  forwardId: string;
  stopped: boolean;
  done: Promise<void>;
  finish(): void;
}

/** What a retired ssh forward needs to be added again on the next session. */
interface LapsedForward {
  forwardId: string;
  hostId: HostId;
  remotePort: number;
  origin: PortForwardOrigin;
  label: string | null;
}

const ORIGINS: ReadonlySet<PortForwardOrigin> = new Set([
  "dev-preview",
  "oauth-callback",
  "manual",
  "detected",
  "browser-panel",
]);
const PANEL_OWNER = "panel:";
const PREVIEW_OWNER = "preview:";
const MAX_PANEL_ID_LENGTH = 256;
const MAX_FORWARDS = 128;
const MAX_LABEL_LENGTH = 128;
const DEFAULT_OAUTH_IDLE_MS = 10 * 60 * 1000;
const PREVIEW_CACHE_MS = 2_000;
const PREVIEW_LOOKUP_TIMEOUT_MS = 5_000;
const DEFAULT_PANEL_RELEASE_GRACE_MS = 5_000;

function keyOf(hostId: HostId, remotePort: number): string {
  return `${hostId}\u0000${remotePort}`;
}

function invalid(message: string): AppError {
  return new AppError({ code: "VALIDATION", message });
}

interface ForwardRequest {
  hostId: HostId;
  remotePort: number;
  origin: PortForwardOrigin;
  label: string | null;
  samePort: boolean;
}

function validatePayload(payload: ForwardPortPayload): ForwardRequest {
  if (!payload || typeof payload !== "object") throw invalid("Invalid forward request");
  const { hostId, remotePort, origin, label, samePort } = payload;
  if (typeof hostId !== "string" || !isValidRemoteHostId(hostId)) {
    throw invalid("Ports are forwarded from a remote host");
  }
  if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
    throw invalid(`Invalid port: ${String(remotePort)}`);
  }
  if (origin !== undefined && !ORIGINS.has(origin)) throw invalid("Invalid forward origin");
  if (label !== undefined && (typeof label !== "string" || label.length > MAX_LABEL_LENGTH)) {
    throw invalid("Invalid forward label");
  }
  if (samePort !== undefined && typeof samePort !== "boolean")
    throw invalid("Invalid forward request");
  return {
    hostId,
    remotePort,
    origin: origin ?? "manual",
    label: label?.trim() ? label.trim() : null,
    samePort: samePort === true,
  };
}

/** A browser panel's id as its owner key's last part. */
export function isValidPanelId(panelId: unknown): panelId is string {
  return typeof panelId === "string" && panelId.length > 0 && panelId.length <= MAX_PANEL_ID_LENGTH;
}

export function panelOwner(webContentsId: number, panelId: string): string {
  return `${PANEL_OWNER}${webContentsId}:${panelId}`;
}

/** Every panel owner in one view, for releasing them all when the view is gone. */
export function viewOwnerPrefix(webContentsId: number): string {
  return `${PANEL_OWNER}${webContentsId}:`;
}

export class PortForwardManager {
  private readonly forwards = new Map<string, ActiveForward>();
  private readonly pending = new Map<string, Promise<PortForward>>();
  private readonly lapsed = new Map<string, LapsedForward>();
  /** Retired forwards being added again, by key: a Stop meanwhile must win. */
  private readonly recreating = new Map<string, Recreation>();
  private readonly watchedSessions = new WeakSet<LinkSession>();
  /** Cancels of retired ssh forwards, awaited before adding one again so a late cancel can't undo it. */
  private readonly retiring = new Set<Promise<unknown>>();
  private readonly muxes = new WeakMap<LinkSession, PortStreamMux>();
  private readonly previewCache = new Map<
    string,
    { at: number; hostId: HostId; result: Promise<RemoteUpstreamResolution | null> }
  >();
  /** What keeps each forward, by key: kept across a session's retire and re-add. */
  private readonly holds = new Map<string, Hold>();
  /** Panel releases waiting out their grace, by owner. */
  private readonly releaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Latest lookup per subdomain; an older lookup that finishes later changes nothing. */
  private readonly previewGenerations = new Map<string, number>();
  private previewGeneration = 0;
  private readonly now: () => number;
  private readonly spawn: SshSpawner;
  private disposed = false;

  constructor(private readonly deps: PortForwardManagerDeps) {
    this.now = deps.now ?? Date.now;
    this.spawn = deps.spawn ?? defaultSshSpawner();
  }

  list(): PortForward[] {
    return [...this.forwards.values()]
      .filter((forward) => this.isLive(forward))
      .map((forward) => ({ ...forward.info }))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Local ports forwarded to `hostId` right now: what counts as that host's localhost here. */
  localPortsFor(hostId: HostId): Set<number> {
    return new Set(this.boundEndpointsFor(hostId).map((endpoint) => endpoint.port));
  }

  /** The loopback address and port pairs `hostId`'s live forwards hold. */
  boundEndpointsFor(hostId: HostId): BoundLoopbackEndpoint[] {
    const endpoints: BoundLoopbackEndpoint[] = [];
    for (const forward of this.forwards.values()) {
      if (forward.info.hostId !== hostId || !this.isLive(forward)) continue;
      for (const address of forward.addresses) {
        endpoints.push({ address, port: forward.info.localPort });
      }
    }
    return endpoints;
  }

  /**
   * The host has an open session again: its stream forwards count once more
   * and the ssh forwards its last session took down are added on this one.
   */
  async reestablish(hostId: HostId): Promise<void> {
    const session = this.deps.sessionFor(hostId);
    if (this.disposed || !session?.isOpen) return;
    this.watch(hostId, session);
    const lapsed = [...this.lapsed.values()].filter((spec) => spec.hostId === hostId);
    for (const spec of lapsed) {
      const key = keyOf(spec.hostId, spec.remotePort);
      // Stopped (or already added again) while an earlier one was being added.
      if (this.lapsed.get(key) !== spec) continue;
      try {
        // Keeps its id, so a Stop for it lands whether it comes before or after.
        // Whatever held it still does: nothing new claims it.
        await this.acquire(key, {
          hostId,
          remotePort: spec.remotePort,
          origin: spec.origin,
          label: spec.label,
          samePort: false,
        });
      } catch {
        // The session went again, or the port can't be had, or it was stopped:
        // forward() has put it back for the next session where that applies.
      }
    }
    this.previewCache.clear();
    this.emit();
  }

  /**
   * Forward a host port for `owner` (a browser panel or dev preview, held
   * until it lets go) or, with none, for the payload's origin: the user's own
   * request, or a sign-in callback or system-browser page kept while in use.
   */
  async forward(payload: ForwardPortPayload, owner: string | null = null): Promise<PortForward> {
    const request = validatePayload(payload);
    if (request.origin === "browser-panel" && owner === null) {
      throw invalid("A browser panel's forward needs its panel");
    }
    if (!this.deps.isKnownHost(request.hostId)) {
      throw new AppError({
        code: "NOT_FOUND",
        message: `No host with id "${request.hostId}"`,
        userMessage: "That host isn't in the host list.",
      });
    }
    if (this.disposed) {
      throw new AppError({ code: "CANCELLED", message: "Port forwarding stopped" });
    }
    const key = keyOf(request.hostId, request.remotePort);
    // Asking again within a release's grace keeps the forward it was letting go of.
    if (owner !== null) this.cancelRelease(owner);
    // Held before anything is awaited, so a release meanwhile finds it.
    const undo = this.claim(key, request, owner);
    try {
      return await this.acquire(key, request);
    } catch (error) {
      undo();
      throw error;
    }
  }

  /**
   * Let go of everything `owner` holds. A panel's release waits a moment, so
   * one remounted (moved, or its view reloaded) that asks again keeps the
   * same forward; anything else lets go at once.
   */
  release(owner: string): void {
    this.cancelRelease(owner);
    const graceMs = owner.startsWith(PANEL_OWNER)
      ? (this.deps.panelReleaseGraceMs ?? DEFAULT_PANEL_RELEASE_GRACE_MS)
      : 0;
    if (graceMs <= 0 || this.disposed) {
      this.dropOwner(owner);
      return;
    }
    const timer = setTimeout(() => {
      this.releaseTimers.delete(owner);
      this.dropOwner(owner);
    }, graceMs);
    timer.unref?.();
    this.releaseTimers.set(owner, timer);
  }

  /** Let go at once of every owner whose id starts with `prefix`: a view's panels, once it is gone. */
  releaseAll(prefix: string): void {
    const owners = new Set<string>();
    for (const owner of this.releaseTimers.keys()) if (owner.startsWith(prefix)) owners.add(owner);
    for (const hold of this.holds.values()) {
      for (const owner of hold.owners) if (owner.startsWith(prefix)) owners.add(owner);
    }
    for (const owner of owners) {
      this.cancelRelease(owner);
      this.dropOwner(owner);
    }
  }

  /**
   * A preview's panel closed or its dev server was stopped: its forward goes
   * unless something else holds it, and a lookup still in flight for it
   * changes nothing.
   */
  releasePreview(subdomain: string): void {
    this.previewGenerations.set(subdomain, ++this.previewGeneration);
    this.previewCache.delete(subdomain);
    this.dropOwner(previewOwner(subdomain));
  }

  private async acquire(key: string, request: ForwardRequest): Promise<PortForward> {
    const existing = this.forwards.get(key);
    if (existing) {
      if (this.isLive(existing)) return this.reuse(existing, request);
      this.requireSession(request.hostId);
      if (existing.driver.kind === "ssh") this.retire(key, existing);
    }
    if (this.retiring.size > 0) {
      await Promise.all(this.retiring);
      return this.acquire(key, request);
    }
    const inFlight = this.pending.get(key);
    if (inFlight) {
      const info = await inFlight;
      const created = this.forwards.get(key);
      if (created) return this.reuse(created, request);
      if (request.samePort && info.localPort !== request.remotePort) {
        throw this.portInUse(request.remotePort, request.origin);
      }
      return info;
    }
    if (this.forwards.size >= MAX_FORWARDS) {
      throw new AppError({
        code: "RATE_LIMITED",
        message: "Too many forwarded ports",
        userMessage: "Stop a forwarded port before adding another.",
      });
    }
    const lapsed = this.lapsed.get(key);
    let recreation: Recreation | null = null;
    if (lapsed) {
      // Added again under its old id; a Stop for that id until it is listed marks this.
      this.lapsed.delete(key);
      request.label = request.label ?? lapsed.label;
      let finish = () => {};
      recreation = {
        forwardId: lapsed.forwardId,
        stopped: false,
        done: new Promise<void>((resolve) => (finish = resolve)),
        finish: () => finish(),
      };
      this.recreating.set(key, recreation);
    }
    const creating = this.create(key, request, recreation)
      .catch((error: unknown) => {
        // Failed to add it again: the next session tries once more, unless it was stopped.
        if (
          lapsed &&
          !recreation?.stopped &&
          !this.disposed &&
          isHeld(this.holds.get(key)) &&
          !this.forwards.has(key) &&
          !this.lapsed.has(key)
        ) {
          this.lapsed.set(key, lapsed);
        }
        throw error;
      })
      .finally(() => {
        this.pending.delete(key);
        if (recreation) {
          if (this.recreating.get(key) === recreation) this.recreating.delete(key);
          recreation.finish();
        }
      });
    this.pending.set(key, creating);
    return creating;
  }

  async stop(forwardId: string): Promise<void> {
    if (typeof forwardId !== "string") throw invalid("Invalid forward id");
    // Stopped: whatever held it lets go with it.
    for (const [key, spec] of [...this.lapsed]) {
      if (spec.forwardId !== forwardId) continue;
      this.lapsed.delete(key);
      this.holds.delete(key);
    }
    const recreating = [...this.recreating.entries()].find(([, r]) => r.forwardId === forwardId);
    if (recreating) {
      // Being added again right now: it is torn down before it is ever listed.
      this.holds.delete(recreating[0]);
      recreating[1].stopped = true;
      await recreating[1].done;
      return;
    }
    const entry = [...this.forwards.entries()].find(([, f]) => f.info.forwardId === forwardId);
    if (!entry) return;
    const [key, forward] = entry;
    this.forwards.delete(key);
    const hold = this.holds.get(key);
    this.holds.delete(key);
    if (!(await this.teardown(forward))) {
      // ssh still holds the port: keep it listed so it can be stopped again.
      this.forwards.set(key, forward);
      if (hold && !this.holds.has(key)) this.holds.set(key, hold);
      throw new AppError({
        code: "INTERNAL",
        message: `ssh refused to cancel the forward of port ${forward.info.remotePort}`,
        userMessage: "Couldn't stop forwarding this port. Try again.",
      });
    }
    this.previewCache.clear();
    this.emit();
  }

  /** Whether any forward to `hostId` is held or waiting to be added again: its connection is in use. */
  hasForwardsFor(hostId: HostId): boolean {
    for (const forward of this.forwards.values()) if (forward.info.hostId === hostId) return true;
    for (const spec of this.lapsed.values()) if (spec.hostId === hostId) return true;
    return false;
  }

  /** Forget every host with forwards here that is no longer in the host list. */
  async pruneUnknownHosts(): Promise<void> {
    const hostIds = new Set<HostId>();
    for (const forward of this.forwards.values()) hostIds.add(forward.info.hostId);
    for (const spec of this.lapsed.values()) hostIds.add(spec.hostId);
    await Promise.all(
      [...hostIds].filter((id) => !this.deps.isKnownHost(id)).map((id) => this.forgetHost(id))
    );
  }

  /**
   * A host left the list: its forwards go now. Left alone they kept their
   * local ports, vanished from the list (nothing listed them, so nothing could
   * stop them) and still counted against the forward limit.
   */
  async forgetHost(hostId: HostId): Promise<void> {
    for (const [key, spec] of this.lapsed) {
      if (spec.hostId === hostId) this.lapsed.delete(key);
    }
    const prefix = keyOf(hostId, 0).slice(0, -1);
    for (const key of [...this.holds.keys()]) if (key.startsWith(prefix)) this.holds.delete(key);
    for (const [key, recreation] of this.recreating) {
      if (key.startsWith(prefix)) recreation.stopped = true;
    }
    // One still being added lands in the map once it settles; collect it too.
    await Promise.allSettled(
      [...this.pending].filter(([key]) => key.startsWith(prefix)).map(([, creating]) => creating)
    );
    const gone = [...this.forwards].filter(([, forward]) => forward.info.hostId === hostId);
    if (gone.length === 0) return;
    for (const [key] of gone) this.forwards.delete(key);
    this.previewCache.clear();
    // Its master may be gone with it: cancelling is only a courtesy, the local side always closes.
    await Promise.all(gone.map(([, forward]) => this.teardown(forward).catch(() => false)));
    await Promise.all(
      gone.map(async ([, forward]) => {
        if (forward.driver.kind === "ssh") await forward.driver.relay?.close();
      })
    );
    this.emit();
  }

  async listHostPorts(hostId: HostId): Promise<HostListeningPort[]> {
    if (typeof hostId !== "string" || !isValidRemoteHostId(hostId)) {
      throw invalid("Ports are listed for a remote host");
    }
    const session = this.requireSession(hostId);
    const answer = await session.call(PortLinkMethod.LIST_LISTENERS, null);
    const parsed = HostListenerListSchema.safeParse(answer);
    if (!parsed.success) {
      throw new AppError({ code: "INTERNAL", message: `Host ${hostId} sent an invalid port list` });
    }
    return parsed.data;
  }

  /**
   * A dev-preview subdomain this machine doesn't serve, looked up on the
   * connected hosts. When one runs it, the dev server's actual port is
   * forwarded and the preview proxy is given the local end.
   */
  resolvePreview(subdomain: string): Promise<RemoteUpstreamResolution | null> | null {
    const hostId = this.deps.previewOwner?.(subdomain) ?? null;
    if (!hostId || !this.deps.sessionFor(hostId)?.isOpen) return null;
    const cached = this.previewCache.get(subdomain);
    if (cached && cached.hostId === hostId && this.now() - cached.at < PREVIEW_CACHE_MS) {
      return cached.result;
    }
    const generation = ++this.previewGeneration;
    this.previewGenerations.set(subdomain, generation);
    const result = this.lookupPreview(subdomain, hostId, generation);
    this.previewCache.set(subdomain, { at: this.now(), hostId, result });
    result.catch(() => this.previewCache.delete(subdomain));
    return result;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const all = [...this.forwards.values()];
    this.forwards.clear();
    this.lapsed.clear();
    const recreations = [...this.recreating.values()];
    for (const entry of recreations) entry.stopped = true;
    const pending = [...this.pending.values()];
    this.previewCache.clear();
    this.holds.clear();
    for (const timer of this.releaseTimers.values()) clearTimeout(timer);
    this.releaseTimers.clear();
    await Promise.all(all.map((forward) => this.teardown(forward)));
    // A forward still being added tears itself down on seeing `disposed`; wait for it.
    await Promise.allSettled([...pending, ...recreations.map((entry) => entry.done)]);
  }

  private reuse(forward: ActiveForward, request: ForwardRequest): PortForward {
    if (request.samePort && forward.info.localPort !== request.remotePort) {
      throw this.portInUse(request.remotePort, request.origin);
    }
    let changed = this.syncOrigin(forward);
    if (request.label && !forward.info.label) {
      forward.info.label = request.label;
      changed = true;
    }
    this.touch(forward);
    if (changed) this.emit();
    return { ...forward.info };
  }

  private async create(
    key: string,
    request: ForwardRequest,
    recreation: Recreation | null
  ): Promise<PortForward> {
    // Fail before binding anything when the host can't carry the forward.
    const session = this.requireSession(request.hostId);
    const info: PortForward = {
      forwardId: recreation?.forwardId ?? crypto.randomUUID(),
      hostId: request.hostId,
      remotePort: request.remotePort,
      localPort: 0,
      origin: originOf(this.holds.get(key), request.origin),
      label: request.label,
      createdAt: this.now(),
    };
    this.watch(request.hostId, session);
    // A forward kept only while in use rides link streams, where its use shows.
    const forward =
      (isLasting(this.holds.get(key))
        ? await this.createSshForward(info, session, request.samePort)
        : null) ?? (await this.createStreamForward(info, session, request.samePort));
    if (this.disposed) {
      await this.teardown(forward);
      throw new AppError({ code: "CANCELLED", message: "Port forwarding stopped" });
    }
    if (recreation?.stopped || !isHeld(this.holds.get(key))) {
      // Stopped, or let go by everything that asked for it, while it was being added.
      await this.teardown(forward);
      throw new AppError({ code: "CANCELLED", message: "Port forward stopped" });
    }
    if (forward.driver.kind === "ssh" && !session.isOpen) {
      // Its master may already be gone; never list a forward nothing holds.
      void this.teardown(forward);
      throw this.disconnected(request.hostId);
    }
    // Listed from here on under its id, so a Stop from now finds it like any other.
    if (recreation && this.recreating.get(key) === recreation) this.recreating.delete(key);
    this.forwards.set(key, forward);
    this.syncOrigin(forward);
    this.touch(forward);
    this.emit();
    return { ...forward.info };
  }

  private async createSshForward(
    info: PortForward,
    session: LinkSession,
    samePort: boolean
  ): Promise<ActiveForward | null> {
    const mux = this.deps.sshMuxFor?.(info.hostId) ?? null;
    if (!mux) return null;
    let localPort: number;
    try {
      localPort = await probeFreeLoopbackPort(info.remotePort);
    } catch {
      return null;
    }
    if (samePort && localPort !== info.remotePort)
      throw this.portInUse(info.remotePort, info.origin);
    let relay: LoopbackListener | null;
    try {
      relay = await listenIpv6Relay(localPort);
    } catch {
      // Something took the IPv6 side since the probe: use a link stream instead.
      return null;
    }
    const resolved = await resolveMuxControlPath(this.spawn, mux);
    const args = buildPortForwardArgs(mux, localPort, info.remotePort, "forward", resolved);
    if (!(await runSshMuxCommand(this.spawn, args))) {
      await relay?.close();
      return null;
    }
    return {
      info: { ...info, localPort },
      driver: { kind: "ssh", mux, resolved, session, relay },
      addresses: relay ? ["127.0.0.1", "::1"] : ["127.0.0.1"],
      idleTimer: null,
    };
  }

  private async createStreamForward(
    info: PortForward,
    session: LinkSession,
    samePort: boolean,
    preferredPort = info.remotePort
  ): Promise<ActiveForward> {
    const sockets = new Set<net.Socket>();
    let forward: ActiveForward | null = null;
    const listener = await listenLoopback(preferredPort, (socket) => {
      if (!forward) {
        socket.destroy();
        return;
      }
      this.acceptLocal(forward, socket);
    });
    if (samePort && listener.port !== preferredPort) {
      await listener.close();
      throw this.portInUse(preferredPort, info.origin);
    }
    forward = {
      info: { ...info, localPort: listener.port },
      driver: { kind: "stream", listener, sockets },
      addresses: listener.servers.map((server) => (server.address() as net.AddressInfo).address),
      idleTimer: null,
    };
    // Fail fast if the session died while binding; later connections use whatever session is live.
    if (session.isClosed && !this.deps.sessionFor(info.hostId)) {
      await this.teardown(forward);
      throw this.disconnected(info.hostId);
    }
    return forward;
  }

  private acceptLocal(forward: ActiveForward, socket: net.Socket): void {
    if (forward.driver.kind !== "stream") return;
    const { sockets } = forward.driver;
    const session = this.deps.sessionFor(forward.info.hostId);
    if (!session || !session.isOpen) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
      this.touch(forward);
    });
    this.muxFor(session)
      .openStream(socket, forward.info.remotePort, () => this.touch(forward))
      .catch(() => {
        // openStream already destroyed the socket; the browser sees a reset connection.
      });
  }

  private muxFor(session: LinkSession): PortStreamMux {
    let mux = this.muxes.get(session);
    if (!mux || mux.isDisposed) {
      mux = new PortStreamMux(session);
      this.muxes.set(session, mux);
    }
    return mux;
  }

  /** Restart the idle clock of a forward held only while in use; any other forward has none. */
  private touch(forward: ActiveForward): void {
    if (forward.idleTimer) clearTimeout(forward.idleTimer);
    forward.idleTimer = null;
    const key = keyOf(forward.info.hostId, forward.info.remotePort);
    const hold = this.holds.get(key);
    // A torn-down forward's closing sockets never start a clock.
    if (this.disposed || this.forwards.get(key) !== forward || isLasting(hold) || !hold?.idle) {
      return;
    }
    const idleMs = this.deps.oauthIdleMs ?? DEFAULT_OAUTH_IDLE_MS;
    forward.idleTimer = setTimeout(() => {
      forward.idleTimer = null;
      if (forward.driver.kind === "stream" && forward.driver.sockets.size > 0) {
        this.touch(forward);
        return;
      }
      if (this.forwards.get(key) !== forward) return;
      const current = this.holds.get(key);
      if (current) current.idle = false;
      this.settle(key);
    }, idleMs);
    forward.idleTimer.unref?.();
  }

  /**
   * Hold `key` for this request before anything is awaited. Returns the undo
   * for a request that fails: it gives back only what this request added.
   */
  private claim(key: string, request: ForwardRequest, owner: string | null): () => void {
    let hold = this.holds.get(key);
    if (!hold) {
      hold = { manual: null, owners: new Set(), idle: false };
      this.holds.set(key, hold);
    }
    const held = hold;
    const undo = (): void => {
      if (this.holds.get(key) === held) this.settle(key);
    };
    if (owner !== null) {
      if (held.owners.has(owner)) return () => {};
      held.owners.add(owner);
      return () => {
        if (held.owners.delete(owner)) undo();
      };
    }
    if (request.origin === "oauth-callback") {
      if (held.idle) return () => {};
      held.idle = true;
      return () => {
        held.idle = false;
        undo();
      };
    }
    if (held.manual !== null) return () => {};
    held.manual = request.origin;
    return () => {
      held.manual = null;
      undo();
    };
  }

  private cancelRelease(owner: string): void {
    const timer = this.releaseTimers.get(owner);
    if (!timer) return;
    clearTimeout(timer);
    this.releaseTimers.delete(owner);
  }

  private dropOwner(owner: string): void {
    for (const [key, hold] of [...this.holds]) {
      if (hold.owners.delete(owner)) this.settle(key);
    }
  }

  /** Something let go of the forward at `key`: it closes once nothing holds it. */
  private settle(key: string): void {
    const hold = this.holds.get(key);
    const forward = this.forwards.get(key);
    if (isLasting(hold)) {
      if (forward && this.syncOrigin(forward)) this.emit();
      return;
    }
    if (hold?.idle) {
      // One still being added, or waiting for its session, starts its clock once listed.
      if (!forward) return;
      if (this.syncOrigin(forward)) this.emit();
      if (forward.driver.kind === "ssh") this.rehome(key, forward);
      else this.touch(forward);
      return;
    }
    this.holds.delete(key);
    this.lapsed.delete(key);
    const recreation = this.recreating.get(key);
    if (recreation) recreation.stopped = true;
    // One still being added sees nothing holds it and tears itself down.
    if (forward) void this.stop(forward.info.forwardId).catch(() => {});
  }

  /**
   * A forward on the master now held only while in use moves to a link stream
   * on the same local port, where its use shows. ssh's cancel closes only its
   * listener, so connections the page already has keep running on the master.
   */
  private rehome(key: string, forward: ActiveForward): void {
    if (forward.driver.kind !== "ssh" || this.pending.has(key)) return;
    const session = this.deps.sessionFor(forward.info.hostId);
    if (!session?.isOpen) return;
    this.forwards.delete(key);
    const moving = (async (): Promise<PortForward> => {
      if (!(await this.teardown(forward))) {
        // ssh kept it: it stays on the master, on the idle clock alone.
        this.forwards.set(key, forward);
        this.touch(forward);
        return { ...forward.info };
      }
      // Anywhere else, the page's address would reach whatever took the port.
      const moved = await this.createStreamForward(
        { ...forward.info },
        session,
        true,
        forward.info.localPort
      );
      if (this.disposed || !isHeld(this.holds.get(key))) {
        await this.teardown(moved);
        throw new AppError({ code: "CANCELLED", message: "Port forward stopped" });
      }
      this.forwards.set(key, moved);
      this.syncOrigin(moved);
      this.touch(moved);
      return { ...moved.info };
    })();
    this.pending.set(key, moving);
    moving
      .catch(() => {
        if (!this.forwards.has(key) && !isLasting(this.holds.get(key))) this.holds.delete(key);
      })
      .finally(() => {
        if (this.pending.get(key) === moving) this.pending.delete(key);
        this.emit();
      });
  }

  /** List the forward as what holds it now; true when that changed. */
  private syncOrigin(forward: ActiveForward): boolean {
    const hold = this.holds.get(keyOf(forward.info.hostId, forward.info.remotePort));
    const origin = originOf(hold, forward.info.origin);
    if (forward.info.origin === origin) return false;
    forward.info.origin = origin;
    return true;
  }

  /** The port is taken here; when one of these forwards has it, say which host's. */
  private portInUse(port: number, origin: PortForwardOrigin): AppError {
    const holder = [...this.forwards.values()].find(
      (forward) => forward.info.localPort === port && this.isLive(forward)
    );
    const blocked =
      origin === "oauth-callback"
        ? "the host's sign-in callback can't reach it"
        : "the host's page can't open here at the same address";
    const userMessage = holder
      ? `Port ${port} on this machine already forwards ${
          this.deps.hostName?.(holder.info.hostId) ?? holder.info.hostId
        }'s port ${holder.info.remotePort}, so ${blocked}. Stop that forward in Ports, then try again.`
      : `Port ${port} is in use on this machine, so ${blocked}. Stop what's using it here, then try again.`;
    return new AppError({
      code: "PORT_IN_USE",
      message: `Port ${port} is taken on this machine`,
      userMessage,
    });
  }

  /** False only when ssh refused to cancel, so the local port is still forwarded. */
  private async teardown(forward: ActiveForward): Promise<boolean> {
    if (forward.idleTimer) clearTimeout(forward.idleTimer);
    forward.idleTimer = null;
    if (forward.driver.kind === "stream") {
      for (const socket of forward.driver.sockets) socket.destroy();
      forward.driver.sockets.clear();
      await forward.driver.listener.close();
      return true;
    }
    const args = buildPortForwardArgs(
      forward.driver.mux,
      forward.info.localPort,
      forward.info.remotePort,
      "cancel",
      forward.driver.resolved
    );
    const cancelled = await runSshMuxCommand(this.spawn, args);
    // Keep the IPv6 side while ssh still holds the IPv4 one, so both stay ours.
    if (cancelled || !forward.driver.session.isOpen) await forward.driver.relay?.close();
    return cancelled;
  }

  private async lookupPreview(
    subdomain: string,
    hostId: HostId,
    generation: number
  ): Promise<RemoteUpstreamResolution | null> {
    let resolution: PreviewResolution | null = null;
    const session = this.deps.sessionFor(hostId);
    if (session) {
      try {
        const answer = await session.call(
          PortLinkMethod.RESOLVE_PREVIEW,
          { subdomain },
          { timeoutMs: PREVIEW_LOOKUP_TIMEOUT_MS }
        );
        const parsed = PreviewResolutionSchema.safeParse(answer);
        if (parsed.success) resolution = parsed.data;
      } catch {
        resolution = null;
      }
    }
    const current = () => this.previewGenerations.get(subdomain) === generation;
    if (!current()) {
      // A newer lookup, or the preview's release, overtook this one: its answer is the one that counts.
      const latest = this.previewCache.get(subdomain);
      return latest && latest.hostId === hostId ? latest.result : null;
    }
    if (resolution?.kind === "ok") {
      const forward = await this.forward(
        { hostId, remotePort: resolution.port, origin: "dev-preview", label: "Dev preview" },
        previewOwner(subdomain)
      );
      if (current()) this.notePreviewForward(subdomain, keyOf(hostId, resolution.port));
      return {
        kind: "ok",
        port: forward.localPort,
        isHttps: resolution.isHttps,
        advertisedPort: resolution.port,
      };
    }
    // The dev server is gone: its forward would otherwise reach whatever takes the port next.
    this.notePreviewForward(subdomain, null);
    return resolution?.kind === "not-running" ? resolution : null;
  }

  /** The preview now resolves to `key` (or to nothing): it lets go of every other forward. */
  private notePreviewForward(subdomain: string, key: string | null): void {
    const owner = previewOwner(subdomain);
    for (const [heldKey, hold] of [...this.holds]) {
      if (heldKey !== key && hold.owners.delete(owner)) this.settle(heldKey);
    }
  }

  /** Whether the forward still holds its local port for the host: its session is open. */
  private isLive(forward: ActiveForward): boolean {
    if (forward.driver.kind === "ssh") return forward.driver.session.isOpen;
    return this.deps.sessionFor(forward.info.hostId)?.isOpen === true;
  }

  private watch(hostId: HostId, session: LinkSession): void {
    if (this.watchedSessions.has(session)) return;
    this.watchedSessions.add(session);
    session.onClose(() => this.sessionClosed(hostId, session));
  }

  /**
   * Stream forwards stop counting until a session is back (their listener is
   * still ours, so nothing else can take the port). ssh forwards on this
   * session are retired now, and added again on the next session.
   */
  private sessionClosed(hostId: HostId, session: LinkSession): void {
    if (this.disposed) return;
    for (const [key, forward] of [...this.forwards]) {
      if (forward.driver.kind !== "ssh" || forward.driver.session !== session) continue;
      this.retire(key, forward);
      this.lapsed.set(key, {
        forwardId: forward.info.forwardId,
        hostId,
        remotePort: forward.info.remotePort,
        origin: forward.info.origin,
        label: forward.info.label,
      });
    }
    this.previewCache.clear();
    this.emit();
    // A resume may already have a new session up.
    if (this.deps.sessionFor(hostId)?.isOpen) void this.reestablish(hostId);
  }

  /** Drop an ssh forward whose master may be gone; cancelling it is only a courtesy. */
  private retire(key: string, forward: ActiveForward): void {
    if (this.forwards.get(key) === forward) this.forwards.delete(key);
    const cancelling = this.teardown(forward).catch(() => false);
    this.retiring.add(cancelling);
    void cancelling.finally(() => this.retiring.delete(cancelling));
  }

  private requireSession(hostId: HostId): LinkSession {
    const session = this.deps.sessionFor(hostId);
    if (!session || !session.isOpen) throw this.disconnected(hostId);
    return session;
  }

  private disconnected(hostId: HostId): AppError {
    return new AppError({
      code: "HOST_DISCONNECTED",
      message: `Host ${hostId} is not connected`,
      userMessage: "Couldn't reach this host. Open a window on it and try again.",
    });
  }

  private emit(): void {
    if (this.disposed) return;
    try {
      this.deps.onChange?.(this.list());
    } catch {
      // A broken subscriber must not undo a forward.
    }
  }
}
