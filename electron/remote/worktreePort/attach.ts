import type { WebContents } from "electron";
import type { HostId } from "../../../shared/types/remoteHosts.js";
import { getEndpointRegistry } from "../../ipc/endpointRegistry.js";
import { projectStore } from "../../services/ProjectStore.js";
import type { WorktreePortHost } from "../../services/WorktreePortBroker.js";
import { getWorkspaceClientRef, getWorktreePortBrokerRef } from "../../window/serviceRefs.js";
import { resolveLiveWebContents } from "../../window/webContentsRegistry.js";
import { WORKTREE_PORT_REDELIVER_METHOD } from "../../ipc/endpoint.js";
import { registerReverseRequestMethod } from "../client/reverseRequests.js";
import type { LinkSession } from "../link/session.js";
import type { RemoteStreamEndpoint } from "../terminal/hostAttach.js";
import { wrapMainPort } from "../terminal/ports.js";
import { WorktreePortClientRelay, WorktreePortHostBridge } from "./WorktreePortBridge.js";

/**
 * Production wiring for worktree ports over the link: on the host, a bridge
 * per remote endpoint connected to its project's workspace host through the
 * port broker; on the client, a relay per remote view that the broker treats
 * as that view's workspace host.
 */

const hostBridges = new Map<string, { bridge: WorktreePortHostBridge; cleanup: () => void }>();

/**
 * A remote endpoint usually opens before its project is resident on this
 * host (the Shell names it first, and the workspace host is started by the
 * project's activation), so a first attempt that finds no workspace host is
 * retried with backoff rather than abandoned.
 */
const OPEN_RETRY_INITIAL_MS = 250;
const OPEN_RETRY_MAX_MS = 5_000;
const OPEN_RETRY_ATTEMPTS = 40;

export interface WorktreePortBridgeOverrides {
  retryInitialMs?: number;
  retryMaxMs?: number;
  retryAttempts?: number;
}

export function attachWorktreePortBridge(
  session: LinkSession,
  endpoint: RemoteStreamEndpoint,
  overrides: WorktreePortBridgeOverrides = {}
): WorktreePortHostBridge {
  let entry = hostBridges.get(endpoint.endpointId);
  if (!entry) {
    const handle = endpoint.handle;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelRetry = () => {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
    };
    const tryOpen = (projectId: string): boolean => {
      const broker = getWorktreePortBrokerRef();
      if (!broker) return false;
      // Recorded before the host is looked for, so a Retry that brings the
      // project's host up can connect this endpoint without its next attempt.
      broker.expectEndpointPort(handle, (port) => bridge.setPort(wrapMainPort(port)));
      const projectPath = projectStore.getProjectById(projectId)?.path;
      const host = projectPath ? getWorkspaceClientRef()?.getHostForProject(projectPath) : null;
      if (!host) return false;
      return broker.connectEndpointPort(host, handle);
    };
    const bridge: WorktreePortHostBridge = new WorktreePortHostBridge({
      endpointId: endpoint.clientEndpointId,
      open: (projectId) => {
        cancelRetry();
        if (tryOpen(projectId)) return;
        let delay = overrides.retryInitialMs ?? OPEN_RETRY_INITIAL_MS;
        let attempts = overrides.retryAttempts ?? OPEN_RETRY_ATTEMPTS;
        const retry = () => {
          retryTimer = setTimeout(() => {
            retryTimer = null;
            if (tryOpen(projectId) || --attempts <= 0) return;
            delay = Math.min(delay * 2, overrides.retryMaxMs ?? OPEN_RETRY_MAX_MS);
            retry();
          }, delay);
          retryTimer.unref?.();
        };
        retry();
      },
      // The bridge releases before every reopen and on detach, so a pending
      // retry never outlives the project or session it was for.
      release: () => {
        cancelRetry();
        getWorktreePortBrokerRef()?.releaseEndpointPort(handle);
      },
      resolveProjectRoot: (projectId) => projectStore.getProjectById(projectId)?.path ?? null,
    });
    const closeSub = endpoint.onClose(() => detachWorktreePortBridge(endpoint.endpointId));
    const offChange = getEndpointRegistry().onChange(() => {
      if (!endpoint.isClosed()) bridge.setProject(endpoint.projectId);
    });
    entry = {
      bridge,
      cleanup: () => {
        cancelRetry();
        closeSub.dispose();
        offChange();
      },
    };
    hostBridges.set(endpoint.endpointId, entry);
  }
  entry.bridge.setProject(endpoint.projectId);
  entry.bridge.attach(session);
  return entry.bridge;
}

export function detachWorktreePortBridge(endpointId: string): void {
  const entry = hostBridges.get(endpointId);
  if (!entry) return;
  hostBridges.delete(endpointId);
  entry.cleanup();
  entry.bridge.dispose();
}

interface ClientEntry {
  relay: WorktreePortClientRelay;
  hostId: HostId;
  host: WorktreePortHost;
  cleanup: () => void;
}

const clientRelays = new Map<number, ClientEntry>();

export function attachClientWorktreeRelay(
  session: LinkSession,
  viewWebContents: WebContents,
  endpointId: string,
  hostId: HostId
): WorktreePortClientRelay {
  const wcId = viewWebContents.id;
  let entry = clientRelays.get(wcId);
  if (entry && (entry.relay.endpointId !== endpointId || entry.hostId !== hostId)) {
    detachClientWorktreeRelay(wcId);
    entry = undefined;
  }
  if (!entry) {
    const relay: WorktreePortClientRelay = new WorktreePortClientRelay({
      endpointId,
      deliver: () => {
        if (!viewWebContents.isDestroyed()) {
          getWorktreePortBrokerRef()?.brokerPort(host, viewWebContents, { force: true });
        }
      },
      close: () => getWorktreePortBrokerRef()?.closePortsForView(wcId),
    });
    // Stands in for the workspace host on the other machine: the broker posts
    // the view its end as usual and gives this relay the end it would have
    // transferred to a local host.
    const host: WorktreePortHost = {
      projectPath: `remote-endpoint:${hostId}:${endpointId}`,
      attachWorktreePort: (port) => {
        relay.setRendererPort(wrapMainPort(port));
        return true;
      },
    };
    const onDestroyed = () => detachClientWorktreeRelay(wcId);
    viewWebContents.once("destroyed", onDestroyed);
    entry = {
      relay,
      hostId,
      host,
      cleanup: () => viewWebContents.removeListener("destroyed", onDestroyed),
    };
    clientRelays.set(wcId, entry);
  }
  entry.relay.attach(session);
  return entry.relay;
}

export function detachClientWorktreeRelay(webContentsId: number): void {
  const entry = clientRelays.get(webContentsId);
  if (!entry) return;
  clientRelays.delete(webContentsId);
  entry.cleanup();
  entry.relay.dispose();
  getWorktreePortBrokerRef()?.closePortsForView(webContentsId);
}

/** Retire a view's relay only while it still belongs to this (host, endpoint). */
export function detachClientWorktreeRelayFor(
  webContentsId: number,
  hostId: HostId,
  endpointId: string
): void {
  const entry = clientRelays.get(webContentsId);
  if (entry?.hostId === hostId && entry.relay.endpointId === endpointId) {
    detachClientWorktreeRelay(webContentsId);
  }
}

export function disposeAllClientWorktreeRelays(): void {
  for (const webContentsId of [...clientRelays.keys()]) detachClientWorktreeRelay(webContentsId);
}

/**
 * Post a remote view a fresh relayed worktree port: after a reload (the old
 * document's port died with it) or a cached-view reactivation (caching closed
 * it). A view whose relay has no session yet gets one when it attaches.
 */
export function redeliverClientWorktreePort(viewWebContents: WebContents): void {
  const entry = clientRelays.get(viewWebContents.id);
  if (!entry?.relay.isAttached || viewWebContents.isDestroyed()) return;
  getWorktreePortBrokerRef()?.brokerPort(entry.host, viewWebContents, { force: true });
}

/**
 * Post a remote view a fresh relayed worktree port because its host asked
 * (after reloading the view's project), and answer whether the renderer
 * confirmed it within `timeoutMs`. False when the view has no attached relay
 * for that host: it gets its port when the relay attaches.
 */
export async function redeliverClientWorktreePortForHost(
  webContentsId: number,
  hostId: HostId,
  timeoutMs: number
): Promise<boolean> {
  const entry = clientRelays.get(webContentsId);
  const broker = getWorktreePortBrokerRef();
  const wc = resolveLiveWebContents(webContentsId);
  if (!entry || entry.hostId !== hostId || !entry.relay.isAttached || !broker || !wc) return false;
  if (!broker.brokerPort(entry.host, wc, { force: true })) return false;
  return broker.waitForConfirmation(webContentsId, timeoutMs);
}

/** The host waits 10 s for the view's receipt; the Shell answers a little inside that. */
const REDELIVER_CONFIRM_MS = 8_000;

/**
 * Shell side: answer a host that reloaded a view's project (worktree Retry)
 * by posting the view a fresh relayed port. Returns a teardown.
 */
export function installWorktreePortRedelivery(): () => void {
  return registerReverseRequestMethod(WORKTREE_PORT_REDELIVER_METHOD, ({ hostId, webContentsId }) =>
    redeliverClientWorktreePortForHost(webContentsId, hostId, REDELIVER_CONFIRM_MS)
  );
}

/** Refuses every port: a remote view whose relay is not up yet waits for it. */
const AWAITING_RELAY: WorktreePortHost = {
  projectPath: "remote-endpoint:awaiting-relay",
  attachWorktreePort: () => false,
};

/**
 * Make every broker path that (re)posts a view's worktree port follow the
 * view's authoritative host: its relay for a remote view, and for a remote
 * view with no relay yet, nothing at all — never this machine's workspace
 * host, whose port would answer for the wrong machine's project.
 */
export function installClientWorktreePortOverride(
  hostForView: (webContentsId: number) => HostId | null
): () => void {
  const broker = getWorktreePortBrokerRef();
  if (!broker) return () => {};
  return broker.setHostOverride((wcId) => {
    const hostId = hostForView(wcId);
    if (hostId === null) return null;
    const entry = clientRelays.get(wcId);
    if (entry?.hostId === hostId) return entry.host;
    if (entry) detachClientWorktreeRelay(wcId);
    // Whatever local port the view held belongs to the machine it left.
    broker.closePortsForView(wcId);
    return AWAITING_RELAY;
  });
}
