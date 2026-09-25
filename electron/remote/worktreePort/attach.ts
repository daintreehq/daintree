import type { WebContents } from "electron";
import type { ClientEndpoint } from "../../ipc/endpoint.js";
import { getEndpointRegistry } from "../../ipc/endpointRegistry.js";
import { projectStore } from "../../services/ProjectStore.js";
import type { WorktreePortHost } from "../../services/WorktreePortBroker.js";
import { getWorkspaceClientRef, getWorktreePortBrokerRef } from "../../window/serviceRefs.js";
import type { LinkSession } from "../link/session.js";
import { wrapMainPort } from "../terminal/ports.js";
import { WorktreePortClientRelay, WorktreePortHostBridge } from "./WorktreePortBridge.js";

/**
 * Production wiring for worktree ports over the link: on the host, a bridge
 * per remote endpoint connected to its project's workspace host through the
 * port broker; on the client, a relay per remote view that the broker treats
 * as that view's workspace host.
 */

const hostBridges = new Map<string, { bridge: WorktreePortHostBridge; cleanup: () => void }>();

export function attachWorktreePortBridge(
  session: LinkSession,
  endpoint: ClientEndpoint
): WorktreePortHostBridge {
  let entry = hostBridges.get(endpoint.endpointId);
  if (!entry) {
    const handle = endpoint.handle;
    const bridge: WorktreePortHostBridge = new WorktreePortHostBridge({
      endpointId: endpoint.endpointId,
      open: (projectId) => {
        const broker = getWorktreePortBrokerRef();
        const projectPath = projectStore.getProjectById(projectId)?.path;
        const host = projectPath ? getWorkspaceClientRef()?.getHostForProject(projectPath) : null;
        if (!broker || !host) return;
        broker.brokerEndpointPort(host, handle, (port) => bridge.setPort(wrapMainPort(port)));
      },
      release: () => getWorktreePortBrokerRef()?.releaseEndpointPort(handle),
    });
    const closeSub = endpoint.onClose(() => detachWorktreePortBridge(endpoint.endpointId));
    const offChange = getEndpointRegistry().onChange(() => {
      if (!endpoint.isClosed()) bridge.setProject(endpoint.projectId);
    });
    entry = {
      bridge,
      cleanup: () => {
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
  host: WorktreePortHost;
  cleanup: () => void;
}

const clientRelays = new Map<number, ClientEntry>();

export function attachClientWorktreeRelay(
  session: LinkSession,
  viewWebContents: WebContents,
  endpointId: string
): WorktreePortClientRelay {
  const wcId = viewWebContents.id;
  let entry = clientRelays.get(wcId);
  if (entry && entry.relay.endpointId !== endpointId) {
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
      projectPath: `remote-endpoint:${endpointId}`,
      attachWorktreePort: (port) => {
        relay.setRendererPort(wrapMainPort(port));
        return true;
      },
    };
    const onDestroyed = () => detachClientWorktreeRelay(wcId);
    viewWebContents.once("destroyed", onDestroyed);
    entry = {
      relay,
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

/**
 * Make every broker path that (re)posts a view's worktree port reach the
 * view's relay when it has one, instead of a local workspace host.
 */
export function installClientWorktreePortOverride(): () => void {
  const broker = getWorktreePortBrokerRef();
  if (!broker) return () => {};
  return broker.setHostOverride((wcId) => clientRelays.get(wcId)?.host ?? null);
}
