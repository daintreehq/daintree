import os from "node:os";
import { randomUUID } from "node:crypto";
import {
  LOCAL_HOST_ID,
  isLocalHostId,
  parseHostScopedKey,
  sameHostConnection,
  toHostScopedKey,
  type HostConnection,
  type HostConnectionState,
  type HostDescriptor,
  type HostId,
  type HostListEntry,
  type HostRecentUse,
} from "../../../shared/types/remoteHosts.js";
import type {
  AddHostPayload,
  CancelPendingSwitchPayload,
  PendingHostSwitch,
  HostProjectSummary,
  RemoteHostsEvent,
  SwitchWindowHostPayload,
  SwitchWindowHostResult,
  UpdateHostPayload,
  WindowHostInfo,
} from "../../../shared/types/ipc/remoteHosts.js";
import type { ProjectFocusOnActivateIntent } from "../../../shared/types/ipc/project.js";
import type { IpcContext } from "../../ipc/types.js";
import type { RemoteRouter } from "../../ipc/endpoint.js";
import { AppError } from "../../utils/errorTypes.js";
import { sshAccessDenied } from "./sshAccessError.js";
import { rememberRemoteWorkspaceTitle } from "../../window/windowTitle.js";
import { discardFromAllProjectHistories } from "../../services/ProjectHistoryService.js";
import { getRemoteService } from "../runtime.js";
import type { HostRegistry } from "./HostRegistry.js";
import { parseHostConnection } from "./connection.js";
import type { HostReadiness, RemoteHostManager } from "./RemoteHostManager.js";
import type { SenderLookup } from "./RemoteRouter.js";
import type { WindowHostBinding } from "./WindowHostBinding.js";
import { DetachedViewRegistry } from "./reconnect/DetachedViewRegistry.js";

/** What the client needs from the window layer, kept narrow so it can be faked in tests. */
export interface WindowControl {
  /** Open an empty window and resolve to its id. */
  openWindow(): Promise<number>;
  /**
   * Show `(hostId, projectId)` in the window's project view manager; the view
   * consumes `focusIntent` once it is showing.
   */
  openRemoteProject(
    windowId: number,
    hostId: HostId,
    projectId: string,
    projectPath: string,
    focusIntent?: ProjectFocusOnActivateIntent
  ): Promise<void>;
  openLocalProject(
    windowId: number,
    projectId: string,
    focusIntent?: ProjectFocusOnActivateIntent
  ): Promise<void>;
  /**
   * The local project to return a window to when it switches back to this
   * machine without naming one: the last this window showed, else the one
   * most recently opened here. Null when there is none.
   */
  lastLocalProjectId(windowId: number | null): string | null;
  /**
   * This window's own projects on a host, most recent first, which a plain
   * switch there returns to: the first the host still has. Empty for a window
   * with no history there, and for a new one.
   */
  recentProjectsOnHost?(windowId: number | null, hostId: HostId): string[];
  /**
   * A window other than `exceptWindowId` with a view of a project, a host's or
   * this machine's: `showing` when it is on screen there or being switched to,
   * otherwise held in that window's cache.
   */
  projectOwner?(
    hostId: HostId,
    projectId: string,
    exceptWindowId: number | null
  ): { windowId: number; showing: boolean } | null;
  /**
   * Mark a project as being opened in `windowId`, so a request for it from
   * another window finds this one, until the returned release runs. Taken in
   * the same tick as the {@link projectOwner} check, so two requests can't
   * both find the project free.
   */
  claimProject?(hostId: HostId, projectId: string, windowId: number): () => void;
  /**
   * Hand a request for one of this machine's projects to the window showing
   * it, as a local open does: brought forward with the project focused.
   * Answers that window, or null when no other window is showing it. One
   * holding it only in its cache is never switched to it.
   */
  redirectToLocalOwner?(projectId: string, exceptWindowId: number | null): number | null;
  /**
   * Make way for a project to open in `windowId`: a window other than it
   * holding the project only in its cache lets that view go, and nothing it
   * shows changes (#13291). Synchronous, so it runs in the same tick as
   * {@link claimProject}. Answers a window that keeps the project because it is
   * on its way to showing it, else null. Throws when the cached view can't be
   * let go yet; `projectName` names the project in that error.
   */
  releaseCachedProject?(
    hostId: HostId,
    projectId: string,
    windowId: number,
    projectName: string | null
  ): number | null;
  /** Bring a window forward with its project view focused. */
  revealWindow?(windowId: number): void;
  /**
   * Hand `focusIntent` to the window showing `(hostId, projectId)`: straight to
   * its view when that view is on screen, else parked for the switch that is
   * bringing it there.
   */
  focusInWindow?(
    windowId: number,
    hostId: HostId,
    projectId: string,
    focusIntent: ProjectFocusOnActivateIntent
  ): void;
  /** Call `onClosed` once when the window closes. */
  watchWindow(windowId: number, onClosed: () => void): void;
  /**
   * Put a fresh window on this machine (its project picker) where `windowId`
   * is, and close that one: for a window whose host is going away with no
   * project of this machine's to return to, since a view's host is fixed.
   */
  replaceWithLocalWindow?(windowId: number): Promise<void>;
  /** Whether the view on screen in a window (or still leaving it) is one of this host's. */
  showsHost?(windowId: number, hostId: HostId): boolean;
  /**
   * Tell a window's view, if it is up, that it has a host's project list to
   * offer ({@link RemoteHostsClient.takeProjectOffer}). A view still loading
   * asks once it can show the list.
   */
  offerHostProjects?(windowId: number): void;
  /** Send an event to the views a window is showing, and only to them. */
  notifyWindow?(windowId: number, event: RemoteHostsEvent): void;
}

export interface RemoteHostsClientOptions {
  registry: HostRegistry;
  manager: RemoteHostManager;
  bindings: WindowHostBinding;
  router: RemoteRouter;
  senders: SenderLookup;
  windows: WindowControl;
  /** Route remote-bound views through the dispatcher; installed on first use. */
  installRouter: (router: RemoteRouter | null) => void;
  /** Push to every local renderer. */
  emit: (event: RemoteHostsEvent) => void;
  /**
   * Runs once, the first time a host is actually used (connect or switch), so
   * the per-view stream wiring costs nothing for a user who never adds one.
   */
  onFirstUse?: () => void;
  /** How long opening a host's project waits for its link before giving up. */
  readyTimeoutMs?: number;
  /**
   * Whether this machine is checking on or starting Daintree on the host
   * right now (a reboot or power cut left it stopped). A wait for the link
   * goes on while it is, up to {@link STARTING_TIMEOUT_MS}.
   */
  isStarting?: (hostId: HostId) => boolean;
  /** How long forgetting a host waits for each of its windows to come back here. */
  forgetSwitchWaitMs?: number;
  /** After a host is forgotten: drop what this machine kept for it (SSH master, cached bundles). */
  onForget?: (descriptor: HostDescriptor) => Promise<void>;
  /**
   * Before a host is re-pointed at another SSH target: drop what this machine
   * kept for the machine it named until now (its permissions, views, history,
   * storage and SSH master), as a removal does, keeping the record itself.
   */
  onRetarget?: (before: HostDescriptor) => Promise<void>;
  /**
   * Whether an install or update is running on that connection. It reconnects
   * to the host when done, so the host's target can't change and the host
   * can't be removed until it settles.
   */
  isInstalling?: (connection: HostConnection) => boolean;
}

const DEFAULT_READY_TIMEOUT_MS = 20_000;
/**
 * The longest a wait for the link goes on while the host's Daintree is being
 * started: its launch is given 30 s and its listener a minute.
 */
const STARTING_TIMEOUT_MS = 120_000;

/**
 * Forgetting a host waits this long for a window's local project to activate:
 * a workspace host that never reports ready must not hold the host's removal
 * (the switch carries on, and the window lands when it does).
 */
const DEFAULT_FORGET_SWITCH_WAIT_MS = 5_000;

const MAX_PROJECT_ID_LENGTH = 256;

/** What a wait resolves to once its switch was abandoned for a newer navigation or Cancel. */
const ABANDONED = Symbol("abandoned");

interface SwitchTicket {
  /** Names this request to the window's views, and to the Cancel that answers it. */
  id: string;
  isCurrent(): boolean;
  /** Resolves when a newer request (or Cancel) takes the window. */
  abandoned: Promise<typeof ABANDONED>;
}

function invalid(message: string): AppError {
  return new AppError({ code: "VALIDATION", message });
}

function focusIntentOf(payload: SwitchWindowHostPayload): ProjectFocusOnActivateIntent | undefined {
  const intent: unknown = payload.focusIntent;
  if (intent === undefined) return undefined;
  if (typeof intent === "object" && intent !== null) {
    const { intent: kind, panelId } = intent as { intent?: unknown; panelId?: unknown };
    if (kind === "focus-next-waiting") return { intent: kind };
    if (
      kind === "focus-panel" &&
      typeof panelId === "string" &&
      panelId.length > 0 &&
      panelId.length <= MAX_PROJECT_ID_LENGTH
    ) {
      return { intent: kind, panelId };
    }
  }
  throw invalid("focusIntent is not a focus intent");
}

function hostIdOf(payload: unknown): HostId {
  const hostId = (payload as { hostId?: unknown } | null)?.hostId;
  if (typeof hostId !== "string" || hostId.length === 0) throw invalid("hostId is required");
  return hostId;
}

/**
 * The Shell side of Remote Hosts behind the `remoteHosts` IPC namespace: the
 * host list, one connection per host, which host each window is attached to,
 * and opening a host's project in a window.
 */
export class RemoteHostsClient {
  private routerInstalled = false;
  private readonly watchedWindows = new Set<number>();
  /** New windows opened onto a host with no project there: the host whose list each offers. */
  private readonly projectOffers = new Map<number, HostId>();
  /** Each window's newest switch request; abandoning it settles the wait it is in. */
  private readonly switchTickets = new Map<number, { seq: number; abandon: () => void }>();
  /** A window's switch to a host that hasn't landed yet, as its views are told. */
  private readonly pendingSwitches = new Map<number, PendingHostSwitch>();
  /**
   * A window's committed switch whose view isn't showing yet. A newer request
   * can take over what the views are told; if that one gives up first, they
   * are told about this one again, since it is still moving the window.
   */
  private readonly committedSwitches = new Map<number, PendingHostSwitch>();
  private readonly switchChains = new Map<number, Promise<void>>();
  /**
   * Hosts being removed or re-pointed, with the target they had: from the
   * first moment until that settles, no window switches onto one and no
   * install or Host mode setup starts on its connection.
   */
  private readonly retiring = new Map<HostId, HostConnection>();
  /**
   * Bumped each time a host starts being removed or re-pointed: a switch that
   * began before then is about the old machine even once the change is done.
   */
  private readonly epochs = new Map<HostId, number>();
  private readonly unsubscribe: Array<() => void> = [];
  private readonly detached: DetachedViewRegistry;

  constructor(private readonly options: RemoteHostsClientOptions) {
    this.detached = new DetachedViewRegistry({
      isBoundTo: (webContentsId, hostId) => this.viewHost(webContentsId) === hostId,
      whenReady: async (hostId) => {
        const connection = this.options.manager.get(hostId);
        if (!connection) return false;
        return (await this.whenReady(connection, hostId)) === "ready";
      },
      // Every view of the host hears it; the renderer ignores other hosts' resyncs.
      resync: (hostId) =>
        this.options.emit({ type: "resync-required", hostId, reason: "reconnected" }),
    });
    this.unsubscribe.push(
      // A window on the host is using it, whether or not its view has called through yet.
      options.manager.addUseCheck((hostId) => options.bindings.windowsOn(hostId).length > 0),
      options.registry.onChange(() =>
        this.options.emit({ type: "hosts-changed", hosts: this.list() })
      ),
      options.manager.onStateChange((hostId, connection) => {
        this.options.emit({ type: "connection-changed", hostId, connection });
        this.detached.onConnectionState(hostId, connection);
      })
    );
  }

  /** When windows here last landed on each host, most recent first. */
  listRecent(): HostRecentUse[] {
    return this.options.registry.recentUses();
  }

  list(): HostListEntry[] {
    return this.options.registry.list().map((descriptor) => ({
      descriptor,
      connection: this.options.manager.connectionState(descriptor.id),
      // The last summary frame, so a refreshed list isn't blank until the next one.
      summary: getRemoteService("hostMetrics")?.latest(descriptor.id) ?? null,
    }));
  }

  add(payload: AddHostPayload): HostDescriptor {
    return this.options.registry.add(payload);
  }

  async update(payload: UpdateHostPayload): Promise<HostDescriptor> {
    const before = this.options.registry.require(hostIdOf(payload));
    const next = payload.connection !== undefined ? parseHostConnection(payload.connection) : null;
    if (!next || sameHostConnection(next, before.connection)) {
      return this.options.registry.update(payload);
    }
    // Another target may be another machine. Nothing of the old one's carries
    // over: its windows come back here first, then its link, views and
    // permissions go, and only then is the host rebound. Nothing dials the new
    // target until someone connects.
    this.refuseWhileInstalling(before, "Its SSH target can change");
    this.refuseWhileRetiring(before);
    this.options.registry.validateUpdate(payload);
    this.retire(before);
    try {
      // The id stays, so a window still showing the old machine is replaced
      // rather than waited on: its view must not outlive the cleanup and be
      // reused against the new target.
      await this.returnWindowsHome(before.id, { replaceOnTimeout: true });
      await this.options.manager.disconnect(before.id);
      this.detached.forget(before.id);
      this.dropProjectOffers(before.id);
      await this.options.onRetarget?.(before);
      const after = this.options.registry.update(payload);
      // A link dialled meanwhile by something that doesn't ask (a notification,
      // an update's reconnect) was built for the old target.
      await this.options.manager.disconnect(before.id);
      return after;
    } finally {
      this.retiring.delete(before.id);
    }
  }

  async forget(payload: { hostId: string }): Promise<void> {
    const hostId = hostIdOf(payload);
    const descriptor = this.options.registry.require(hostId);
    this.refuseWhileInstalling(descriptor, "It can be removed");
    this.refuseWhileRetiring(descriptor);
    // Taken before the first await: an install, Host mode setup or window
    // switch asked for meanwhile is refused rather than racing the cleanup.
    this.retire(descriptor);
    try {
      await this.returnWindowsHome(hostId);
      await this.options.manager.disconnect(hostId);
      this.detached.forget(hostId);
      this.dropProjectOffers(hostId);
      this.options.registry.forget(hostId);
      // Anything dialled it meanwhile without asking: the link goes with the record.
      await this.options.manager.disconnect(hostId);
      await this.options.onForget?.(descriptor).catch((error: unknown) => {
        console.warn("[RemoteHosts] Cleanup after forgetting a host failed:", error);
      });
    } finally {
      this.retiring.delete(hostId);
    }
  }

  /**
   * Whether a host on this connection is being removed or re-pointed: an
   * install or Host mode setup there would race the cleanup that closes its
   * SSH master, so none starts until that settles.
   */
  isRetiring(connection: HostConnection): boolean {
    for (const retiring of this.retiring.values()) {
      if (sameHostConnection(retiring, connection)) return true;
    }
    return false;
  }

  /**
   * Windows on the host come back to this machine, binding and view together,
   * as removing or re-pointing it promises: only rebinding left the host's view
   * on screen with nothing behind it and no host chip to leave by. A window
   * the person moved elsewhere meanwhile is left where they put it.
   */
  private retire(descriptor: HostDescriptor): void {
    this.retiring.set(descriptor.id, descriptor.connection);
    this.epochs.set(descriptor.id, (this.epochs.get(descriptor.id) ?? 0) + 1);
  }

  private async returnWindowsHome(
    hostId: HostId,
    { replaceOnTimeout = false }: { replaceOnTimeout?: boolean } = {}
  ): Promise<void> {
    const waitMs = this.options.forgetSwitchWaitMs ?? DEFAULT_FORGET_SWITCH_WAIT_MS;
    // Windows whose binding was moved here before their switch home landed.
    // Their switch is still wanted: the view it replaces is still the host's,
    // and one ahead of it in the window's queue may yet activate it.
    const forced = new Set<number>();
    const stillOnHost = (windowId: number) =>
      forced.has(windowId) || this.options.bindings.get(windowId) === hostId;
    await Promise.all(
      [...this.options.bindings.windowsOn(hostId)].map(async (windowId) => {
        const projectId = this.options.windows.lastLocalProjectId(windowId);
        // Nothing here to show: a fresh window on this machine's picker takes its place.
        const replace = () =>
          (this.options.windows.replaceWithLocalWindow?.(windowId) ?? Promise.resolve()).catch(
            (error: unknown) => {
              console.warn("[RemoteHosts] Couldn't replace a host's window:", error);
            }
          );
        const moved =
          projectId === null
            ? replace()
            : this.switchWindow(
                windowId,
                { hostId: LOCAL_HOST_ID, newWindow: false, projectId },
                () => stillOnHost(windowId)
              ).then(
                // That project went to another window meanwhile: still nothing here to show.
                (result) =>
                  result.outcome === "focused-elsewhere" && stillOnHost(windowId)
                    ? replace()
                    : undefined,
                (error: unknown) => {
                  console.warn("[RemoteHosts] Couldn't bring a window back from a host:", error);
                  // The switch home itself failed, so the host's view may be back on
                  // screen whatever the binding says: a local window replaces it,
                  // unless the person has since sent the window to another host.
                  const bound = this.options.bindings.get(windowId);
                  return isLocalHostId(bound) || bound === hostId ? replace() : undefined;
                }
              );
        let landed = false;
        void moved.then(() => {
          landed = true;
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const waited = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, waitMs);
          timer.unref?.();
        });
        await Promise.race([moved, waited]);
        clearTimeout(timer);
        // Only while the old machine's view is still what it shows: a local
        // project still finishing its activation is already this machine's.
        if (
          !landed &&
          replaceOnTimeout &&
          (this.options.windows.showsHost?.(windowId, hostId) ?? true)
        ) {
          await replace();
        }
      })
    );
    for (const windowId of this.options.bindings.windowsOn(hostId)) {
      forced.add(windowId);
      this.options.bindings.set(windowId, LOCAL_HOST_ID);
    }
  }

  private dropProjectOffers(hostId: HostId): void {
    for (const [windowId, offered] of [...this.projectOffers]) {
      if (offered === hostId) this.projectOffers.delete(windowId);
    }
  }

  private refuseWhileRetiring(descriptor: HostDescriptor): void {
    if (!this.retiring.has(descriptor.id)) return;
    const message = `${descriptor.name} is already being changed. Try again once that finishes.`;
    throw new AppError({ code: "VALIDATION", message, userMessage: message });
  }

  private refuseWhileInstalling(descriptor: HostDescriptor, then: string): void {
    if (!this.options.isInstalling?.(descriptor.connection)) return;
    const message = `Daintree is being installed on ${descriptor.name}. ${then} once that finishes.`;
    throw new AppError({ code: "VALIDATION", message, userMessage: message });
  }

  connect(payload: { hostId: string }): HostConnectionState {
    const hostId = hostIdOf(payload);
    // Being removed or re-pointed: a link dialled now would be to the old machine.
    if (this.retiring.has(hostId)) return this.options.manager.connectionState(hostId);
    this.ensureRouter();
    return this.options.manager.connect(hostId).state();
  }

  /** Told whenever a host's connection state changes; returns the unsubscribe. */
  onConnectionChange(listener: (hostId: HostId, state: HostConnectionState) => void): () => void {
    return this.options.manager.onStateChange(listener);
  }

  /** Dial (or re-dial) a host and settle once it is usable, runs another build, or times out. */
  connectAndWait(hostId: HostId, timeoutMs: number): Promise<HostReadiness> {
    this.ensureRouter();
    return this.options.manager.connect(hostId).whenReady(timeoutMs);
  }

  async disconnect(payload: { hostId: string }): Promise<void> {
    const hostId = hostIdOf(payload);
    this.rememberBoundViews(hostId);
    await this.options.manager.disconnect(hostId);
  }

  /**
   * A connected host's projects, for the other-hosts listings. Listing never
   * dials: a host that isn't connected is reported as such.
   */
  async listHostProjects(payload: { hostId: string }): Promise<HostProjectSummary[]> {
    const hostId = hostIdOf(payload);
    this.options.manager.touch(hostId);
    if (isLocalHostId(hostId)) throw invalid("The local host is listed by the Shell");
    this.options.registry.require(hostId);
    const connection = this.options.manager.get(hostId);
    if (!connection) {
      throw new AppError({
        code: "HOST_DISCONNECTED",
        message: `Host ${hostId} is not connected`,
        userMessage: "Couldn't reach this host. Check that it is on and try again.",
      });
    }
    return connection.listProjects();
  }

  /**
   * The host whose project list the sender's window was opened to offer, handed
   * out once: a send before the view listened would be lost, so the view asks.
   * Null when there is none, or the host has since been removed.
   */
  takeProjectOffer(ctx: IpcContext): HostId | null {
    const windowId = this.windowOf(ctx);
    if (windowId === null) return null;
    const hostId = this.projectOffers.get(windowId) ?? null;
    this.projectOffers.delete(windowId);
    return hostId !== null && this.options.registry.get(hostId) ? hostId : null;
  }

  getWindowHost(ctx: IpcContext): WindowHostInfo {
    const hostId = this.hostOfSender(ctx);
    if (isLocalHostId(hostId)) return localWindowHost();
    const descriptor = this.options.registry.get(hostId);
    const connection = this.options.manager.get(hostId);
    const handshake =
      connection?.linkState.status === "connected" ? connection.linkState.handshake : null;
    const info = connection?.hostInfo ?? null;
    return {
      hostId,
      descriptor,
      connection: this.options.manager.connectionState(hostId),
      // Hosts are macOS or Linux; POSIX paths are right for either until one reports in.
      hostPlatform:
        info?.platform ??
        handshake?.platform ??
        descriptor?.platform ??
        descriptor?.lastHandshake?.platform ??
        "linux",
      hostHomeDir: info?.homeDir ?? null,
      hostTmpDir: info?.tmpDir ?? null,
    };
  }

  /** The host a window is attached to: this machine unless a switch put it on a host. */
  windowHost(windowId: number): HostId {
    return this.options.bindings.get(windowId);
  }

  /**
   * Bring a window that is on a host back to this machine, showing one of its
   * projects: how main opens a folder of this machine in such a window, so the
   * window's binding and its view move together.
   */
  switchWindowToLocal(windowId: number, projectId: string): Promise<SwitchWindowHostResult> {
    return this.switchWindow(windowId, { hostId: LOCAL_HOST_ID, newWindow: false, projectId });
  }

  /**
   * Put an existing window back on a host's project: how main restores a
   * window that was showing it when the app last quit. `stillWanted` is asked
   * before the window moves, so a project the person opened there while the
   * host was connecting is never replaced.
   */
  switchWindowToHostProject(
    windowId: number,
    hostId: HostId,
    projectId: string,
    stillWanted?: () => boolean
  ): Promise<SwitchWindowHostResult> {
    return this.switchWindow(windowId, { hostId, newWindow: false, projectId }, stillWanted);
  }

  /**
   * Open a host's project in a new window on that host, the project named by
   * its path there: what a remote view's "open in new window" hands main.
   */
  async openHostProjectInNewWindow(
    hostId: HostId,
    projectPath: string
  ): Promise<SwitchWindowHostResult> {
    const projects = await this.listHostProjects({ hostId });
    const project = projects.find((candidate) => candidate.path === projectPath);
    if (!project) {
      throw new AppError({
        code: "NOT_FOUND",
        message: `Host ${hostId} has no project at ${projectPath}`,
        userMessage: "This project isn't on that host.",
      });
    }
    return this.switchWindow(null, { hostId, newWindow: true, projectId: project.id });
  }

  /**
   * Put a window (or a new one) on a host. With a project named, that project
   * opens there. Without one the window returns to the project it last showed
   * on that host, as the host remembers it for this machine (or, for this
   * machine, as its own history does); when there is none, nothing moves and
   * the caller is told to offer that host's project list instead. A window
   * is only ever rebound together with the view it shows, so its binding and
   * its view never name different hosts.
   */
  switchWindowHost(
    ctx: IpcContext,
    payload: SwitchWindowHostPayload
  ): Promise<SwitchWindowHostResult> {
    return this.switchWindow(this.windowOf(ctx), payload);
  }

  private async switchWindow(
    askingWindowId: number | null,
    payload: SwitchWindowHostPayload,
    stillWanted?: () => boolean
  ): Promise<SwitchWindowHostResult> {
    const hostId = hostIdOf(payload);
    const newWindow = payload.newWindow === true;
    const projectId = payload.projectId;
    if (
      projectId !== undefined &&
      (typeof projectId !== "string" ||
        projectId.length === 0 ||
        projectId.length > MAX_PROJECT_ID_LENGTH)
    ) {
      throw invalid("projectId must be a non-empty string");
    }
    // Something to focus only in a project the switch names.
    const focusIntent = projectId === undefined ? undefined : focusIntentOf(payload);

    const remote = !isLocalHostId(hostId);
    const epoch = this.epochs.get(hostId) ?? 0;
    if (remote) {
      this.options.registry.require(hostId);
      // Not even dialled: its removal or new target would close the link again.
      if (this.retiring.has(hostId)) return { outcome: "superseded", hostId };
    }
    const sourceWindowId = newWindow ? null : askingWindowId;
    // The latest request for a window wins: one still waiting on its host when
    // a newer one arrives resolves as superseded and never moves the window.
    const ticket = sourceWindowId === null ? null : this.takeSwitchTicket(sourceWindowId);
    // A host being removed or re-pointed, or gone already, takes no window:
    // checked at every await, so an open that was waiting on the host, on a
    // project lookup or on `openWindow()` never binds to it afterwards.
    const superseded = (): SwitchWindowHostResult | null =>
      (ticket !== null && !ticket.isCurrent()) ||
      (stillWanted !== undefined && !stillWanted()) ||
      (remote &&
        (this.retiring.has(hostId) ||
          (this.epochs.get(hostId) ?? 0) !== epoch ||
          this.options.registry.get(hostId) === null))
        ? { outcome: "superseded", hostId }
        : null;
    // What the window being switched hears while the host is on its way: only
    // one moving to a host waits on anything worth saying, and a new window
    // has no view yet to say it in.
    const pendingWindowId = remote && ticket !== null ? sourceWindowId : null;
    let pendingProjectName: string | null = null;
    const announce = (phase: PendingHostSwitch["phase"]): void => {
      if (pendingWindowId === null || ticket === null || !ticket.isCurrent()) return;
      const current = this.pendingSwitches.get(pendingWindowId);
      if (current?.switchId === ticket.id && current.committed) return;
      if (
        current?.switchId === ticket.id &&
        current.phase === phase &&
        current.projectName === pendingProjectName
      ) {
        return;
      }
      this.publishPendingSwitch(pendingWindowId, {
        switchId: ticket.id,
        hostId,
        hostName: this.options.registry.get(hostId)?.name ?? hostId,
        projectName: pendingProjectName,
        phase,
      });
    };
    const settlePending = (): void => {
      if (pendingWindowId === null || ticket === null) return;
      if (this.committedSwitches.get(pendingWindowId)?.switchId === ticket.id) {
        this.committedSwitches.delete(pendingWindowId);
      }
      if (this.pendingSwitches.get(pendingWindowId)?.switchId === ticket.id) {
        // An earlier switch still opening keeps typing held until it lands.
        this.publishPendingSwitch(
          pendingWindowId,
          this.committedSwitches.get(pendingWindowId) ?? null
        );
      }
    };
    // No longer on offer to cancel, but still pending until the window's new
    // view is showing: until then the old one is on screen, and what is typed
    // there must not reach it.
    const commitPending = (): void => {
      if (pendingWindowId === null || ticket === null) return;
      const current = this.pendingSwitches.get(pendingWindowId);
      if (current?.switchId !== ticket.id || current.committed) return;
      const committed: PendingHostSwitch = { ...current, committed: true };
      this.committedSwitches.set(pendingWindowId, committed);
      this.publishPendingSwitch(pendingWindowId, committed);
    };
    try {
      const result = await this.runSwitch(
        askingWindowId,
        hostId,
        newWindow,
        projectId,
        ticket,
        superseded,
        announce,
        commitPending,
        (name) => void (pendingProjectName = name),
        focusIntent
      );
      // A window is showing that host now: it's the one the switcher offers first.
      // Not `window-opened`: that window stays on this machine offering the
      // host's projects, and picking one comes back through here.
      if (result.outcome === "switched" || result.outcome === "focused-elsewhere") {
        try {
          this.options.registry.recordUse(hostId);
        } catch (error) {
          // The window moved either way; only the switcher's order misses it.
          console.error("[RemoteHostsClient] Couldn't record host use:", error);
        }
      }
      return result;
    } finally {
      settlePending();
    }
  }

  private async runSwitch(
    askingWindowId: number | null,
    hostId: HostId,
    newWindow: boolean,
    requestedProjectId: string | undefined,
    ticket: SwitchTicket | null,
    superseded: () => SwitchWindowHostResult | null,
    announce: (phase: PendingHostSwitch["phase"]) => void,
    /** Called once the switch commits: past here it can't be cancelled. */
    commit: () => void,
    nameProject: (name: string | null) => void,
    focusIntent?: ProjectFocusOnActivateIntent
  ): Promise<SwitchWindowHostResult> {
    let projectId = requestedProjectId;
    const remote = !isLocalHostId(hostId);
    const sourceWindowId = newWindow ? null : askingWindowId;
    // Whatever the switch is waiting on, it stops waiting the moment a newer
    // navigation in the window (or Cancel) abandons it.
    const untilAbandoned = <T>(work: Promise<T>): Promise<T | typeof ABANDONED> =>
      ticket ? Promise.race([work, ticket.abandoned]) : work;
    let projectPath: string | null = null;
    let projectName: string | null = null;
    let connection: ReturnType<RemoteHostManager["connect"]> | null = null;
    if (remote) {
      this.ensureRouter();
      connection = this.options.manager.connect(hostId);
      if (connection.linkState.status === "version-mismatch") throw versionMismatch(hostId);
      // A cold switch dials the host now. The view is created only once the
      // link is up and the host has named the project's path: a view made
      // before that would open with no path and its first calls would fail.
      const hostConnection = connection;
      const readiness = await untilAbandoned(
        this.whenReady(hostConnection, hostId, () =>
          announce(this.options.isStarting?.(hostId) ? "starting" : "connecting")
        )
      );
      const stale = superseded();
      if (stale || readiness === ABANDONED) return stale ?? { outcome: "superseded", hostId };
      if (readiness === "version-mismatch") throw versionMismatch(hostId);
      if (readiness === "host-mode-off")
        throw hostModeOff(this.options.registry.get(hostId)?.name ?? hostId);
      if (readiness === "stopped-retrying") {
        // ssh couldn't log in (Host mode off is ruled out above). It won't
        // change by waiting, and a new window could never show the host either.
        const link = hostConnection.linkState;
        throw sshAccessDenied(
          this.options.registry.get(hostId)?.name ?? hostId,
          link.status === "unreachable" ? link.detail : null
        );
      }
      if (readiness !== "ready") {
        // A new window can show the host's project list while it connects;
        // anything that has to find a project there needs the host's answer.
        if (projectId !== undefined || !newWindow) {
          throw new AppError({
            code: "HOST_DISCONNECTED",
            message: `Host ${hostId} did not connect (${readiness})`,
            userMessage: "Couldn't reach this host. Check that it is on and try again.",
          });
        }
      } else if (projectId === undefined) {
        // Where this window last was on the host first, newest first and past
        // any the host no longer has; the host's memory of this machine is the
        // fallback, then its project picker. Never a project another window is
        // showing: the host's memory is shared by every window (#13291).
        announce("opening");
        const recent = this.options.windows.recentProjectsOnHost?.(sourceWindowId, hostId) ?? [];
        let remembered: { projectId: string; path: string; name: string } | null = null;
        for (const candidate of recent) {
          // Asked per candidate, after every wait: another window may have
          // started showing one while the host was answering about another.
          if (this.shownElsewhere(hostId, candidate, sourceWindowId)) continue;
          // Best effort: a host that can't say where to return offers its
          // project list instead.
          const answer = await untilAbandoned(
            hostConnection.describeProject(candidate).then(
              (description) => description ?? "gone",
              () => null
            )
          );
          if (answer === ABANDONED) return { outcome: "superseded", hostId };
          const staleAnswer = superseded();
          if (staleAnswer) return staleAnswer;
          if (answer === null) break;
          if (answer === "gone") {
            // It won't come back on a later press, so the toggle stops offering it.
            const key = toHostScopedKey(hostId, candidate);
            discardFromAllProjectHistories((workspaceId) => workspaceId === key);
          } else if (answer.path && !this.shownElsewhere(hostId, candidate, sourceWindowId)) {
            remembered = { projectId: candidate, path: answer.path, name: answer.name };
            break;
          }
        }
        const hostLast =
          remembered ??
          (await untilAbandoned(hostConnection.lastActiveProject().catch(() => null)));
        if (hostLast === ABANDONED) return { outcome: "superseded", hostId };
        const last =
          hostLast && !this.shownElsewhere(hostId, hostLast.projectId, sourceWindowId)
            ? hostLast
            : null;
        const staleLast = superseded();
        if (staleLast) return staleLast;
        if (last?.path) {
          projectId = last.projectId;
          projectPath = last.path;
          projectName = last.name;
        }
      } else {
        // Only the host saying it has no such project means it's gone: a link
        // that dropped or timed out mid-lookup is the host being unreachable,
        // and Retry is what helps there.
        announce("opening");
        let description: Awaited<ReturnType<typeof hostConnection.describeProject>>;
        try {
          const answer = await untilAbandoned(hostConnection.describeProject(projectId));
          if (answer === ABANDONED) return { outcome: "superseded", hostId };
          description = answer;
        } catch (error) {
          const staleFailure = superseded();
          if (staleFailure) return staleFailure;
          throw unreachableLookup(hostId, error);
        }
        const staleLookup = superseded();
        if (staleLookup) return staleLookup;
        if (!description?.path) {
          // It won't come back on a later press, so the toggle stops offering it.
          const key = toHostScopedKey(hostId, projectId);
          discardFromAllProjectHistories((workspaceId) => workspaceId === key);
          throw new AppError({
            code: "NOT_FOUND",
            message: `Host ${hostId} has no project ${projectId}`,
            userMessage: "This project isn't on that host.",
          });
        }
        projectPath = description.path;
        projectName = description.name;
        nameProject(projectName);
        announce("opening");
      }
    } else if (projectId === undefined) {
      projectId = this.options.windows.lastLocalProjectId(sourceWindowId) ?? undefined;
    }

    const stale = superseded();
    if (stale) return stale;
    // Nothing to return to, and no new window to show the host's project list
    // in: leave this window as it is and let the caller offer the list.
    if (projectId === undefined && !newWindow) return { outcome: "choose-project", hostId };

    // A project has one view in this app, a host's as much as this machine's:
    // a second would be a second view on the same terminals (for a host's, a
    // second endpoint, the two claiming the lease from each other). A window
    // showing it comes forward instead; one only holding it in its cache lets
    // it go once this switch has its turn, and is otherwise left as it is.
    if (projectId !== undefined) {
      const redirected = this.redirectToOwner(hostId, projectId, sourceWindowId);
      if (redirected) return this.focusedElsewhere(redirected, focusIntent);
    }

    const windowId = newWindow ? await this.options.windows.openWindow() : sourceWindowId;
    if (windowId === null) {
      throw new AppError({ code: "INTERNAL", message: "No window to attach to the host" });
    }
    const targetProjectId = projectId;
    const targetPath = projectPath;
    // Passed only when there is one, so a plain switch opens as it always has.
    const focusArg: [] | [ProjectFocusOnActivateIntent] = focusIntent ? [focusIntent] : [];
    let releaseClaim: () => void = () => {};
    const switching = this.inSwitchTurn(windowId, async (): Promise<SwitchWindowHostResult> => {
      // Checked again in turn: a newer request may have arrived while this
      // one waited behind the window's previous switch.
      const late = superseded();
      if (late) return late;
      // From here the window moves: nothing checks for a newer request again,
      // so it is no longer on offer to cancel.
      commit();
      // Only a new window reaches here without a project. It stays on this
      // machine and offers the host's project list: binding it with no view of
      // the host's behind it made a window whose calls went to the host while
      // its chip, copy and pickers all said This Mac.
      const offerProjects = (): SwitchWindowHostResult => {
        this.projectOffers.set(windowId, hostId);
        this.options.windows.watchWindow(windowId, () => this.projectOffers.delete(windowId));
        this.options.windows.offerHostProjects?.(windowId);
        return { outcome: "window-opened", hostId };
      };
      if (targetProjectId === undefined) return offerProjects();
      // Asked again here, and the project claimed for this window in the same
      // tick: another request may have taken it while this one waited, and
      // one arriving now finds this window instead of building a second view.
      // Claimed only now, past the last cancellation check, since a window's
      // own claim reads as an open of the person's in flight there. A window
      // holding the project only in its cache lets its view go in that tick
      // too (#13291): what it shows, and the host it is on, never change.
      const holder =
        this.options.windows.releaseCachedProject?.(
          hostId,
          targetProjectId,
          windowId,
          projectName
        ) ?? null;
      // A project this switch picked itself, which another window started
      // showing while it waited for its turn: nothing was asked of that window,
      // so it isn't brought forward. This one offers the host's list instead.
      if (
        requestedProjectId === undefined &&
        (holder !== null || this.shownElsewhere(hostId, targetProjectId, windowId))
      ) {
        return newWindow ? offerProjects() : { outcome: "choose-project", hostId };
      }
      const shower = isLocalHostId(hostId)
        ? (this.options.windows.redirectToLocalOwner?.(targetProjectId, windowId) ?? null)
        : (this.options.windows.projectOwner?.(hostId, targetProjectId, windowId)?.windowId ??
          null);
      const owner = shower ?? holder;
      if (owner !== null) {
        if (remote || shower === null) this.options.windows.revealWindow?.(owner);
        return this.focusedElsewhere(
          {
            outcome: "focused-elsewhere",
            hostId,
            projectId: targetProjectId,
            targetWindowId: owner,
          },
          focusIntent
        );
      }
      releaseClaim =
        this.options.windows.claimProject?.(hostId, targetProjectId, windowId) ?? releaseClaim;
      const previousHost = this.options.bindings.get(windowId);
      const nextHost = remote ? hostId : LOCAL_HOST_ID;
      this.options.bindings.set(windowId, nextHost);
      this.watchClosing(windowId);

      try {
        if (!remote) {
          await this.options.windows.openLocalProject(windowId, targetProjectId, ...focusArg);
          return { outcome: "switched", hostId: LOCAL_HOST_ID, projectId: targetProjectId };
        }
        // Set above for every remote switch that names a project; never open a pathless view.
        if (targetPath === null) {
          throw new AppError({ code: "INTERNAL", message: "No host path" });
        }
        // The window's title names the place too: "<project> — <host>".
        rememberRemoteWorkspaceTitle(
          toHostScopedKey(hostId, targetProjectId),
          projectName || targetProjectId,
          hostId
        );
        await this.options.windows.openRemoteProject(
          windowId,
          hostId,
          targetProjectId,
          targetPath,
          ...focusArg
        );
      } catch (error) {
        // The view didn't move, so neither does the binding: they never name
        // different hosts.
        // Only while the window is still open, and never back onto a host
        // that was forgotten meanwhile.
        if (
          this.options.bindings.get(windowId) === nextHost &&
          this.watchedWindows.has(windowId) &&
          (isLocalHostId(previousHost) || this.options.registry.get(previousHost) !== null)
        ) {
          this.options.bindings.set(windowId, previousHost);
        }
        throw error;
      }
      connection?.noteActiveProject(targetProjectId);
      return { outcome: "switched", hostId, projectId: targetProjectId };
    });
    // Held until the window's views have the project (or the switch gave up).
    return switching.finally(() => releaseClaim());
  }

  /** The window that already had the project takes the focus the switch was asked for. */
  private focusedElsewhere(
    result: SwitchWindowHostResult,
    focusIntent: ProjectFocusOnActivateIntent | undefined
  ): SwitchWindowHostResult {
    if (focusIntent && result.outcome === "focused-elsewhere") {
      this.options.windows.focusInWindow?.(
        result.targetWindowId,
        result.hostId,
        result.projectId,
        focusIntent
      );
    }
    return result;
  }

  /** Whether a window other than `windowId` is showing the project, or on its way to it. */
  private shownElsewhere(hostId: HostId, projectId: string, windowId: number | null): boolean {
    return this.options.windows.projectOwner?.(hostId, projectId, windowId)?.showing === true;
  }

  /**
   * Another window is showing the project: it comes forward instead of this
   * one opening a second view. One holding it only in its cache is no owner
   * here: the switch takes the project from it in turn, and never switches
   * that window to it (#13291). Null when no other window is showing it.
   */
  private redirectToOwner(
    hostId: HostId,
    projectId: string,
    sourceWindowId: number | null
  ): SwitchWindowHostResult | null {
    const owner = this.options.windows.projectOwner?.(hostId, projectId, sourceWindowId);
    if (!owner?.showing) return null;
    if (isLocalHostId(hostId)) {
      const target = this.options.windows.redirectToLocalOwner?.(projectId, sourceWindowId) ?? null;
      return target === null
        ? null
        : { outcome: "focused-elsewhere", hostId, projectId, targetWindowId: target };
    }
    this.options.windows.revealWindow?.(owner.windowId);
    return { outcome: "focused-elsewhere", hostId, projectId, targetWindowId: owner.windowId };
  }

  /**
   * A navigation in the window that didn't come through here (a local project
   * or scratch picked, File › Open Recent): a host switch still waiting there
   * gives way to it rather than pulling the window to the host when it answers.
   */
  supersedePendingSwitch(windowId: number): void {
    if (this.switchTickets.has(windowId)) this.takeSwitchTicket(windowId);
  }

  /**
   * Daintree started or stopped being started on a host: a switch still
   * waiting for that host's link says which, as soon as it changes.
   */
  refreshPendingSwitches(hostId: HostId): void {
    const phase = this.options.isStarting?.(hostId) ? "starting" : "connecting";
    for (const [windowId, pending] of this.pendingSwitches) {
      if (
        pending.hostId !== hostId ||
        pending.committed ||
        pending.phase === "opening" ||
        pending.phase === phase
      ) {
        continue;
      }
      this.publishPendingSwitch(windowId, { ...pending, phase });
    }
  }

  /** Whether a switch of `windowId` to a host is on its way. */
  hasPendingSwitch(windowId: number): boolean {
    return this.pendingSwitches.has(windowId);
  }

  /** The asking window's switch to a host that is still on its way, or null. */
  getPendingSwitch(ctx: IpcContext): PendingHostSwitch | null {
    const windowId = this.windowOf(ctx);
    return windowId === null ? null : (this.pendingSwitches.get(windowId) ?? null);
  }

  /**
   * Give up the asking window's switch to a host while it is still on its way.
   * It resolves as superseded straight away, wherever it was waiting, and the
   * window stays as it is. False when there is none left to cancel: it has
   * already committed, or another one replaced it.
   */
  cancelPendingSwitch(ctx: IpcContext, payload: CancelPendingSwitchPayload): boolean {
    const windowId = this.windowOf(ctx);
    if (windowId === null) return false;
    const pending = this.pendingSwitches.get(windowId);
    if (!pending || pending.switchId !== payload?.switchId || pending.committed) return false;
    this.supersedePendingSwitch(windowId);
    return true;
  }

  /**
   * A window's newest switch request; any earlier one still in flight is
   * superseded, and whatever it was waiting on stops being waited for.
   */
  private takeSwitchTicket(windowId: number): SwitchTicket {
    // From its first request, so one that closes mid-switch drops its ticket
    // (and whatever was waiting on it) even if it never got as far as binding.
    this.watchClosing(windowId);
    const previous = this.switchTickets.get(windowId);
    previous?.abandon();
    const seq = (previous?.seq ?? 0) + 1;
    let abandon!: () => void;
    const abandoned = new Promise<typeof ABANDONED>((resolve) => {
      abandon = () => resolve(ABANDONED);
    });
    this.switchTickets.set(windowId, { seq, abandon });
    return {
      id: `${windowId}:${seq}:${randomUUID()}`,
      isCurrent: () => this.switchTickets.get(windowId)?.seq === seq,
      abandoned,
    };
  }

  /** Forget a window's binding, switch tickets and pending switch when it closes. */
  private watchClosing(windowId: number): void {
    if (this.watchedWindows.has(windowId)) return;
    this.watchedWindows.add(windowId);
    this.options.windows.watchWindow(windowId, () => {
      this.watchedWindows.delete(windowId);
      this.switchTickets.get(windowId)?.abandon();
      this.switchTickets.delete(windowId);
      this.pendingSwitches.delete(windowId);
      this.committedSwitches.delete(windowId);
      this.options.bindings.release(windowId);
    });
  }

  /** Tell a window's views where its switch is, and remember it for one that asks. */
  private publishPendingSwitch(windowId: number, pending: PendingHostSwitch | null): void {
    if (pending) this.pendingSwitches.set(windowId, pending);
    else this.pendingSwitches.delete(windowId);
    // Telling the views is a courtesy: it must never be what fails the switch.
    try {
      this.options.windows.notifyWindow?.(windowId, { type: "switch-pending", pending });
    } catch (error) {
      console.warn("[RemoteHosts] Couldn't tell a window about its pending switch:", error);
    }
  }

  /** A window's binding and view change one switch at a time, in the order requests were made. */
  private inSwitchTurn<T>(windowId: number, task: () => Promise<T>): Promise<T> {
    const run = (this.switchChains.get(windowId) ?? Promise.resolve()).then(task, task);
    const settled = run.then(
      () => undefined,
      () => undefined
    );
    this.switchChains.set(windowId, settled);
    void settled.then(() => {
      if (this.switchChains.get(windowId) === settled) this.switchChains.delete(windowId);
    });
    return run;
  }

  async dispose(): Promise<void> {
    for (const off of this.unsubscribe.splice(0)) off();
    // The router stays installed. This runs at quit while windows are still
    // open, and with no router a host view's last flushes (layout, drafts)
    // would run on this machine; with every connection gone they fail with
    // HOST_DISCONNECTED instead, and local views are untouched.
    await this.options.manager.disposeAll();
  }

  /** Kept across the connection's discard, so a later connection can resync them. */
  private rememberBoundViews(hostId: HostId): void {
    const views = this.options.manager.get(hostId)?.boundViews() ?? [];
    this.detached.remember(hostId, views);
  }

  hostName(hostId: HostId): string | null {
    return this.options.registry.get(hostId)?.name ?? null;
  }

  /** Whether the view's host says a live Daintree Assistant is pinned to it there. */
  viewHasLiveAssistant(webContentsId: number): boolean {
    const hostId = this.viewHost(webContentsId);
    if (isLocalHostId(hostId)) return false;
    return this.options.manager.get(hostId)?.hasLiveAssistant(webContentsId) === true;
  }

  /** Whether the view's host says an agent in its project is active there. */
  viewHasActiveAgent(webContentsId: number): boolean {
    const hostId = this.viewHost(webContentsId);
    if (isLocalHostId(hostId)) return false;
    return this.options.manager.get(hostId)?.hasActiveAgent(webContentsId) === true;
  }

  /** A view's host: a project view's is in its key, and a view with no project follows its window. */
  viewHost(webContentsId: number): HostId {
    const key = this.options.senders.projectKeyFor(webContentsId);
    if (key !== null) return parseHostScopedKey(key).hostId;
    const windowId = this.options.senders.windowIdFor(webContentsId);
    return windowId === null ? LOCAL_HOST_ID : this.options.bindings.get(windowId);
  }

  private ensureRouter(): void {
    if (this.routerInstalled) return;
    this.routerInstalled = true;
    this.options.installRouter(this.options.router);
    this.options.onFirstUse?.();
  }

  private windowOf(ctx: IpcContext): number | null {
    const window = ctx.senderWindow;
    if (window && !window.isDestroyed()) return window.id;
    return this.options.senders.windowIdFor(ctx.webContentsId);
  }

  /**
   * Wait for calls to reach the host, and keep waiting past the usual bound
   * while its Daintree is being started: giving up there reported a host
   * that was coming up as unreachable, and the switch needed another click.
   */
  private async whenReady(
    connection: { whenReady(timeoutMs: number): Promise<HostReadiness> },
    hostId: HostId,
    /** Told before each wait, so a caller can say whether Daintree is being started there. */
    onWait?: () => void
  ): Promise<HostReadiness> {
    const timeoutMs = this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    const deadline = Date.now() + STARTING_TIMEOUT_MS;
    onWait?.();
    let readiness = await connection.whenReady(timeoutMs);
    while (readiness === "timeout" && this.options.isStarting?.(hostId)) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      onWait?.();
      readiness = await connection.whenReady(Math.min(timeoutMs, left));
    }
    return readiness;
  }

  /** A project view's host is in its key; a view with no project follows its window. */
  private hostOfSender(ctx: IpcContext): HostId {
    const key = this.options.senders.projectKeyFor(ctx.webContentsId);
    if (key !== null) return parseHostScopedKey(key).hostId;
    const windowId = this.windowOf(ctx);
    return windowId === null ? LOCAL_HOST_ID : this.options.bindings.get(windowId);
  }
}

/** A lookup on the host that couldn't get an answer: the host being unreachable, not the project gone. */
function unreachableLookup(hostId: HostId, error: unknown): AppError {
  return new AppError({
    code: "HOST_DISCONNECTED",
    message: `Host ${hostId} could not answer a project lookup`,
    userMessage: "Couldn't reach this host. Check that it is on and try again.",
    cause: error instanceof Error ? error : undefined,
  });
}

function hostModeOff(hostName: string): AppError {
  return new AppError({
    code: "HOST_MODE_OFF",
    message: `Daintree isn't running in Host mode on ${hostName}`,
    userMessage: `Daintree isn't running in Host mode on ${hostName}. Set it up to work there.`,
  });
}

function versionMismatch(hostId: HostId): AppError {
  return new AppError({
    code: "HOST_VERSION_MISMATCH",
    message: `Host ${hostId} runs a different build`,
    userMessage: "This host runs a different Daintree build. Update it to connect.",
  });
}

export function localWindowHost(): WindowHostInfo {
  return {
    hostId: LOCAL_HOST_ID,
    descriptor: null,
    connection: { status: "local" },
    hostPlatform: process.platform as WindowHostInfo["hostPlatform"],
    hostHomeDir: os.homedir(),
    hostTmpDir: os.tmpdir(),
  };
}
