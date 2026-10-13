import os from "node:os";
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
} from "../../../shared/types/remoteHosts.js";
import type {
  AddHostPayload,
  HostProjectSummary,
  RemoteHostsEvent,
  SwitchWindowHostPayload,
  SwitchWindowHostResult,
  UpdateHostPayload,
  WindowHostInfo,
} from "../../../shared/types/ipc/remoteHosts.js";
import type { IpcContext } from "../../ipc/types.js";
import type { RemoteRouter } from "../../ipc/endpoint.js";
import { AppError } from "../../utils/errorTypes.js";
import { rememberRemoteWorkspaceTitle } from "../../window/windowTitle.js";
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
  /** Show `(hostId, projectId)` in the window's project view manager. */
  openRemoteProject(
    windowId: number,
    hostId: HostId,
    projectId: string,
    projectPath: string
  ): Promise<void>;
  openLocalProject(windowId: number, projectId: string): Promise<void>;
  /**
   * The local project to return a window to when it switches back to this
   * machine without naming one: the last this window showed, else the one
   * most recently opened here. Null when there is none.
   */
  lastLocalProjectId(windowId: number | null): string | null;
  /** This window's own most recent project on a host, which a plain switch there returns to. */
  lastProjectOnHost?(windowId: number | null, hostId: HostId): string | null;
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
   * Hand a request for one of this machine's projects to the window that has
   * it, as a local open does: brought forward, or shown again by that window's
   * own renderer when it holds the project in its cache. Answers that window,
   * or null when no other window has it.
   */
  redirectToLocalOwner?(projectId: string, exceptWindowId: number | null): number | null;
  /** Bring a window forward with its project view focused. */
  revealWindow?(windowId: number): void;
  /** Call `onClosed` once when the window closes. */
  watchWindow(windowId: number, onClosed: () => void): void;
  /**
   * Put a fresh window on this machine (its project picker) where `windowId`
   * is, and close that one: for a window whose host is going away with no
   * project of this machine's to return to, since a view's host is fixed.
   */
  replaceWithLocalWindow?(windowId: number): Promise<void>;
  /**
   * Tell a window's view, if it is up, that it has a host's project list to
   * offer ({@link RemoteHostsClient.takeProjectOffer}). A view still loading
   * asks once it can show the list.
   */
  offerHostProjects?(windowId: number): void;
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

function invalid(message: string): AppError {
  return new AppError({ code: "VALIDATION", message });
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
  private readonly switchSeq = new Map<number, number>();
  private readonly switchChains = new Map<number, Promise<void>>();
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
      options.registry.onChange(() =>
        this.options.emit({ type: "hosts-changed", hosts: this.list() })
      ),
      options.manager.onStateChange((hostId, connection) => {
        this.options.emit({ type: "connection-changed", hostId, connection });
        this.detached.onConnectionState(hostId, connection);
      })
    );
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
    if (payload.connection !== undefined) {
      const next = parseHostConnection(payload.connection);
      if (next && !sameHostConnection(next, before.connection)) {
        this.refuseWhileInstalling(before, "Its SSH target can change");
      }
    }
    const after = this.options.registry.update(payload);
    if (
      !sameHostConnection(after.connection, before.connection) &&
      this.options.manager.get(after.id)
    ) {
      // The link was built for the old target; dial the new one.
      this.rememberBoundViews(after.id);
      await this.options.manager.disconnect(after.id);
      this.options.manager.connect(after.id);
    }
    return after;
  }

  async forget(payload: { hostId: string }): Promise<void> {
    const hostId = hostIdOf(payload);
    const descriptor = this.options.registry.require(hostId);
    this.refuseWhileInstalling(descriptor, "It can be removed");
    // Windows on the host come back to this machine first, binding and view
    // together, as the removal promises: only rebinding left the host's view
    // on screen with nothing behind it and no host chip to leave by. A window
    // the person moved elsewhere meanwhile is left where they put it.
    const waitMs = this.options.forgetSwitchWaitMs ?? DEFAULT_FORGET_SWITCH_WAIT_MS;
    await Promise.all(
      [...this.options.bindings.windowsOn(hostId)].map(async (windowId) => {
        const projectId = this.options.windows.lastLocalProjectId(windowId);
        // Nothing here to show: a fresh window on this machine's picker takes its place.
        const replace = () =>
          (this.options.windows.replaceWithLocalWindow?.(windowId) ?? Promise.resolve()).catch(
            (error: unknown) => {
              console.warn("[RemoteHosts] Couldn't replace a forgotten host's window:", error);
            }
          );
        const moved =
          projectId === null
            ? replace()
            : this.switchWindow(
                windowId,
                { hostId: LOCAL_HOST_ID, newWindow: false, projectId },
                () => this.options.bindings.get(windowId) === hostId
              ).then(
                // That project went to another window meanwhile: still nothing here to show.
                (result) =>
                  result.outcome === "focused-elsewhere" &&
                  this.options.bindings.get(windowId) === hostId
                    ? replace()
                    : undefined,
                (error: unknown) => {
                  console.warn(
                    "[RemoteHosts] Couldn't bring a window back from a forgotten host:",
                    error
                  );
                }
              );
        let timer: ReturnType<typeof setTimeout> | undefined;
        const waited = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, waitMs);
          timer.unref?.();
        });
        await Promise.race([moved, waited]);
        clearTimeout(timer);
      })
    );
    await this.options.manager.disconnect(hostId);
    this.detached.forget(hostId);
    for (const windowId of this.options.bindings.windowsOn(hostId)) {
      this.options.bindings.set(windowId, LOCAL_HOST_ID);
    }
    for (const [windowId, offered] of [...this.projectOffers]) {
      if (offered === hostId) this.projectOffers.delete(windowId);
    }
    this.options.registry.forget(hostId);
    await this.options.onForget?.(descriptor).catch((error: unknown) => {
      console.warn("[RemoteHosts] Cleanup after forgetting a host failed:", error);
    });
  }

  private refuseWhileInstalling(descriptor: HostDescriptor, then: string): void {
    if (!this.options.isInstalling?.(descriptor.connection)) return;
    const message = `Daintree is being installed on ${descriptor.name}. ${then} once that finishes.`;
    throw new AppError({ code: "VALIDATION", message, userMessage: message });
  }

  connect(payload: { hostId: string }): HostConnectionState {
    const hostId = hostIdOf(payload);
    this.ensureRouter();
    return this.options.manager.connect(hostId).state();
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
    stillWanted?: () => boolean,
    /** Set when this window was chosen as the project's owner: it takes the project without looking for another. */
    asOwner = false
  ): Promise<SwitchWindowHostResult> {
    const hostId = hostIdOf(payload);
    const newWindow = payload.newWindow === true;
    let projectId = payload.projectId;
    if (
      projectId !== undefined &&
      (typeof projectId !== "string" ||
        projectId.length === 0 ||
        projectId.length > MAX_PROJECT_ID_LENGTH)
    ) {
      throw invalid("projectId must be a non-empty string");
    }

    const remote = !isLocalHostId(hostId);
    if (remote) this.options.registry.require(hostId);
    const sourceWindowId = newWindow ? null : askingWindowId;
    // The latest request for a window wins: one still waiting on its host when
    // a newer one arrives resolves as superseded and never moves the window.
    const ticket = sourceWindowId === null ? null : this.takeSwitchTicket(sourceWindowId);
    const superseded = (): SwitchWindowHostResult | null =>
      (ticket !== null && !ticket.isCurrent()) || (stillWanted !== undefined && !stillWanted())
        ? { outcome: "superseded", hostId }
        : null;
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
      const readiness = await this.whenReady(connection, hostId);
      const stale = superseded();
      if (stale) return stale;
      if (readiness === "version-mismatch") throw versionMismatch(hostId);
      if (readiness === "host-mode-off")
        throw hostModeOff(this.options.registry.get(hostId)?.name ?? hostId);
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
        // Where this window last was on the host first; the host's memory of
        // this machine is the fallback, then its project picker.
        const windowLast = this.options.windows.lastProjectOnHost?.(sourceWindowId, hostId) ?? null;
        const remembered = windowLast
          ? await connection.describeProject(windowLast).catch(() => null)
          : null;
        const last = remembered?.path
          ? { projectId: windowLast!, path: remembered.path, name: remembered.name }
          : await connection.lastActiveProject().catch(() => null);
        const staleLast = superseded();
        if (staleLast) return staleLast;
        if (last?.path) {
          projectId = last.projectId;
          projectPath = last.path;
          projectName = last.name;
        }
      } else {
        const description = await connection.describeProject(projectId).catch(() => null);
        const staleLookup = superseded();
        if (staleLookup) return staleLookup;
        if (!description?.path) {
          throw new AppError({
            code: "NOT_FOUND",
            message: `Host ${hostId} has no project ${projectId}`,
            userMessage: "This project isn't on that host.",
          });
        }
        projectPath = description.path;
        projectName = description.name;
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
    // second endpoint, the two claiming the lease from each other). The window
    // that has it comes forward instead.
    if (projectId !== undefined && !asOwner) {
      const redirected = await this.redirectToOwner(hostId, projectId, sourceWindowId, superseded);
      if (redirected) return redirected;
    }

    const windowId = newWindow ? await this.options.windows.openWindow() : sourceWindowId;
    if (windowId === null) {
      throw new AppError({ code: "INTERNAL", message: "No window to attach to the host" });
    }
    const targetProjectId = projectId;
    const targetPath = projectPath;
    let releaseClaim: () => void = () => {};
    const switching = this.inSwitchTurn(windowId, async (): Promise<SwitchWindowHostResult> => {
      // Checked again in turn: a newer request may have arrived while this
      // one waited behind the window's previous switch.
      const late = superseded();
      if (late) return late;
      // Only a new window reaches here without a project. It stays on this
      // machine and offers the host's project list: binding it with no view of
      // the host's behind it made a window whose calls went to the host while
      // its chip, copy and pickers all said This Mac.
      if (targetProjectId === undefined) {
        this.projectOffers.set(windowId, hostId);
        this.options.windows.watchWindow(windowId, () => this.projectOffers.delete(windowId));
        this.options.windows.offerHostProjects?.(windowId);
        return { outcome: "window-opened", hostId };
      }
      // Asked again here, and the project claimed for this window in the same
      // tick: another request may have taken it while this one waited, and
      // one arriving now finds this window instead of building a second view.
      // Claimed only now, past the last cancellation check, since a window's
      // own claim reads as an open of the person's in flight there.
      if (!asOwner) {
        const owner = isLocalHostId(hostId)
          ? (this.options.windows.redirectToLocalOwner?.(targetProjectId, windowId) ?? null)
          : (this.options.windows.projectOwner?.(hostId, targetProjectId, windowId)?.windowId ??
            null);
        if (owner !== null) {
          if (remote) this.options.windows.revealWindow?.(owner);
          return {
            outcome: "focused-elsewhere",
            hostId,
            projectId: targetProjectId,
            targetWindowId: owner,
          };
        }
      }
      releaseClaim =
        this.options.windows.claimProject?.(hostId, targetProjectId, windowId) ?? releaseClaim;
      const previousHost = this.options.bindings.get(windowId);
      const nextHost = remote ? hostId : LOCAL_HOST_ID;
      this.options.bindings.set(windowId, nextHost);
      if (!this.watchedWindows.has(windowId)) {
        this.watchedWindows.add(windowId);
        this.options.windows.watchWindow(windowId, () => {
          this.watchedWindows.delete(windowId);
          this.switchSeq.delete(windowId);
          this.options.bindings.release(windowId);
        });
      }

      try {
        if (!remote) {
          await this.options.windows.openLocalProject(windowId, targetProjectId);
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
        await this.options.windows.openRemoteProject(windowId, hostId, targetProjectId, targetPath);
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

  /**
   * Another window has the project: it comes forward instead of this one
   * opening a second view. One holding it only in its cache shows it again
   * first, a host's through a switch of that window (which doesn't look for
   * another owner, so two cached copies can't pass the request back and
   * forth), this machine's through that window's own renderer, as a local open
   * does. Null when no other window has it.
   */
  private async redirectToOwner(
    hostId: HostId,
    projectId: string,
    sourceWindowId: number | null,
    superseded: () => SwitchWindowHostResult | null
  ): Promise<SwitchWindowHostResult | null> {
    if (isLocalHostId(hostId)) {
      const target = this.options.windows.redirectToLocalOwner?.(projectId, sourceWindowId) ?? null;
      return target === null
        ? null
        : { outcome: "focused-elsewhere", hostId, projectId, targetWindowId: target };
    }
    const owner = this.options.windows.projectOwner?.(hostId, projectId, sourceWindowId);
    if (!owner) return null;
    if (!owner.showing) {
      const shown = await this.switchWindow(
        owner.windowId,
        { hostId, newWindow: false, projectId },
        undefined,
        true
      );
      if (shown.outcome !== "switched") return shown;
    }
    // The person may have asked this window for something else meanwhile.
    const stale = superseded();
    if (stale) return stale;
    this.options.windows.revealWindow?.(owner.windowId);
    return { outcome: "focused-elsewhere", hostId, projectId, targetWindowId: owner.windowId };
  }

  /** A window's newest switch request; any earlier one still in flight is superseded. */
  private takeSwitchTicket(windowId: number): { isCurrent(): boolean } {
    const seq = (this.switchSeq.get(windowId) ?? 0) + 1;
    this.switchSeq.set(windowId, seq);
    return { isCurrent: () => this.switchSeq.get(windowId) === seq };
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
    if (this.routerInstalled) this.options.installRouter(null);
    this.routerInstalled = false;
    await this.options.manager.disposeAll();
  }

  /** Kept across the connection's discard, so a later connection can resync them. */
  private rememberBoundViews(hostId: HostId): void {
    const views = this.options.manager.get(hostId)?.boundViews() ?? [];
    this.detached.remember(hostId, views);
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
    hostId: HostId
  ): Promise<HostReadiness> {
    const timeoutMs = this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    const deadline = Date.now() + STARTING_TIMEOUT_MS;
    let readiness = await connection.whenReady(timeoutMs);
    while (readiness === "timeout" && this.options.isStarting?.(hostId)) {
      const left = deadline - Date.now();
      if (left <= 0) break;
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
