import type { BrowserWindow, WebContentsView } from "electron";
import { CHANNELS } from "../ipc/channels.js";
import { broadcastProjectSwitchUpdates } from "../ipc/projectSwitchBroadcast.js";
import { projectStore } from "../services/ProjectStore.js";
import { projectSwitchStatusTiming } from "../services/ProjectSwitchStatusTiming.js";
import type { PtyClient } from "../services/PtyClient.js";
import type { WorkspaceClient } from "../services/WorkspaceClient.js";
import type { WorktreePortBroker } from "../services/WorktreePortBroker.js";
import type { Project } from "../../shared/types/project.js";
import { distributePortsToView } from "./portDistribution.js";
import { getWindowRegistry } from "./windowRef.js";

export interface LocalProjectActivation {
  targetWindow: BrowserWindow;
  project: Project;
  view: WebContentsView;
  isNew: boolean;
  /**
   * The project of this machine the window is leaving, which goes to the
   * background. Null when it leaves none: a scratch, or a host's project.
   */
  outgoingProjectId: string | null;
  switchId: string;
  statusTimingDeadlineAt?: number;
  clients: {
    workspace: WorkspaceClient | null;
    broker: WorktreePortBroker | null;
    pty: PtyClient | null;
  };
  logPrefix: string;
}

/**
 * What a switch to a project of this machine does once main has swapped its
 * view in, as `activateProjectView` does on the IPC path: the project becomes
 * current (active again if it was closed), every view hears the MRU change,
 * the view is told it was switched to, and it gets its producer ports back. A
 * view parked in the cache had its worktree and workspace ports closed
 * (#6273), and the window's PTY port was replaced when it last switched away,
 * to another project or onto a host.
 */
export async function completeLocalProjectActivation(
  activation: LocalProjectActivation
): Promise<void> {
  const { targetWindow, project, view, isNew, switchId, clients } = activation;
  await projectStore.setCurrentProject(project.id, activation.outgoingProjectId);
  // Fans out `project:updated` for both rows so cached views' MRU timestamps
  // stay fresh; otherwise the next `Cmd+Alt+=` targets the wrong project.
  broadcastProjectSwitchUpdates(activation.outgoingProjectId, project.id);

  if (view.webContents.isDestroyed()) return;
  // Only the activated view: LRU-cached views of other projects must not be
  // marked switched.
  view.webContents.send(CHANNELS.PROJECT_ON_SWITCH, {
    project: projectStore.getProjectById(project.id) ?? project,
    switchId,
    ...(activation.statusTimingDeadlineAt !== undefined && {
      statusTimingDeadlineAt: activation.statusTimingDeadlineAt,
    }),
  });

  if (clients.workspace) {
    try {
      projectSwitchStatusTiming.hostReady(
        switchId,
        await clients.workspace.loadProject(project.path, targetWindow.id)
      );
      clients.workspace.attachDirectPort(targetWindow.id, view.webContents);
      const host = clients.workspace.getHostForProject(project.path);
      if (host && clients.broker) clients.broker.brokerPort(host, view.webContents);
    } catch (err) {
      projectSwitchStatusTiming.fail(switchId, "load-failed");
      console.error(`${activation.logPrefix} Failed to restore worktree ports:`, err);
    }
  }

  clients.pty?.onProjectSwitch(targetWindow.id, project.id, project.path);
  const ctx = getWindowRegistry()?.getByWindowId(targetWindow.id);
  if (!isNew && ctx && !view.webContents.isDestroyed()) {
    distributePortsToView(targetWindow, ctx, view.webContents, clients.pty);
  }
}
