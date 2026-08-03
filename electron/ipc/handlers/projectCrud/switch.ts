import { randomUUID } from "node:crypto";
import { CHANNELS } from "../../channels.js";
import { typedHandleWithContext, broadcastToRenderer } from "../../utils.js";
import {
  getWindowForWebContents,
  getProjectForWebContents,
} from "../../../window/webContentsRegistry.js";
import { getProjectIdFromSenderUrl } from "../../projectContext.js";
import { distributePortsToView } from "../../../window/portDistribution.js";
import { projectStore } from "../../../services/ProjectStore.js";
import { probeGitMarker } from "../../../services/projectOpenPreflight.js";
import { AppError } from "../../../utils/errorTypes.js";
import { scratchStore } from "../../../services/ScratchStore.js";
import { ProjectSwitchService } from "../../../services/ProjectSwitchService.js";
import { getProjectHistory } from "../../../services/ProjectHistoryService.js";
import { broadcastProjectSwitchUpdates } from "../../projectSwitchBroadcast.js";
import { refreshProjectMenuState } from "../../../projectMenuState.js";
import { scheduleOpenWindowsSave } from "../../../window/openWindowsTracker.js";
import { notificationService } from "../../../services/NotificationService.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
import { logInfo } from "../../../utils/logger.js";
import {
  sanitizeTerminals,
  sanitizeTerminalSizes,
  sanitizeDraftInputs,
  sanitizeFieldEdits,
  TERMINAL_FIELD_LEVEL_MERGE,
} from "../terminalLayout.js";
import { sanitizeTabGroups } from "../../../schemas/index.js";
import { mergeIdArray, mergeRecord } from "../../../../shared/utils/layoutMerge.js";
import type { HandlerDependencies, IpcContext } from "../../types.js";
import type { Project } from "../../../types/index.js";
import type { ProjectSwitchOutgoingState } from "../../../../shared/types/ipc/project.js";
import type { TabGroup } from "../../../../shared/types/panel.js";
import type { ProjectFocusOnActivateIntent } from "../../../../shared/types/ipc/project.js";

export function registerProjectSwitchHandlers(deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const projectSwitchService = deps.projectSwitchService ?? new ProjectSwitchService(deps);

  const handleProjectSwitch = async (
    ctx: IpcContext,
    projectId: string,
    outgoingState?: ProjectSwitchOutgoingState,
    options?: { focusIntent?: ProjectFocusOnActivateIntent }
  ) => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }

    const project = projectStore.getProjectById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    // Ahead of the capture: everything from here on has side effects the sender
    // can't undo if the target turns out to have lost its repository.
    await assertProjectRepositoryIntact(project);

    const operation = captureSwitchOperation(deps, ctx, projectId, "project:switch");
    const { outgoingProjectId, projectViewManager: pvm } = operation;

    // Started concurrently with the view swap — the incoming view never reads
    // the outgoing project's state file — and awaited before returning so the
    // IPC contract (state persisted before resolve) is preserved.
    const persistOutgoing = persistOutgoingProjectState(outgoingState, operation);
    trackOutgoingPersist(outgoingProjectId, persistOutgoing);

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
      try {
        await activateProjectView(deps, operation, pvm, project, {
          logPrefix: "[ProjectSwitch]",
          resumeWorkspace: true,
        });
        await persistOutgoing;
      } finally {
        // In `finally`, not after the awaits: once the swap has run, the PVM
        // binding has moved (or been rolled back), so the gates must converge on
        // whatever state we actually landed in — including when the outgoing
        // persist rejects after a visually successful activation.
        refreshProjectMenuState();
        notificationService.refreshTitles();
      }
      return project;
    }

    await persistOutgoing;
    // Legacy (non-PVM) path bypasses WorkspaceHostPool.loadProject, so the
    // pool's switch-away background demotion never fires. Pause the outgoing
    // project and resume the incoming one explicitly so background projects
    // stop full-rate polling here too (#10743).
    if (deps.worktreeService) {
      if (outgoingProjectId && outgoingProjectId !== projectId) {
        const previousPath = projectStore.getProjectById(outgoingProjectId)?.path;
        if (previousPath) {
          deps.worktreeService.pauseProject(previousPath);
        }
      }
      deps.worktreeService.resumeProject(project.path);
    }
    try {
      return await projectSwitchService.switchProject(projectId);
    } finally {
      refreshProjectMenuState();
      notificationService.refreshTitles();
    }
  };
  handlers.push(typedHandleWithContext(CHANNELS.PROJECT_SWITCH, handleProjectSwitch));

  const handleProjectReopen = async (
    ctx: IpcContext,
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

    await assertProjectRepositoryIntact(project);

    const operation = captureSwitchOperation(deps, ctx, projectId, "project:reopen");
    const { outgoingProjectId, projectViewManager: pvm } = operation;

    // Sender-scoped no-op check: skip the persist only when THIS window is
    // already displaying the target. The global pointer answers a different
    // question — with a second window open it can equal the target while the
    // sender still has its own outgoing layout to save (#11101).
    let persistOutgoing: Promise<void> = Promise.resolve();
    if (outgoingProjectId !== projectId) {
      persistOutgoing = persistOutgoingProjectState(outgoingState, operation);
      trackOutgoingPersist(outgoingProjectId, persistOutgoing);
    }

    if (pvm) {
      await awaitPendingOutgoingPersist(projectId);
      try {
        await activateProjectView(deps, operation, pvm, project, {
          logPrefix: "[ProjectReopen]",
          markActive: true,
          resumeWorkspace: true,
        });
        await persistOutgoing;
      } finally {
        refreshProjectMenuState();
        notificationService.refreshTitles();
      }
      return project;
    }

    await persistOutgoing;
    if (deps.worktreeService) {
      deps.worktreeService.resumeProject(project.path);
    }
    try {
      return await projectSwitchService.reopenProject(projectId);
    } finally {
      refreshProjectMenuState();
      notificationService.refreshTitles();
    }
  };
  handlers.push(typedHandleWithContext(CHANNELS.PROJECT_REOPEN, handleProjectReopen));

  return () => handlers.forEach((cleanup) => cleanup());
}

// Monotonic per-window switch epoch. A swap-failure restore (below) is
// deferred until the failed target's early worktree load settles; by then a
// newer switch may own the window, and restoring the old mapping would
// clobber it. Bumped at every activateProjectView entry; the restore only
// runs if its epoch is still current.
const windowSwitchEpochs = new Map<number, number>();

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

/**
 * Refuse to activate a row that claims a repository whose `.git` is provably
 * gone, surfacing the same `NOT_A_GIT_REPO` the path-based entry points already
 * raise (#11649).
 *
 * Recents, Dock drops, Open With and the CLI all re-run `addProject`, so they
 * hit that code and land in the choice dialog where demotion is the user's
 * explicit decision. Switch and reopen address a project by id and never
 * re-classify, so a row whose repository disappeared stayed stuck claiming
 * worktree capability forever — which is what let a repository-less folder adopt
 * the app-global `activeWorktreeId` belonging to some other project. Raising the
 * same code here routes both to the same dialog instead of inventing a second
 * consent surface, and it happens before anything is persisted, swapped or
 * marked active so a declined dialog leaves the sender exactly where it was.
 *
 * Deliberately cheap and deliberately timid:
 * - lightweight rows are skipped — they have nothing left to demote;
 * - one bounded `.git` stat gates the healthy path, so a normal switch pays no
 *   git subprocess;
 * - only a proven-absent marker escalates to the real classifier, and only that
 *   classifier's "not a repository" verdict throws. A dead mount, a permissions
 *   blip or a missing git binary answers `"unknown"` or throws its own code, and
 *   activation proceeds exactly as before rather than prompting to give up a
 *   project's git identity on the strength of a transient failure.
 */
async function assertProjectRepositoryIntact(project: Project): Promise<void> {
  if (project.gitBacked === false) return;
  if ((await probeGitMarker(project.path)) !== "missing") return;

  const classification = await projectStore.classifyGitBacking(project.path);
  if (classification.gitBacked) return;

  throw new AppError({
    code: "NOT_A_GIT_REPO",
    message: `Not a git repository: ${project.path}`,
    context: { projectPath: project.path },
  });
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

/**
 * The project the SENDING view is displaying — the one whose layout a switch is
 * about to save. Never `projectStore.getCurrentProjectId()` in the multi-view
 * world: that global pointer names whichever window switched most recently, so
 * with two windows open it routinely answers for the wrong one (#11101).
 */
function resolveOutgoingProjectId(
  ctx: IpcContext,
  pvm: ReturnType<typeof resolveProjectViewManager>
): string | null {
  // The authoritative binding. webContents ids are process-unique and never
  // reused, and a view is bound to exactly one project for its lifetime, so
  // this stays correct even after the window has switched away.
  const bound = getProjectForWebContents(ctx.webContentsId);
  if (bound) return bound;

  // No ProjectViewManager anywhere: the legacy single-shared-renderer path,
  // where there is only one view and the global pointer IS its project. The
  // sender URL is NOT consulted here — that renderer never reloads on a switch,
  // so its `?projectId=` stays pinned to the boot project and goes stale.
  if (!pvm) return projectStore.getCurrentProjectId();

  // Startup gap: the restored view loads before `registerInitialView` binds it,
  // and can send IPC in between. Its URL is the only per-sender identity there.
  const fromUrl = getProjectIdFromSenderUrl(ctx.event.sender);
  if (fromUrl && projectStore.getProjectById(fromUrl)) return fromUrl;

  // An unbound view (a fresh Cmd+N welcome window) has no project layout of its
  // own to persist. Resolve to null rather than falling back to the global —
  // that fallback is exactly what clobbers another window's project (#6016).
  return null;
}

/**
 * Immutable snapshot of who is switching and what they are switching away from,
 * taken synchronously at handler entry. Everything downstream — persistence, the
 * swap-failure worktree restore, the status/MRU write, the broadcast — reads the
 * outgoing project from here rather than re-deriving it, because by the time
 * those run `pvm.switchTo()` has already flipped the PVM's `activeProjectId` to
 * the INCOMING project and the global pointer may belong to another window.
 */
type SwitchOperation = Readonly<{
  action: "project:switch" | "project:reopen";
  incomingProjectId: string;
  outgoingProjectId: string | null;
  senderWindow: Electron.BrowserWindow | null;
  windowId: number | undefined;
  projectViewManager: ReturnType<typeof resolveProjectViewManager>;
}>;

function captureSwitchOperation(
  deps: HandlerDependencies,
  ctx: IpcContext,
  incomingProjectId: string,
  action: SwitchOperation["action"]
): SwitchOperation {
  const senderWindow = getWindowForWebContents(ctx.event.sender);
  const projectViewManager = resolveProjectViewManager(deps, ctx.event);
  return Object.freeze({
    action,
    incomingProjectId,
    outgoingProjectId: resolveOutgoingProjectId(ctx, projectViewManager),
    senderWindow,
    windowId: senderWindow?.id ?? deps.mainWindow?.id,
    projectViewManager,
  });
}

async function persistOutgoingProjectState(
  outgoingState: ProjectSwitchOutgoingState | undefined,
  operation: SwitchOperation
): Promise<void> {
  const previousProjectId = operation.outgoingProjectId;
  const logLabel = operation.action;
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
  await projectStore.enqueueProjectStateUpdate(previousProjectId, (existing) => {
    const terminalDelta = outgoingState.terminalDelta;
    const tabGroupDelta = outgoingState.tabGroupDelta;
    // With a delta, merge by id so a stale outgoing snapshot only affects the
    // entries this window actually changed, preserving a sibling window's
    // concurrent additions/moves/deletions (#11350). Without one, fall back to
    // the legacy full replace.
    const mergedTerminals =
      validTerminals === undefined
        ? undefined
        : terminalDelta
          ? mergeIdArray(
              existing?.terminals ?? [],
              validTerminals,
              terminalDelta.changedIds,
              terminalDelta.removedIds,
              {
                // Same out-of-band-field policy as the setTerminals handler: a
                // stale outgoing snapshot must not erase a session id Main
                // captured on shutdown (#11461).
                fieldLevelMerge: TERMINAL_FIELD_LEVEL_MERGE,
                fieldEdits: sanitizeFieldEdits(terminalDelta.fieldEdits),
              }
            )
          : validTerminals;
    const mergedTabGroups =
      validTabGroups === undefined
        ? undefined
        : tabGroupDelta
          ? mergeIdArray(
              existing?.tabGroups ?? [],
              validTabGroups,
              tabGroupDelta.changedIds,
              tabGroupDelta.removedIds
            )
          : validTabGroups;
    const draftDelta = outgoingState.draftDelta;
    // Merge drafts by terminal id so a stale outgoing snapshot only affects the
    // drafts this window changed, preserving a sibling window's concurrent
    // drafts (#11352). Without a delta, fall back to the legacy full replace.
    const mergedDrafts =
      validDrafts === undefined
        ? undefined
        : draftDelta
          ? mergeRecord(
              sanitizeDraftInputs((existing?.draftInputs ?? {}) as Record<string, unknown>),
              validDrafts,
              draftDelta.changedIds,
              draftDelta.removedIds
            )
          : validDrafts;
    return {
      ...(existing ?? { projectId: previousProjectId, sidebarWidth: 350, terminals: [] }),
      projectId: previousProjectId,
      ...(mergedTerminals !== undefined && { terminals: mergedTerminals }),
      ...(validSizes !== undefined && { terminalSizes: validSizes }),
      ...(mergedDrafts !== undefined && { draftInputs: mergedDrafts }),
      ...(mergedTabGroups !== undefined && { tabGroups: mergedTabGroups }),
      activeWorktreeId: outgoingState.activeWorktreeId,
    };
  });
}

type ActivateOptions = {
  logPrefix: string;
  markActive?: boolean;
  resumeWorkspace?: boolean;
};

async function activateProjectView(
  deps: HandlerDependencies,
  operation: SwitchOperation,
  pvm: NonNullable<ReturnType<typeof resolveProjectViewManager>>,
  project: Project,
  options: ActivateOptions
): Promise<void> {
  const activateStart = performance.now();
  const { incomingProjectId: projectId, outgoingProjectId, senderWindow, windowId } = operation;

  let switchEpoch = 0;
  if (windowId !== undefined) {
    switchEpoch = (windowSwitchEpochs.get(windowId) ?? 0) + 1;
    windowSwitchEpochs.set(windowId, switchEpoch);
  }

  // Start the workspace-host git load CONCURRENTLY with the view swap. The two
  // have no data dependency (loadProject takes explicit path + windowId), and
  // running them serially added the full load — several hundred ms when the
  // target's host is cold (spawn + worktree enumeration) — to every switch's
  // resolve time. Window-routed worktree sends already target the incoming
  // view for the whole swap (registerAppView flips at attach), so an early
  // windowToProject flip routes to the right renderer. Failures are NOT
  // surfaced here: the await below owns forward-fail (#8400). Reopen requires
  // the host to be resumed BEFORE loadProject so it is ready to accept
  // worktree IPC from the newly-active view.
  let loadWorktrees: Promise<void> | null = null;
  if (deps.worktreeService && windowId !== undefined) {
    if (options.resumeWorkspace) {
      deps.worktreeService.resumeProject(project.path);
    }
    loadWorktrees = deps.worktreeService.loadProject(project.path, windowId);
    // Observed at the await below; without this a load rejection while the
    // swap is still in flight would be an unhandled rejection.
    loadWorktrees.catch(() => {});
  }

  // Multi-view path: swap WebContentsViews instead of resetting stores
  let swapResult: { view: Electron.WebContentsView; isNew: boolean };
  try {
    swapResult = await pvm.switchTo(projectId, project.path);
  } catch (error) {
    // The swap failed and rolled back to the previous view, but the early
    // loadProject may have already pointed windowToProject at the failed
    // target — the exact cross-project contamination loadProject exists to
    // prevent. Once the failed load settles (and only if no newer switch has
    // claimed the window since), re-point the mapping at the still-visible
    // previous project (cheap for its warm host); with no previous project to
    // restore (first switch from the welcome view, or the previous project
    // was deleted mid-switch) release the window's mapping entirely, undoing
    // the early load's attachment.
    if (loadWorktrees && deps.worktreeService && windowId !== undefined) {
      const worktreeService = deps.worktreeService;
      // Restore THIS window's mapping to the project THIS window was showing —
      // from the captured operation, not the global pointer, which in a second
      // window names someone else's project and would re-point the mapping at it.
      //
      // Deliberately NOT pvm.getActiveProjectId(): the rollback it performs on a
      // cold-start failure looks like the right answer, but a warm activation
      // that throws leaves the INCOMING project active with no rollback, and the
      // manager itself may be another window's under the deps fallback (#11100).
      // The captured id is the one thing here that cannot be wrong about which
      // window sent the request.
      const previousPath = outgoingProjectId
        ? projectStore.getProjectById(outgoingProjectId)?.path
        : undefined;
      void loadWorktrees
        .catch(() => {})
        .then(() => {
          if (windowSwitchEpochs.get(windowId) !== switchEpoch) return undefined;
          if (previousPath === project.path) return undefined; // mapping already correct
          if (previousPath) {
            return worktreeService.loadProject(previousPath, windowId);
          }
          worktreeService.unregisterWindow(windowId);
          return undefined;
        })
        .catch((restoreError) => {
          console.error(
            `${options.logPrefix} Failed to restore worktree mapping after swap failure:`,
            restoreError
          );
        });
    }
    throw error;
  }
  const { view, isNew } = swapResult;
  const swapMs = Math.round(performance.now() - activateStart);

  // Fold the completed switch into this window's project history. Recorded here
  // — after the view swap has actually committed — because this is the path
  // every real switch takes: `ProjectSwitchService` only runs on the legacy
  // non-PVM fallback, so recording there alone left history empty in normal
  // use. `windowId` comes from the captured operation, so a second window
  // records into its own list rather than the first window's.
  //
  // The outgoing project is recorded first, so it lands directly behind the
  // incoming one and becomes the toggle target. Nothing else records the
  // project a window opens on — that load never reaches this path — so without
  // it the most common flow of all, open on A and switch to B, would leave the
  // toggle with nowhere to go.
  if (windowId !== undefined) {
    const history = getProjectHistory(windowId);
    if (outgoingProjectId) history.record(outgoingProjectId);
    history.record(projectId);
  }

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

  // Update the main process global state. The outgoing id comes from the
  // captured operation: re-reading it here would be too late anyway (switchTo
  // above has already flipped the PVM's active project) and, with a second
  // window open, would background whichever project that window is still
  // displaying while never backgrounding this window's own (#11101).
  await projectStore.setCurrentProject(projectId, outgoingProjectId);

  // Re-persist which project each window is showing (#11492). Placed after the
  // PVM swap above rather than alongside it because the manifest is built from
  // `getActiveProjectId()` across every window — it has to read the committed
  // state, not the switch that is still landing. Debounced, so a burst of
  // switches collapses to one write.
  scheduleOpenWindowsSave();

  if (options.markActive) {
    projectStore.updateProjectStatus(projectId, "active");
  }

  // Push the persisted `lastOpened`/`status` updates to every renderer.
  // `setCurrentProject` writes both the departing and activated rows inside a
  // single transaction but does not emit IPC; without this broadcast, cached
  // WebContentsView stores keep stale MRU timestamps and the next
  // `Cmd+Alt+=` / project switcher pick targets the wrong project. Same
  // outgoing id the transaction just used, so the broadcast mirrors exactly
  // what was written (#8563).
  broadcastProjectSwitchUpdates(outgoingProjectId, projectId);

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

  // Settle the worktree load started alongside the swap. Calling loadProject
  // on every switch keeps the WorkspaceClient's windowToProject mapping
  // pointing at the correct project — without it, reactivating a cached view
  // leaves the mapping on the *previous* project, causing sendToEntryWindows
  // to route the old project's IPC events to the newly-active view
  // (cross-project worktree contamination).
  if (deps.worktreeService) {
    if (loadWorktrees && windowId !== undefined) {
      // Forward-fail: the view swap already committed to the new project, so a
      // load failure surfaces as a Tier 3 recovery banner rather than reverting
      // (#8400). Send a targeted status to *this* view only (broadcastToRenderer
      // would also hit LRU-cached other-project views); null on success clears a
      // stale banner when a previously-failed view is reactivated successfully.
      let worktreeLoadError: string | null = null;
      try {
        await loadWorktrees;

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

  // Switch-settle telemetry: `swapMs` is the view swap (reveal path), the
  // remainder to `totalMs` is the post-swap tail — now dominated by however
  // much of the concurrent worktree load outlived the swap.
  logInfo("projectswitch.settled", {
    projectId,
    isNew,
    swapMs,
    totalMs: Math.round(performance.now() - activateStart),
  });
}
