import { randomUUID } from "node:crypto";
import { CHANNELS } from "../../channels.js";
import { typedHandleWithContext, broadcastToRenderer } from "../../utils.js";
import { getWindowForWebContents } from "../../../window/webContentsRegistry.js";
import { distributePortsToView } from "../../../window/portDistribution.js";
import { projectStore } from "../../../services/ProjectStore.js";
import { scratchStore } from "../../../services/ScratchStore.js";
import { ProjectSwitchService } from "../../../services/ProjectSwitchService.js";
import { broadcastProjectSwitchUpdates } from "../../projectSwitchBroadcast.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
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
    ctx: import("../../types.js").IpcContext,
    projectId: string,
    outgoingState?: ProjectSwitchOutgoingState,
    options?: { focusIntent?: "focus-next-waiting" }
  ) => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }

    const project = projectStore.getProjectById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const previousProjectId = projectStore.getCurrentProjectId();
    // Started concurrently with the view swap — the incoming view never reads
    // the outgoing project's state file — and awaited before returning so the
    // IPC contract (state persisted before resolve) is preserved.
    const persistOutgoing = persistOutgoingProjectState(
      outgoingState,
      previousProjectId,
      "project:switch"
    );
    trackOutgoingPersist(previousProjectId, persistOutgoing);

    const pvm = resolveProjectViewManager(deps, ctx.event);
    if (pvm) {
      // Record the focus intent on the PVM instance BEFORE switchTo so the
      // cached-view fast path can pick it up synchronously and the cold-start
      // path can read it after the paint gate resolves. PVM owns the lifecycle
      // (consumed exactly once or discarded on timeout/error).
      if (options?.focusIntent) {
        pvm.setPendingFocusIntent(projectId, options.focusIntent);
      }
      // Rapid switch-back: a cold-start hydrate of the target must not read
      // its state file while a previous switch's persist is still writing it.
      await awaitPendingOutgoingPersist(projectId);
      await activateProjectView(deps, ctx.event, pvm, projectId, project, {
        logPrefix: "[ProjectSwitch]",
        resumeWorkspace: true,
      });
      await persistOutgoing;
      return project;
    }

    await persistOutgoing;
    // Legacy (non-PVM) path bypasses WorkspaceHostPool.loadProject, so the
    // pool's switch-away background demotion never fires. Pause the outgoing
    // project and resume the incoming one explicitly so background projects
    // stop full-rate polling here too (#10743).
    if (deps.worktreeService) {
      if (previousProjectId && previousProjectId !== projectId) {
        const previousPath = projectStore.getProjectById(previousProjectId)?.path;
        if (previousPath) {
          deps.worktreeService.pauseProject(previousPath);
        }
      }
      deps.worktreeService.resumeProject(project.path);
    }
    return await projectSwitchService.switchProject(projectId);
  };
  handlers.push(typedHandleWithContext(CHANNELS.PROJECT_SWITCH, handleProjectSwitch));

  const handleProjectReopen = async (
    ctx: import("../../types.js").IpcContext,
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

    const previousProjectId = projectStore.getCurrentProjectId();
    let persistOutgoing: Promise<void> = Promise.resolve();
    if (previousProjectId !== projectId) {
      persistOutgoing = persistOutgoingProjectState(
        outgoingState,
        previousProjectId,
        "project:reopen"
      );
      trackOutgoingPersist(previousProjectId, persistOutgoing);
    }

    const pvm = resolveProjectViewManager(deps, ctx.event);
    if (pvm) {
      await awaitPendingOutgoingPersist(projectId);
      await activateProjectView(deps, ctx.event, pvm, projectId, project, {
        logPrefix: "[ProjectReopen]",
        markActive: true,
        resumeWorkspace: true,
      });
      await persistOutgoing;
      return project;
    }

    await persistOutgoing;
    if (deps.worktreeService) {
      deps.worktreeService.resumeProject(project.path);
    }
    return await projectSwitchService.reopenProject(projectId);
  };
  handlers.push(typedHandleWithContext(CHANNELS.PROJECT_REOPEN, handleProjectReopen));

  return () => handlers.forEach((cleanup) => cleanup());
}

const pendingOutgoingPersists = new Map<string, Promise<void>>();

function trackOutgoingPersist(projectId: string | null, persist: Promise<void>): void {
  if (!projectId) return;
  pendingOutgoingPersists.set(projectId, persist);
  const cleanup = () => {
    if (pendingOutgoingPersists.get(projectId) === persist) {
      pendingOutgoingPersists.delete(projectId);
    }
  };
  persist.then(cleanup, cleanup);
}

async function awaitPendingOutgoingPersist(projectId: string): Promise<void> {
  const pending = pendingOutgoingPersists.get(projectId);
  if (pending) {
    // Failures surface on the originating switch's own await, not here.
    await pending.catch(() => {});
  }
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
  // Queued so the read-merge-write can't clobber concurrent queued writers
  // (terminalLayout handlers) now that the persist runs alongside the swap.
  await projectStore.enqueueProjectStateUpdate(previousProjectId, (existing) => ({
    ...(existing ?? { projectId: previousProjectId, sidebarWidth: 350, terminals: [] }),
    projectId: previousProjectId,
    ...(validTerminals !== undefined && { terminals: validTerminals }),
    ...(validSizes !== undefined && { terminalSizes: validSizes }),
    ...(validDrafts !== undefined && { draftInputs: validDrafts }),
    ...(validTabGroups !== undefined && { tabGroups: validTabGroups }),
    activeWorktreeId: outgoingState.activeWorktreeId,
  }));
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

  // Mutually exclusive with scratch: switching to a project clears any
  // active scratch pointer + notifies renderers so palette/UI state stays
  // coherent. Without this, `currentScratchId` would linger in app_state
  // and `scratchStore.getCurrentScratch()` would return stale data.
  // Wrapped because some test environments don't initialize the shared DB —
  // a project switch must not fail because optional cross-store cleanup did.
  try {
    if (scratchStore.getCurrentScratchId() !== null) {
      scratchStore.clearCurrentScratch();
      broadcastToRenderer(CHANNELS.SCRATCH_ON_SWITCH, { scratch: null, switchId: "" });
    }
  } catch (err) {
    console.warn("[ProjectSwitch] Failed to clear active scratch:", err);
  }

  // Capture the outgoing project id before the pointer flips so we can
  // broadcast its bumped `lastOpened` to every cached view (#8561).
  const previousProjectId = projectStore.getCurrentProjectId();

  // Update the main process global state
  await projectStore.setCurrentProject(projectId);

  if (options.markActive) {
    projectStore.updateProjectStatus(projectId, "active");
  }

  // Push the persisted `lastOpened`/`status` updates to every renderer.
  // `setCurrentProject` writes both the departing and activated rows inside a
  // single transaction but does not emit IPC; without this broadcast, cached
  // WebContentsView stores keep stale MRU timestamps and the next
  // `Cmd+Alt+=` / project switcher pick targets the wrong project.
  broadcastProjectSwitchUpdates(previousProjectId, projectId);

  // Notify the activated view that it was reached via an explicit in-session
  // switch so it can invalidate its current/settings cache, refresh MRU state,
  // and fan out project-switch polling (see `projectClient.onSwitch` consumers).
  // The legacy `ProjectSwitchService` path emits this on the single shared
  // renderer; the PVM path swaps WebContentsViews, so a targeted send reaches the
  // newly-activated view. Targeted (not a broadcast) so LRU-cached other-project
  // views aren't falsely marked switched. `switchTo` already awaited
  // `did-finish-load`, so the renderer's listener is registered (mirrors the
  // targeted `PROJECT_WORKTREE_LOAD_STATUS` send below).
  if (!view.webContents.isDestroyed()) {
    const switchedProject = projectStore.getProjectById(projectId) ?? project;
    view.webContents.send(CHANNELS.PROJECT_ON_SWITCH, {
      project: switchedProject,
      switchId: randomUUID(),
    });
  }

  // Reopen requires the workspace host to be resumed BEFORE loadProject so
  // the host is ready to accept worktree IPC from the newly-active view.
  if (options.resumeWorkspace && deps.worktreeService) {
    deps.worktreeService.resumeProject(project.path);
  }

  const senderWindow = getWindowForWebContents(event.sender);
  const windowId = senderWindow?.id ?? deps.mainWindow?.id;

  // Notify the PTY host of the active project and distribute a fresh
  // MessagePort to the reactivated view BEFORE the worktree git load. On warm
  // switches `loadProject` below can take several hundred ms (prune/list/status
  // sync/LFS probe); running it first would leave the just-swapped view showing
  // stale buffered terminal output until the git load resolves, because new PTY
  // data has nowhere to flow until the renderer holds its new port (#10075).
  // PTY rebrokering has no dependency on `loadProject` or the WorkspaceClient
  // windowToProject mapping, so it is safe to run first — this matches the
  // legacy ProjectSwitchService ordering (onProjectSwitch before loadProject).
  if (windowId !== undefined) {
    // Best-effort: the PTY rebrokering now runs before the worktree load, so an
    // unexpected throw here must not abort the switch and skip `loadProject`
    // (which would leave the WorkspaceClient windowToProject mapping stale).
    try {
      if (deps.ptyClient) {
        deps.ptyClient.onProjectSwitch(windowId, projectId, project.path);
      }

      // Cold-started views receive their first PTY MessagePort from
      // ProjectViewManager.onViewReady during did-finish-load. Replacing that
      // port again here can race with the first terminal prompt after the view
      // becomes interactive. Cached reactivations do not reload, so they still
      // need a fresh port here.
      const win = senderWindow ?? deps.mainWindow;
      if (!isNew && win && deps.windowRegistry && !view.webContents.isDestroyed()) {
        const ctx = deps.windowRegistry.getByWindowId(win.id);
        if (ctx) {
          distributePortsToView(win, ctx, view.webContents, deps.ptyClient ?? null);
        }
      }
    } catch (err) {
      console.error(`${options.logPrefix} Failed to rebroker PTY port:`, err);
    }
  }

  // Always call loadProject so the WorkspaceClient's windowToProject
  // mapping points to the correct project.  Without this, reactivating a
  // cached view leaves the mapping pointing at the *previous* project,
  // causing sendToEntryWindows to route the old project's IPC events to
  // the newly-active view (cross-project worktree contamination).
  if (deps.worktreeService) {
    if (windowId !== undefined) {
      // Forward-fail: the view swap already committed to the new project, so a
      // load failure surfaces as a Tier 3 recovery banner rather than reverting
      // (#8400). Send a targeted status to *this* view only (broadcastToRenderer
      // would also hit LRU-cached other-project views); null on success clears a
      // stale banner when a previously-failed view is reactivated successfully.
      let worktreeLoadError: string | null = null;
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
        worktreeLoadError = formatErrorMessage(err, "Failed to load worktrees");
      }
      if (!view.webContents.isDestroyed()) {
        view.webContents.send(CHANNELS.PROJECT_WORKTREE_LOAD_STATUS, {
          projectId,
          worktreeLoadError,
        });
      }
    }

    // Register the new view's webContents in WindowRegistry
    if (isNew && deps.windowRegistry && senderWindow) {
      deps.windowRegistry.registerAppViewWebContents(senderWindow.id, view.webContents.id);
    }
  }
}
