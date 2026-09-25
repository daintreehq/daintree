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
  RemoteHostsEvent,
  SwitchWindowHostPayload,
  UpdateHostPayload,
  WindowHostInfo,
} from "../../../shared/types/ipc/remoteHosts.js";
import type { IpcContext } from "../../ipc/types.js";
import type { RemoteRouter } from "../../ipc/endpoint.js";
import { AppError } from "../../utils/errorTypes.js";
import type { HostRegistry } from "./HostRegistry.js";
import type { RemoteHostManager } from "./RemoteHostManager.js";
import type { SenderLookup } from "./RemoteRouter.js";
import type { WindowHostBinding } from "./WindowHostBinding.js";

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
  private readonly unsubscribe: Array<() => void> = [];

  constructor(private readonly options: RemoteHostsClientOptions) {
    this.unsubscribe.push(
      options.registry.onChange(() =>
        this.options.emit({ type: "hosts-changed", hosts: this.list() })
      ),
      options.manager.onStateChange((hostId, connection) =>
        this.options.emit({ type: "connection-changed", hostId, connection })
      )
    );
  }

  list(): HostListEntry[] {
    return this.options.registry.list().map((descriptor) => ({
      descriptor,
      connection: this.options.manager.connectionState(descriptor.id),
      summary: null,
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
      await this.options.manager.disconnect(after.id);
      this.options.manager.connect(after.id);
    }
    return after;
  }

  async forget(payload: { hostId: string }): Promise<void> {
    const hostId = hostIdOf(payload);
    this.options.registry.require(hostId);
    await this.options.manager.disconnect(hostId);
    for (const windowId of this.options.bindings.windowsOn(hostId)) {
      this.options.bindings.set(windowId, LOCAL_HOST_ID);
    }
    this.options.registry.forget(hostId);
  }

  connect(payload: { hostId: string }): HostConnectionState {
    const hostId = hostIdOf(payload);
    this.ensureRouter();
    return this.options.manager.connect(hostId).state();
  }

  async disconnect(payload: { hostId: string }): Promise<void> {
    await this.options.manager.disconnect(hostIdOf(payload));
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

  async switchWindowHost(ctx: IpcContext, payload: SwitchWindowHostPayload): Promise<void> {
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

    const remote = !isLocalHostId(hostId);
    let projectPath: string | null = null;
    if (remote) {
      this.options.registry.require(hostId);
      this.ensureRouter();
      const connection = this.options.manager.connect(hostId);
      if (connection.linkState.status === "version-mismatch") throw versionMismatch(hostId);
      if (projectId !== undefined) {
        // A cold switch dials the host now. The view is created only once the
        // link is up and the host has named the project's path: a view made
        // before that would open with no path and its first calls would fail.
        const readiness = await connection.whenReady(
          this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
        );
        if (readiness === "version-mismatch") throw versionMismatch(hostId);
        if (readiness !== "ready") {
          throw new AppError({
            code: "HOST_DISCONNECTED",
            message: `Host ${hostId} did not connect (${readiness})`,
            userMessage: "Couldn't reach this host. Check that it is on and try again.",
          });
        }
        const description = await connection.describeProject(projectId).catch(() => null);
        if (!description?.path) {
          throw new AppError({
            code: "NOT_FOUND",
            message: `Host ${hostId} has no project ${projectId}`,
            userMessage: "This project isn't on that host.",
          });
        }
        projectPath = description.path;
      }
    }

    const windowId = newWindow ? await this.options.windows.openWindow() : this.windowOf(ctx);
    if (windowId === null) {
      throw new AppError({ code: "INTERNAL", message: "No window to attach to the host" });
    }
    this.options.bindings.set(windowId, remote ? hostId : LOCAL_HOST_ID);
    if (!this.watchedWindows.has(windowId)) {
      this.watchedWindows.add(windowId);
      this.options.windows.watchWindow(windowId, () => {
        this.watchedWindows.delete(windowId);
        this.options.bindings.release(windowId);
      });
    }

    if (projectId === undefined) return;
    if (!remote) {
      await this.options.windows.openLocalProject(windowId, projectId);
      return;
    }
    // Set above for every remote switch that names a project; never open a pathless view.
    if (projectPath === null) throw new AppError({ code: "INTERNAL", message: "No host path" });
    await this.options.windows.openRemoteProject(windowId, hostId, projectId, projectPath);
  }

  async dispose(): Promise<void> {
    for (const off of this.unsubscribe.splice(0)) off();
    if (this.routerInstalled) this.options.installRouter(null);
    this.routerInstalled = false;
    await this.options.manager.disposeAll();
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
