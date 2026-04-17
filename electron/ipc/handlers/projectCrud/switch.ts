import { ipcMain } from "electron";
import { CHANNELS } from "../../channels.js";
import { getWindowForWebContents } from "../../../window/webContentsRegistry.js";
import { distributePortsToView } from "../../../window/portDistribution.js";
import { projectStore } from "../../../services/ProjectStore.js";
import { ProjectSwitchService } from "../../../services/ProjectSwitchService.js";
import {
  sanitizeTerminals,
  sanitizeTerminalSizes,
  sanitizeDraftInputs,
} from "../terminalLayout.js";
import { sanitizeTabGroups } from "../../../schemas/index.js";
import type { HandlerDependencies } from "../../types.js";
import type { Project } from "../../../types/index.js";
import type { ProjectSwitchOutgoingState } from "../../../../shared/types/ipc/project.js";
import type { TabGroup } from "../../../../shared/types/panel.js";

export function registerProjectSwitchHandlers(deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const projectSwitchService = deps.projectSwitchService ?? new ProjectSwitchService(deps);

  const handleProjectSwitch = async (
    event: Electron.IpcMainInvokeEvent,
    projectId: string,
    outgoingState?: ProjectSwitchOutgoingState
  ) => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }

    const project = projectStore.getProjectById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    // Pre-apply the renderer's outgoing terminal state to the current project's
    // persisted state BEFORE the switch runs.
    const previousProjectId = projectStore.getCurrentProjectId();
    await persistOutgoingProjectState(outgoingState, previousProjectId, "project:switch");

    const pvm = resolveProjectViewManager(deps, event);
    if (pvm) {
      await activateProjectView(deps, event, pvm, projectId, project, {
        logPrefix: "[ProjectSwitch]",
      });
      return project;
    }

    // Fallback: legacy single-view switch path
    return await projectSwitchService.switchProject(projectId);
  };
  ipcMain.handle(CHANNELS.PROJECT_SWITCH, handleProjectSwitch);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_SWITCH));

  const handleProjectReopen = async (
    event: Electron.IpcMainInvokeEvent,
    projectId: string,
    outgoingState?: ProjectSwitchOutgoingState
  ) => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }

    console.log(`[IPC] project:reopen: ${projectId}`);

    const project = projectStore.getProjectById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    if (project.status !== "background" && project.status !== "active") {
      throw new Error(
        `Cannot reopen project ${projectId} unless status is "background" or "active" (current: ${project.status ?? "unset"})`
      );
    }

    // Pre-apply outgoing terminal state
    const previousProjectId = projectStore.getCurrentProjectId();
    if (previousProjectId !== projectId) {
      await persistOutgoingProjectState(outgoingState, previousProjectId, "project:reopen");
    }

    const pvm = resolveProjectViewManager(deps, event);
    if (pvm) {
      await activateProjectView(deps, event, pvm, projectId, project, {
        logPrefix: "[ProjectReopen]",
        markActive: true,
        resumeWorkspace: true,
      });
      return project;
    }

    // Fallback: legacy single-view path
    if (deps.worktreeService) {
      deps.worktreeService.resumeProject(project.path);
    }
    return await projectSwitchService.reopenProject(projectId);
  };
  ipcMain.handle(CHANNELS.PROJECT_REOPEN, handleProjectReopen);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_REOPEN));

  return () => handlers.forEach((cleanup) => cleanup());
}

function resolveProjectViewManager(deps: HandlerDependencies, event: Electron.IpcMainInvokeEvent) {
  const senderWindow = getWindowForWebContents(event.sender);
  const pvmCtx = senderWindow ? deps.windowRegistry?.getByWindowId(senderWindow.id) : undefined;
  return pvmCtx?.services?.projectViewManager ?? deps.projectViewManager;
}

async function persistOutgoingProjectState(
  outgoingState: ProjectSwitchOutgoingState | undefined,
  previousProjectId: string | null,
  logLabel: string
): Promise<void> {
  if (!outgoingState || !previousProjectId) return;

  const validTerminals = outgoingState.terminals
    ? sanitizeTerminals(outgoingState.terminals, `${logLabel}/pre-apply(${previousProjectId})`)
    : undefined;
  const validSizes = outgoingState.terminalSizes
    ? sanitizeTerminalSizes(outgoingState.terminalSizes as Record<string, unknown>)
    : undefined;
  const validDrafts = outgoingState.draftInputs
    ? sanitizeDraftInputs(outgoingState.draftInputs as Record<string, unknown>)
    : undefined;
  const validTabGroups =
    outgoingState.tabGroups !== undefined
      ? (sanitizeTabGroups(
          outgoingState.tabGroups,
          `${logLabel}/pre-apply(${previousProjectId})`
        ) as TabGroup[])
      : undefined;
  const existing = await projectStore.getProjectState(previousProjectId);
  await projectStore.saveProjectState(previousProjectId, {
    ...(existing ?? { projectId: previousProjectId, sidebarWidth: 350, terminals: [] }),
    projectId: previousProjectId,
    ...(validTerminals !== undefined && { terminals: validTerminals }),
    ...(validSizes !== undefined && { terminalSizes: validSizes }),
    ...(validDrafts !== undefined && { draftInputs: validDrafts }),
    ...(validTabGroups !== undefined && { tabGroups: validTabGroups }),
    activeWorktreeId: outgoingState.activeWorktreeId,
  });
}

type ActivateOptions = {
  logPrefix: string;
  markActive?: boolean;
  resumeWorkspace?: boolean;
};

async function activateProjectView(
  deps: HandlerDependencies,
  event: Electron.IpcMainInvokeEvent,
  pvm: NonNullable<ReturnType<typeof resolveProjectViewManager>>,
  projectId: string,
  project: Project,
  options: ActivateOptions
): Promise<void> {
  // Multi-view path: swap WebContentsViews instead of resetting stores
  const { view, isNew } = await pvm.switchTo(projectId, project.path);

  // Update the main process global state
  await projectStore.setCurrentProject(projectId);

  if (options.markActive) {
    projectStore.updateProjectStatus(projectId, "active");
  }

  // Reopen requires the workspace host to be resumed BEFORE loadProject so
  // the host is ready to accept worktree IPC from the newly-active view.
  if (options.resumeWorkspace && deps.worktreeService) {
    deps.worktreeService.resumeProject(project.path);
  }

  // Always call loadProject so the WorkspaceClient's windowToProject
  // mapping points to the correct project.  Without this, reactivating a
  // cached view leaves the mapping pointing at the *previous* project,
  // causing sendToEntryWindows to route the old project's IPC events to
  // the newly-active view (cross-project worktree contamination).
  if (deps.worktreeService) {
    const senderWindow = getWindowForWebContents(event.sender);
    const windowId = senderWindow?.id ?? deps.mainWindow?.id;
    if (windowId !== undefined) {
      try {
        await deps.worktreeService.loadProject(project.path, windowId);

        // Always attach a direct MessagePort.  For new views this is the
        // first port; for cached views it re-establishes the relay after a
        // potential host recreation (CLEANUP_GRACE_MS expiry).
        if (!view.webContents.isDestroyed()) {
          deps.worktreeService.attachDirectPort(windowId, view.webContents);

          // Broker new worktree port (Phase 1)
          const host = deps.worktreeService.getHostForProject(project.path);
          if (host && deps.worktreePortBroker) {
            deps.worktreePortBroker.brokerPort(host, view.webContents);
          }
        }
      } catch (err) {
        console.error(`${options.logPrefix} Failed to load worktrees:`, err);
      }
    }

    // Register the new view's webContents in WindowRegistry
    if (isNew && deps.windowRegistry && senderWindow) {
      deps.windowRegistry.registerAppViewWebContents(senderWindow.id, view.webContents.id);
    }
  }

  // Notify PTY host of the active project and distribute a fresh
  // MessagePort to the new/reactivated view so terminal data flows.
  const senderWindow = getWindowForWebContents(event.sender);
  const windowId = senderWindow?.id ?? deps.mainWindow?.id;
  if (windowId !== undefined) {
    if (deps.ptyClient) {
      deps.ptyClient.onProjectSwitch(windowId, projectId, project.path);
    }

    // Distribute PTY MessagePort to the switched-to view
    const win = senderWindow ?? deps.mainWindow;
    if (win && deps.windowRegistry && !view.webContents.isDestroyed()) {
      const ctx = deps.windowRegistry.getByWindowId(win.id);
      if (ctx) {
        distributePortsToView(win, ctx, view.webContents, deps.ptyClient ?? null);
      }
    }
  }
}
