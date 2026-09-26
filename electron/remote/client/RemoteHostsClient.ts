import os from "node:os";
import {
  LOCAL_HOST_ID,
  isLocalHostId,
  parseHostScopedKey,
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
import { getRemoteService } from "../runtime.js";
import type { HostRegistry } from "./HostRegistry.js";
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
  /** Call `onClosed` once when the window closes. */
  watchWindow(windowId: number, onClosed: () => void): void;
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
  /** After a host is forgotten: drop what this machine kept for it (SSH master, cached bundles). */
  onForget?: (descriptor: HostDescriptor) => Promise<void>;
}

const DEFAULT_READY_TIMEOUT_MS = 20_000;

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
        const readiness = await connection.whenReady(
          this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
        );
        return readiness === "ready";
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
    const after = this.options.registry.update(payload);
    if (after.sshTarget !== before.sshTarget && this.options.manager.get(after.id)) {
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
    await this.options.manager.disconnect(hostId);
    this.detached.forget(hostId);
    for (const windowId of this.options.bindings.windowsOn(hostId)) {
      this.options.bindings.set(windowId, LOCAL_HOST_ID);
    }
    this.options.registry.forget(hostId);
    await this.options.onForget?.(descriptor).catch((error: unknown) => {
      console.warn("[RemoteHosts] Cleanup after forgetting a host failed:", error);
    });
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

  /**
   * Put a window (or a new one) on a host. With a project named, that project
   * opens there. Without one the window returns to the project it last showed
   * on that host, as the host remembers it for this machine (or, for this
   * machine, as its own history does); when there is none, nothing moves and
   * the caller is told to offer that host's project list instead. A window
   * is only ever rebound together with the view it shows, so its binding and
   * its view never name different hosts.
   */
  async switchWindowHost(
    ctx: IpcContext,
    payload: SwitchWindowHostPayload
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
    const sourceWindowId = newWindow ? null : this.windowOf(ctx);
    // The latest request for a window wins: one still waiting on its host when
    // a newer one arrives resolves as superseded and never moves the window.
    const ticket = sourceWindowId === null ? null : this.takeSwitchTicket(sourceWindowId);
    const superseded = (): SwitchWindowHostResult | null =>
      ticket !== null && !ticket.isCurrent() ? { outcome: "superseded", hostId } : null;
    let projectPath: string | null = null;
    let connection: ReturnType<RemoteHostManager["connect"]> | null = null;
    if (remote) {
      this.ensureRouter();
      connection = this.options.manager.connect(hostId);
      if (connection.linkState.status === "version-mismatch") throw versionMismatch(hostId);
      // A cold switch dials the host now. The view is created only once the
      // link is up and the host has named the project's path: a view made
      // before that would open with no path and its first calls would fail.
      const readiness = await connection.whenReady(
        this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
      );
      const stale = superseded();
      if (stale) return stale;
      if (readiness === "version-mismatch") throw versionMismatch(hostId);
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
        const last = await connection.lastActiveProject().catch(() => null);
        if (last?.path) {
          projectId = last.projectId;
          projectPath = last.path;
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
      }
    } else if (projectId === undefined) {
      projectId = this.options.windows.lastLocalProjectId(sourceWindowId) ?? undefined;
    }

    const stale = superseded();
    if (stale) return stale;
    // Nothing to return to, and no new window to show the host's project list
    // in: leave this window as it is and let the caller offer the list.
    if (projectId === undefined && !newWindow) return { outcome: "choose-project", hostId };

    const windowId = newWindow ? await this.options.windows.openWindow() : sourceWindowId;
    if (windowId === null) {
      throw new AppError({ code: "INTERNAL", message: "No window to attach to the host" });
    }
    const targetProjectId = projectId;
    const targetPath = projectPath;
    return this.inSwitchTurn(windowId, async (): Promise<SwitchWindowHostResult> => {
      // Checked again in turn: a newer request may have arrived while this
      // one waited behind the window's previous switch.
      const late = superseded();
      if (late) return late;
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

      // Only a new window reaches here without a project: its unbound view
      // follows the binding and lists the host's projects.
      if (targetProjectId === undefined) return { outcome: "window-opened", hostId };
      try {
        if (!remote) {
          await this.options.windows.openLocalProject(windowId, targetProjectId);
          return { outcome: "switched", hostId: LOCAL_HOST_ID, projectId: targetProjectId };
        }
        // Set above for every remote switch that names a project; never open a pathless view.
        if (targetPath === null) {
          throw new AppError({ code: "INTERNAL", message: "No host path" });
        }
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

  private viewHost(webContentsId: number): HostId {
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

  /** A project view's host is in its key; a view with no project follows its window. */
  private hostOfSender(ctx: IpcContext): HostId {
    const key = this.options.senders.projectKeyFor(ctx.webContentsId);
    if (key !== null) return parseHostScopedKey(key).hostId;
    const windowId = this.windowOf(ctx);
    return windowId === null ? LOCAL_HOST_ID : this.options.bindings.get(windowId);
  }
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
