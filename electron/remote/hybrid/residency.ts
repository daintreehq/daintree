import { WORKTREE_PORT_REDELIVER_METHOD, type ClientEndpoint } from "../../ipc/endpoint.js";
import { CHANNELS } from "../../ipc/channels.js";
import { getEndpointRegistry } from "../../ipc/endpointRegistry.js";
import { projectStore } from "../../services/ProjectStore.js";
import {
  activateProjectOnHost,
  getHostResidentProject,
  isProjectHeldOnHost,
  releaseProjectOnHost,
  type HostActivationWorkspace,
} from "../../services/ProjectSwitchService.js";
import type { WorktreePortBroker, WorktreePortHost } from "../../services/WorktreePortBroker.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { getWorkspaceClientRef, getWorktreePortBrokerRef } from "../../window/serviceRefs.js";

/** The host waits as long for the view's receipt as a worktree Retry does. */
const REDELIVER_TIMEOUT_MS = 10_000;

type Registry = Pick<ReturnType<typeof getEndpointRegistry>, "getRemote" | "onChange">;

export type ResidencyWorkspace = HostActivationWorkspace & {
  getHostForProject(rootPath: string): WorktreePortHost | undefined;
  on(event: "host-spawned", listener: () => void): unknown;
  off(event: "host-spawned", listener: () => void): unknown;
};

export interface RemoteResidencyOptions {
  registry?: Registry;
  workspace?: () => ResidencyWorkspace | null;
  broker?: () => Pick<WorktreePortBroker, "connectEndpointPort"> | null;
}

/**
 * Host side: keep each remote view's project resident here for as long as the
 * view shows it. A view names its project when its endpoint opens (a window
 * reopened on a project, a Shell restoring after a reconnect) as well as on a
 * switch, and the switch handler only covers the latter; without this a view
 * that attaches to a cold project would wait on a workspace host nothing
 * starts. Activation is the same shared operation a switch runs, so the two
 * share one load. The view's residency ends when its endpoint closes or it
 * unbinds.
 */
export function installRemoteProjectResidency(options: RemoteResidencyOptions = {}): () => void {
  const registry = options.registry ?? getEndpointRegistry();
  const workspaceOf = options.workspace ?? getWorkspaceClientRef;
  const brokerOf = options.broker ?? getWorktreePortBrokerRef;
  const tracked = new Map<number, { dispose(): void }>();
  let spawnWatch: { workspace: ResidencyWorkspace; off(): void } | null = null;

  const release = (handle: number): void => {
    tracked.get(handle)?.dispose();
    tracked.delete(handle);
    const workspace = workspaceOf();
    if (workspace) releaseProjectOnHost(workspace, handle);
  };

  const reconcile = (endpoint: ClientEndpoint): void => {
    const { handle, projectId } = endpoint;
    if (!tracked.has(handle)) {
      tracked.set(
        handle,
        endpoint.onClose(() => release(handle))
      );
    }
    const workspace = workspaceOf();
    if (!workspace) return;
    if (projectId === null) {
      releaseProjectOnHost(workspace, handle);
      return;
    }
    if (isProjectHeldOnHost(workspace, handle, projectId)) return;
    // Still resident by name but no longer holding the host: it was disposed
    // and re-spawned under the view, taking the view's worktree port with it.
    const reholding = getHostResidentProject(handle) === projectId;
    const project = projectStore.getProjectById(projectId);
    if (!project) {
      // A scratch (no project row, no workspace host): the project the view left is no longer held.
      releaseProjectOnHost(workspace, handle);
      return;
    }
    activateProjectOnHost(workspace, project, handle).then(
      () => {
        if (connectEndpoint(workspace, endpoint, project) && reholding) {
          redeliverPort(endpoint, projectId);
        }
        reportLoadStatus(endpoint, projectId, null);
      },
      (error: unknown) => {
        console.error("[RemoteHosts] Workspace load for a remote view failed:", error);
        reportLoadStatus(
          endpoint,
          projectId,
          formatErrorMessage(error, "Failed to load worktrees")
        );
      }
    );
  };

  // The view's own port retry gave up long before a host re-spawned under it
  // comes back (#13748), so the residency that re-holds the host also hands
  // the endpoint its port. Idempotent: a view already connected to this host,
  // or not waiting for a port, is left alone.
  const connectEndpoint = (
    workspace: ResidencyWorkspace,
    endpoint: ClientEndpoint,
    project: { id: string; path: string }
  ): boolean => {
    // The view may have moved on while the load ran.
    if (endpoint.isClosed() || endpoint.projectId !== project.id) return false;
    const host = workspace.getHostForProject(project.path);
    if (!host) return false;
    try {
      return brokerOf()?.connectEndpointPort(host, endpoint.handle) ?? false;
    } catch (error) {
      console.warn("[RemoteHosts] Couldn't reconnect a remote view's worktree port:", error);
      return false;
    }
  };

  // Reconnecting this end alone leaves the view's renderer on the port it
  // already holds, and it only leaves "Reconnecting…" once a snapshot lands.
  // A fresh port from its Shell makes it fetch one, as a worktree Retry does.
  const redeliverPort = (endpoint: ClientEndpoint, projectId: string): void => {
    endpoint
      .request(WORKTREE_PORT_REDELIVER_METHOD, null, { timeoutMs: REDELIVER_TIMEOUT_MS })
      .then(
        (confirmed) => {
          console.log("[RemoteHosts] Reconnected a remote view to its re-spawned workspace host", {
            endpointHandle: endpoint.handle,
            projectId,
            confirmed: confirmed === true,
          });
        },
        (error: unknown) => {
          console.warn("[RemoteHosts] Couldn't redeliver a remote view's worktree port:", error);
        }
      );
  };

  // A re-spawned host is the one event that strands a view whose residency
  // still names the project; re-sweeping lets each such view re-hold it.
  const onHostSpawned = (): void => sweep();
  const watchSpawns = (workspace: ResidencyWorkspace): void => {
    if (spawnWatch?.workspace === workspace) return;
    spawnWatch?.off();
    workspace.on("host-spawned", onHostSpawned);
    spawnWatch = { workspace, off: () => workspace.off("host-spawned", onHostSpawned) };
  };

  const sweep = (): void => {
    const workspace = workspaceOf();
    if (workspace) watchSpawns(workspace);
    for (const endpoint of registry.getRemote()) {
      if (!endpoint.isClosed()) reconcile(endpoint);
    }
  };

  const off = registry.onChange(sweep);
  sweep();
  return () => {
    off();
    spawnWatch?.off();
    spawnWatch = null;
    // Host mode stopping: nothing here holds these projects for a view any more.
    for (const handle of [...tracked.keys()]) release(handle);
  };
}

function reportLoadStatus(
  endpoint: ClientEndpoint,
  projectId: string,
  worktreeLoadError: string | null
): void {
  // The view may have moved on while the load ran; the status is about this project only.
  if (endpoint.isClosed() || endpoint.projectId !== projectId) return;
  try {
    endpoint.send({
      type: "event",
      channel: CHANNELS.PROJECT_WORKTREE_LOAD_STATUS,
      args: [{ projectId, worktreeLoadError }],
    });
  } catch {
    // A closing link; the view resyncs on the way back.
  }
}
