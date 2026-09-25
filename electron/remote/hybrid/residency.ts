import type { ClientEndpoint } from "../../ipc/endpoint.js";
import { CHANNELS } from "../../ipc/channels.js";
import { getEndpointRegistry } from "../../ipc/endpointRegistry.js";
import { projectStore } from "../../services/ProjectStore.js";
import {
  activateProjectOnHost,
  getHostResidentProject,
  releaseProjectOnHost,
  type HostActivationWorkspace,
} from "../../services/ProjectSwitchService.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { getWorkspaceClientRef } from "../../window/serviceRefs.js";

type Registry = Pick<ReturnType<typeof getEndpointRegistry>, "getRemote" | "onChange">;

export interface RemoteResidencyOptions {
  registry?: Registry;
  workspace?: () => HostActivationWorkspace | null;
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
  const tracked = new Map<number, { dispose(): void }>();

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
    if (getHostResidentProject(handle) === projectId) return;
    const project = projectStore.getProjectById(projectId);
    if (!project) return;
    activateProjectOnHost(workspace, project, handle).then(
      () => reportLoadStatus(endpoint, projectId, null),
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

  const sweep = (): void => {
    for (const endpoint of registry.getRemote()) {
      if (!endpoint.isClosed()) reconcile(endpoint);
    }
  };

  const off = registry.onChange(sweep);
  sweep();
  return () => {
    off();
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
