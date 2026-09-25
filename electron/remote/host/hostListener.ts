import os from "node:os";
import { app } from "electron";
import {
  getFleetSnapshotService,
  getProjectStatsService,
} from "../../ipc/handlers/projectCrud/index.js";
import { getDriveLeaseService } from "../../services/DriveLeaseService.js";
import { setMcpDriveTargetResolver } from "../../services/mcp-server/driveTarget.js";
import type { AttachedClientInfo } from "../../../shared/types/ipc/hostMode.js";
import { attachHostFiles, installHostFileService } from "../files/hostInstall.js";
import { attachHostUploads, installHostUploadService } from "../files/uploadHostInstall.js";
import { getLocalHandshakeInfo } from "../handshakeInfo.js";
import { admitHybridHostLegs } from "../hybrid/index.js";
import { Lane } from "../link/frames.js";
import { ControlKind, type LinkClientInfo } from "../link/messages.js";
import type { LinkSession } from "../link/session.js";
import { attachHostPluginAssets, installPluginHost } from "../plugins/install.js";
import { installHostPortService } from "../ports/hostPorts.js";
import { installProjectsHost } from "../projects/hostInstall.js";
import { registerRemoteService } from "../runtime.js";
import {
  attachTerminalBridge,
  detachTerminalBridge,
  disposeAllTerminalBridges,
} from "../terminal/hostAttach.js";
import { attachWorktreePortBridge, detachWorktreePortBridge } from "../worktreePort/attach.js";
import { HostServer } from "./HostServer.js";
import { hostSocketLocation, type HostSocketLocation } from "./hostSocketPath.js";
import { initRemoteHostsHost } from "./initHost.js";
import type { RemoteViewEndpoint } from "./RemoteViewEndpoint.js";

declare module "../runtime.js" {
  interface RemoteServices {
    hostServer: HostServer;
  }
}

/**
 * The listening half of Host mode: the socket, the session host that turns
 * attached Shells into endpoints, and the per-endpoint stream bridges. Started
 * at boot when Host mode is on, and by the Host mode switch at runtime;
 * stopping it closes the socket, drops every session and removes the
 * discovery file.
 */
export interface HostListener {
  readonly socketPath: string;
  isListening(): boolean;
  /** Shells attached right now, with the projects each currently drives. */
  attachedClients(): AttachedClientInfo[];
  /** Sessions or endpoints came or went, or a lease moved. */
  onChange(listener: () => void): () => void;
  stop(): Promise<void>;
}

export function hostLocation(): HostSocketLocation {
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

function attachHostStreams(session: LinkSession, endpoint: RemoteViewEndpoint): void {
  attachTerminalBridge(session, endpoint);
  attachWorktreePortBridge(session, endpoint);
  attachHostFiles(session, endpoint);
  attachHostUploads(session, endpoint);
  attachHostPluginAssets(session, endpoint);
}

function replaySnapshots(endpoint: RemoteViewEndpoint): void {
  // What a local view gets on onViewReady; a remote view has no such hook.
  getProjectStatsService()?.pushSnapshotToEndpoint(endpoint);
  getFleetSnapshotService()?.pushSnapshotToEndpoint(endpoint);
  void import("../../services/runHistory/runHistoryService.js")
    .then((m) => m.pushRunHistorySnapshotToEndpoint(endpoint))
    .catch((error: unknown) => {
      console.warn("[RemoteHosts] Run history snapshot for a remote view failed:", error);
    });
}

type Teardown = () => void | Promise<void>;

async function runTeardowns(teardowns: Teardown[]): Promise<void> {
  for (const teardown of teardowns.splice(0).reverse()) {
    try {
      await teardown();
    } catch (error) {
      console.error("[RemoteHosts] Host teardown step failed:", error);
    }
  }
}

/**
 * Build and start the listener. Aborting `signal` stops it, and a stop during
 * startup is not a failure: the start resolves with the stopped listener. A
 * failure anywhere in setup undoes whatever was already registered.
 */
export async function startHostListener(
  options: { signal?: AbortSignal; now?: () => number } = {}
): Promise<HostListener> {
  const teardowns: Teardown[] = [];
  try {
    return await buildHostListener(options, teardowns);
  } catch (error) {
    await runTeardowns(teardowns);
    throw error;
  }
}

async function buildHostListener(
  options: { signal?: AbortSignal; now?: () => number },
  teardowns: Teardown[]
): Promise<HostListener> {
  const now = options.now ?? Date.now;
  let stopped = false;
  let stopping: Promise<void> | null = null;
  const changeListeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of changeListeners) {
      try {
        listener();
      } catch {
        // One broken subscriber must not stop the others.
      }
    }
  };

  const location = hostLocation();
  const server = new HostServer({
    location,
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

  // Previews, downloads and host pickers for remote views; revoked with the listener.
  const files = installHostFileService();
  teardowns.push(() => files.dispose());
  // Files dropped, pasted or attached in remote windows, into the inbox or a project.
  const uploads = installHostUploadService();
  teardowns.push(() => uploads.dispose());
  // Port forwards and project moves are per session, not per endpoint.
  teardowns.push(installHostPortService(server));
  teardowns.push(installProjectsHost(server));
  // Plugin prompts go to the project's driving frontend; view bundles are
  // served per endpoint alongside its other streams.
  teardowns.push(installPluginHost());

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
  const clientsBySession = new Map<string, LinkClientInfo>();
  const connectedAtBySession = new Map<string, number>();

  teardowns.push(
    host.sessionHost.onEndpointOpened((endpoint, handle) => {
      lease.noteEndpointClient(endpoint.endpointId, handle.client);
      linksBySession.set(handle.sessionId, handle.link);
      if (handle.client) clientsBySession.set(handle.sessionId, handle.client);
      let endpoints = endpointsBySession.get(handle.sessionId);
      if (!endpoints) {
        endpoints = new Map();
        endpointsBySession.set(handle.sessionId, endpoints);
      }
      endpoints.set(endpoint.endpointId, endpoint);
      endpoint.onClose(() => {
        endpointsBySession.get(handle.sessionId)?.delete(endpoint.endpointId);
        notify();
      });

      const link = handle.link();
      if (link) attachHostStreams(link, endpoint);
      replaySnapshots(endpoint);
      notify();
    })
  );

  // A resumed session is a new LinkSession under the same id; its endpoints
  // (and their stream rings) carry on and follow it.
  teardowns.push(
    server.onSession((ctx) => {
      clientsBySession.set(ctx.sessionId, ctx.client);
      if (!connectedAtBySession.has(ctx.sessionId)) connectedAtBySession.set(ctx.sessionId, now());
      notify();
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
      clientsBySession.delete(sessionId);
      connectedAtBySession.delete(sessionId);
      for (const endpointId of endpoints?.keys() ?? []) {
        detachTerminalBridge(endpointId);
        detachWorktreePortBridge(endpointId);
      }
      notify();
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
      notify();
    })
  );

  const listener: HostListener = {
    socketPath: location.socketPath,
    isListening: () => !stopped && server.isListening,
    attachedClients() {
      // Only sessions attached now; a parked (resumable) one has no Shell behind it.
      const attached = new Set(server.sessions.map((ctx) => ctx.sessionId));
      const byClient = new Map<string, AttachedClientInfo>();
      for (const ctx of server.sessions) {
        const connectedAt = connectedAtBySession.get(ctx.sessionId) ?? now();
        const known = byClient.get(ctx.client.clientId);
        if (known) {
          known.connectedAt = Math.min(known.connectedAt, connectedAt);
          continue;
        }
        byClient.set(ctx.client.clientId, {
          clientId: ctx.client.clientId,
          clientName: ctx.client.clientName,
          connectedAt,
          drivingProjectIds: [],
        });
      }
      for (const [sessionId, endpoints] of endpointsBySession) {
        if (!attached.has(sessionId)) continue;
        const client = clientsBySession.get(sessionId);
        const info = client ? byClient.get(client.clientId) : undefined;
        if (!info) continue;
        for (const endpoint of endpoints.values()) {
          const projectId = endpoint.projectId;
          if (endpoint.isClosed() || !projectId) continue;
          if (lease.getHolder(projectId)?.clientId !== info.clientId) continue;
          if (!info.drivingProjectIds.includes(projectId)) info.drivingProjectIds.push(projectId);
        }
      }
      return [...byClient.values()];
    },
    onChange(fn) {
      changeListeners.add(fn);
      return () => changeListeners.delete(fn);
    },
    stop() {
      if (stopping) return stopping;
      stopped = true;
      stopping = runTeardowns(teardowns).then(() => changeListeners.clear());
      return stopping;
    },
  };

  if (options.signal) {
    if (options.signal.aborted) void listener.stop();
    else options.signal.addEventListener("abort", () => void listener.stop(), { once: true });
  }

  // A server closed before it listened would otherwise start afresh.
  if (stopped) return listener;
  try {
    await server.listen();
    console.log("[RemoteHosts] Host mode listening");
  } catch (error) {
    // A stop during startup closes the server under listen(); that is not a failure.
    if (stopped) return listener;
    await listener.stop();
    throw error;
  }
  return listener;
}
