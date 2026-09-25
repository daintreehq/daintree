import os from "node:os";
import { app } from "electron";
import { ensureWorkspaceClient, isWorkspaceClientStarting } from "../boot/hostServices.js";
import {
  getFleetSnapshotService,
  getProjectStatsService,
} from "../ipc/handlers/projectCrud/index.js";
import { setRemoteBoundViewFilter } from "../ipc/utils.js";
import { getDriveLeaseService } from "../services/DriveLeaseService.js";
import { setMcpDriveTargetResolver } from "../services/mcp-server/driveTarget.js";
import { releaseWindowTerminalPort, setRemoteViewHooks } from "../window/portDistribution.js";
import { getPtyClient } from "../window/serviceRefs.js";
import { resolveLiveWebContents } from "../window/webContentsRegistry.js";
import { getWindowRegistry } from "../window/windowRef.js";
import { initRemoteHostsClient } from "./client/initClient.js";
import { installViewReverseRequests } from "./client/viewRequests.js";
import { getLocalHandshakeInfo } from "./handshakeInfo.js";
import { HostServer } from "./host/HostServer.js";
import { hostSocketLocation, type HostSocketLocation } from "./host/hostSocketPath.js";
import { initRemoteHostsHost } from "./host/initHost.js";
import type { RemoteViewEndpoint } from "./host/RemoteViewEndpoint.js";
import {
  acceptLocalPushForRemoteView,
  admitHybridHostLegs,
  installHybridSplits,
  ViewVisibilityReporter,
} from "./hybrid/index.js";
import { Lane } from "./link/frames.js";
import { ControlKind } from "./link/messages.js";
import type { LinkSession } from "./link/session.js";
import { registerRemoteService } from "./runtime.js";
import {
  attachClientTerminalRelay,
  detachClientTerminalRelayFor,
  disposeAllClientTerminalRelays,
  installClientTerminalPortOverride,
} from "./terminal/clientAttach.js";
import {
  attachTerminalBridge,
  detachTerminalBridge,
  disposeAllTerminalBridges,
} from "./terminal/hostAttach.js";
import {
  attachClientWorktreeRelay,
  attachWorktreePortBridge,
  detachClientWorktreeRelayFor,
  detachWorktreePortBridge,
  disposeAllClientWorktreeRelays,
  installClientWorktreePortOverride,
  redeliverClientWorktreePort,
} from "./worktreePort/attach.js";

// The composition root owns window creation; it installs the opener through this module.
export { setRemoteHostsWindowOpener } from "./client/initClient.js";

declare module "./runtime.js" {
  interface RemoteServices {
    hostServer: HostServer;
  }
}

/**
 * Entry point for everything Remote Hosts starts in the main process. Loaded
 * only through `if (__DAINTREE_REMOTE_HOSTS__) { await import("./remote/boot.js") }`
 * so Windows builds carry none of it. Services register themselves into
 * `./runtime.ts`; core code reaches them from there.
 *
 * The client side always starts but dials nothing until a window or the user
 * asks for a host; its per-view stream wiring (port overrides, relays) is
 * installed only on that first use. The host side (a listening socket) starts
 * only in Host mode.
 */

export interface StartRemoteHostsOptions {
  /** Host mode is on for this launch: listen for remote Shells. */
  hostMode: boolean;
}

type Teardown = () => void | Promise<void>;

/** Run in reverse on stop, so each piece goes before what it was built on. */
let teardowns: Teardown[] = [];
let started = false;

function hostLocation(): HostSocketLocation {
  if (process.platform === "darwin") {
    return hostSocketLocation({ platform: "darwin", userDataDir: app.getPath("userData") });
  }
  return hostSocketLocation({
    platform: "linux",
    uid: process.getuid!(),
    // Dev and packaged builds must not fight over one socket.
    dirName: app.isPackaged ? "daintree" : "daintree-dev",
  });
}

function startClient(): void {
  let hostForView: (webContentsId: number) => string | null = () => null;
  let activated = false;
  // Tells each host which of its views a window is actually showing, so its
  // close and background guards protect exactly those projects.
  const visibility = new ViewVisibilityReporter();

  // Everything a remote view needs beyond the host list, installed the first
  // time a host is actually used so a user who never adds one runs none of it.
  const activate = (): void => {
    if (activated || !started) return;
    activated = true;
    teardowns.push(installClientTerminalPortOverride(hostForView));
    teardowns.push(installClientWorktreePortOverride(hostForView));
    teardowns.push(installHybridSplits({ router: client.router }));
    // This machine's agents, terminals and projects are not a remote view's.
    teardowns.push(
      setRemoteBoundViewFilter(
        (webContentsId, channel, args) =>
          hostForView(webContentsId) === null || acceptLocalPushForRemoteView(channel, args)
      )
    );
    teardowns.push(
      setRemoteViewHooks({
        isRemoteView: (wc) => hostForView(wc.id) !== null,
        redeliverWorktreePort: (wc) => redeliverClientWorktreePort(wc),
      })
    );
    // Relays are keyed by view and checked against its host, so re-attaching
    // on a resume moves the view's streams onto the new session and replays
    // what it missed, while a view that has since moved host gets none.
    teardowns.push(
      client.onEndpointOpened((hostId, { session, webContentsId, endpointId }) => {
        if (hostForView(webContentsId) !== hostId) return;
        const wc = resolveLiveWebContents(webContentsId);
        if (!wc) return;
        visibility.noteEndpointOpened({ session, webContentsId, endpointId });
        attachClientTerminalRelay(session, wc, endpointId, hostId);
        attachClientWorktreeRelay(session, wc, endpointId, hostId);
      })
    );
    teardowns.push(
      client.onEndpointClosed((hostId, { webContentsId, endpointId }) => {
        visibility.noteEndpointClosed(webContentsId, endpointId);
        detachClientTerminalRelayFor(webContentsId, hostId, endpointId);
        detachClientWorktreeRelayFor(webContentsId, hostId, endpointId);
      })
    );
    // Runs before the overrides are uninstalled (teardowns run in reverse).
    teardowns.push(() => {
      disposeAllClientTerminalRelays();
      disposeAllClientWorktreeRelays();
    });
  };

  const client = initRemoteHostsClient({
    onFirstUse: activate,
    onRemoteViewActivated: (windowId, wc, isNew) => {
      // Showing a remote view retires the window's local terminal pair, as a
      // local switch would by replacing it. A new view gets its relayed ports
      // on load; a cached one kept its terminal port but lost its worktree
      // port when it was parked.
      const ctx = getWindowRegistry()?.getByWindowId(windowId);
      if (ctx) releaseWindowTerminalPort(ctx, getPtyClient());
      if (!isNew) redeliverClientWorktreePort(wc);
      visibility.noteViewActivated(windowId, wc.id);
    },
  });
  hostForView = client.hostForView;
  teardowns.push(() => client.dispose());
  // Answered only once a session exists, so registering costs nothing until then.
  teardowns.push(installViewReverseRequests());
}

function attachHostStreams(session: LinkSession, endpoint: RemoteViewEndpoint): void {
  attachTerminalBridge(session, endpoint);
  attachWorktreePortBridge(session, endpoint);
}

function replaySnapshots(endpoint: RemoteViewEndpoint): void {
  // What a local view gets on onViewReady; a remote view has no such hook.
  getProjectStatsService()?.pushSnapshotToEndpoint(endpoint);
  getFleetSnapshotService()?.pushSnapshotToEndpoint(endpoint);
  void import("../services/runHistory/runHistoryService.js")
    .then((m) => m.pushRunHistorySnapshotToEndpoint(endpoint))
    .catch((error: unknown) => {
      console.warn("[RemoteHosts] Run history snapshot for a remote view failed:", error);
    });
}

async function startHost(): Promise<void> {
  const server = new HostServer({
    location: hostLocation(),
    handshake: getLocalHandshakeInfo(),
    hostName: os.hostname(),
  });
  teardowns.push(() => server.close());
  teardowns.push(registerRemoteService("hostServer", server));

  // Must exist before the server's own listeners so SessionHost has bound the
  // new link (and closed expired endpoints) by the time ours run.
  const host = initRemoteHostsHost(server);
  teardowns.push(() => host.dispose());
  teardowns.push(() => disposeAllTerminalBridges());

  teardowns.push(admitHybridHostLegs());

  // MCP dispatch and the drive lease agree on who drives a project. Installing
  // the resolver is also what lets the host run actions with no frontend
  // attached: only Host mode does, so a plain local app routes as it always did.
  const lease = getDriveLeaseService();
  teardowns.push(
    setMcpDriveTargetResolver((projectId) => {
      const target = lease.getDriveTarget(projectId);
      if (target.kind === "live") return { state: "live", endpoint: target.endpoint };
      return target.kind === "vacant"
        ? { state: "vacant" }
        : { state: "unavailable", reason: "reserved" };
    })
  );
  // The lease's release grace starts when a holder's link drops, not when its
  // session finally expires, and a resume inside it keeps the lease.
  teardowns.push(
    host.sessionHost.onTransportChange((endpointIds, attached) =>
      lease.noteEndpointTransport(endpointIds, attached)
    )
  );

  const endpointsBySession = new Map<string, Map<string, RemoteViewEndpoint>>();
  const linksBySession = new Map<string, () => LinkSession | null>();

  teardowns.push(
    host.sessionHost.onEndpointOpened((endpoint, handle) => {
      lease.noteEndpointClient(endpoint.endpointId, handle.client);
      linksBySession.set(handle.sessionId, handle.link);
      let endpoints = endpointsBySession.get(handle.sessionId);
      if (!endpoints) {
        endpoints = new Map();
        endpointsBySession.set(handle.sessionId, endpoints);
      }
      endpoints.set(endpoint.endpointId, endpoint);
      endpoint.onClose(() => endpointsBySession.get(handle.sessionId)?.delete(endpoint.endpointId));

      const link = handle.link();
      if (link) attachHostStreams(link, endpoint);
      replaySnapshots(endpoint);
    })
  );

  // A resumed session is a new LinkSession under the same id; its endpoints
  // (and their stream rings) carry on and follow it.
  teardowns.push(
    server.onSession((ctx) => {
      if (!ctx.resumed) return;
      for (const endpoint of endpointsBySession.get(ctx.sessionId)?.values() ?? []) {
        if (!endpoint.isClosed()) attachHostStreams(ctx.session, endpoint);
      }
    })
  );

  teardowns.push(
    server.onSessionExpired(({ sessionId }) => {
      const endpoints = endpointsBySession.get(sessionId);
      endpointsBySession.delete(sessionId);
      linksBySession.delete(sessionId);
      for (const endpointId of endpoints?.keys() ?? []) {
        detachTerminalBridge(endpointId);
        detachWorktreePortBridge(endpointId);
      }
    })
  );

  // A Shell showing the project hears of every holder change, beside the
  // per-view drive-lease events its views get.
  teardowns.push(
    lease.onChange((state) => {
      for (const [sessionId, endpoints] of endpointsBySession) {
        const showsProject = [...endpoints.values()].some(
          (endpoint) => !endpoint.isClosed() && endpoint.projectId === state.projectId
        );
        if (!showsProject) continue;
        try {
          linksBySession
            .get(sessionId)?.()
            ?.post({ lane: Lane.CONTROL, kind: ControlKind.LEASE_CHANGED, body: state });
        } catch {
          // A closing link; its Shell resyncs on the way back.
        }
      }
    })
  );

  try {
    await server.listen();
    console.log("[RemoteHosts] Host mode listening");
  } catch (error) {
    // A stop during startup closes the server under listen(); that is not a failure.
    if (!started) return;
    throw error;
  }
}

export async function startRemoteHosts(options: StartRemoteHostsOptions): Promise<void> {
  if (started) return;
  started = true;
  // The worktree port override needs the broker, which exists only once the
  // workspace client has finished wiring. Both boot paths start it before
  // this runs; wait out one still in flight, but never start one here.
  if (isWorkspaceClientStarting()) {
    try {
      await ensureWorkspaceClient({});
    } catch (error) {
      console.warn("[RemoteHosts] Workspace client failed; remote worktree ports are off:", error);
    }
  }
  if (!started) return;
  startClient();
  if (options.hostMode) await startHost();
}

export async function stopRemoteHosts(): Promise<void> {
  started = false;
  const pending = teardowns;
  teardowns = [];
  for (const teardown of pending.reverse()) {
    try {
      await teardown();
    } catch (error) {
      console.error("[RemoteHosts] Teardown step failed:", error);
    }
  }
}
