import { existsSync, statSync } from "fs";
import { rename } from "fs/promises";
import path from "path";
import type { BrowserWindow, WebContents } from "electron";
import { CHANNELS } from "../ipc/channels.js";
import { broadcastToRenderer } from "../ipc/utils.js";
import { projectStore, normalizeProjectPath } from "./ProjectStore.js";
import { collectActiveProjectIds, projectViewManagersFrom } from "../window/activeProjectIds.js";
import { writeHibernatedMarker } from "./pty/terminalSessionPersistence.js";
import { logError, logInfo } from "../utils/logger.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import type { PtyClient } from "./PtyClient.js";
import type { WorkspaceClient } from "./WorkspaceClient.js";
import type { WindowRegistry, WindowContext } from "../window/WindowRegistry.js";
import type { WorktreePortBroker } from "./WorktreePortBroker.js";
import type { Project } from "../types/index.js";

/**
 * Relocating a currently-OPEN project (#11282, phase 3).
 *
 * Phases 1/2 preserve project identity and rebase persisted path-bearing state,
 * but they deliberately REFUSE the active project: repointing a live one would
 * strand its `WebContentsView`, workspace host and PTYs on the old path. This
 * coordinator is the quiesce-and-rebind pipeline that makes an open relocation
 * safe — and the same pipeline performs a Daintree-MANAGED move (`fs.rename`)
 * rather than only reattaching after an external one.
 *
 * The renderer is repointed LIVE: the project path was engineered out of the
 * view's URL/argv (#9162), so a `PROJECT_UPDATED` broadcast + an in-place store
 * rebase is enough — the React tree and xterm instances are never torn down.
 *
 * `fs.rename` is the single commit boundary. Before it, a failure rolls back by
 * reopening the runtimes at the original path (nothing durable changed). After
 * it, every remaining step is forward-only — PTY kills and host disposal can't
 * be cleanly reversed, so a failure surfaces the Tier-3 worktree-load banner
 * (whose existing Retry re-runs the reopen at the now-current path) rather than
 * renaming backward (#8473).
 */

/** Phase 3 only implements `"refuse"`; the `"hibernate"` continuity path (which
 * tears down the Assistant's whole sub-agent tree) is deferred to phase 4/5. */
export type AssistantDisposition = "refuse";

export type ProjectRelocationReason =
  | "not-found"
  | "in-progress"
  | "cross-volume"
  | "assistant-active"
  | "invalid-destination"
  | "destination-exists"
  | "same-path";

export class ProjectRelocationError extends Error {
  constructor(
    readonly reason: ProjectRelocationReason,
    message: string
  ) {
    super(message);
    this.name = "ProjectRelocationError";
  }
}

export interface ProjectRelocationDeps {
  ptyClient?: PtyClient;
  worktreeService?: WorkspaceClient;
  windowRegistry?: WindowRegistry;
  worktreePortBroker?: WorktreePortBroker;
  mainWindow?: BrowserWindow;
}

export interface RelocateProjectRequest {
  projectId: string;
  /**
   * `"move"` performs the `fs.rename` (Daintree-managed, same-volume only for
   * the first cut). `"reattach"` adopts a folder already sitting at `newPath`
   * (moved externally).
   */
  mode: "move" | "reattach";
  /** Managed move: the full destination root. Reattach: where the folder is now. */
  newPath: string;
  assistantDisposition?: AssistantDisposition;
}

interface TargetWindow {
  windowId: number;
  ctx: WindowContext;
}

export class ProjectRelocationCoordinator {
  private deps: ProjectRelocationDeps = {};
  private readonly relocating = new Set<string>();

  configure(deps: ProjectRelocationDeps): void {
    this.deps = deps;
  }

  isRelocating(projectId: string): boolean {
    return this.relocating.has(projectId);
  }

  /**
   * Relocate a project. Routes an OPEN project (visible in any window) through
   * the quiesce/rebind pipeline; a closed reattach delegates to the existing
   * phase-1/2 `ProjectStore.relocateProject` (already correct for a project with
   * no live runtimes). Broadcasts the final `PROJECT_UPDATED` in both branches.
   */
  async relocate(request: RelocateProjectRequest): Promise<Project> {
    const { projectId, mode } = request;
    const disposition = request.assistantDisposition ?? "refuse";

    // --- Establish ownership SYNCHRONOUSLY, before the first await: whether this
    // project is open, and which windows show it, must not shift under a
    // concurrent switch/close (#11131 TOCTOU).
    const project = projectStore.getProjectById(projectId);
    if (!project) {
      throw new ProjectRelocationError("not-found", `Project not found: ${projectId}`);
    }
    if (this.relocating.has(projectId)) {
      throw new ProjectRelocationError(
        "in-progress",
        `A relocation is already running for "${project.name}".`
      );
    }
    const openAtEntry = collectActiveProjectIds(
      projectViewManagersFrom(this.deps.windowRegistry),
      projectStore.getCurrentProjectId(),
      "project-relocation"
    ).has(projectId);
    const targetWindows = openAtEntry ? this.snapshotWindowsShowingProject(projectId) : [];

    // Closed reattach: the folder is already on disk and nothing is live, so the
    // phase-1/2 path is correct as-is — no need to spin up the quiesce machinery.
    if (mode === "reattach" && !openAtEntry) {
      const relocated = await projectStore.relocateProject(projectId, request.newPath);
      broadcastToRenderer(CHANNELS.PROJECT_UPDATED, relocated);
      return relocated;
    }

    this.relocating.add(projectId);
    try {
      return await this.runPipeline(project, request, disposition, targetWindows);
    } finally {
      this.relocating.delete(projectId);
      projectStore.endRelocationRewrite(projectId);
    }
  }

  private async runPipeline(
    project: Project,
    request: RelocateProjectRequest,
    disposition: AssistantDisposition,
    targetWindows: TargetWindow[]
  ): Promise<Project> {
    const { projectId, mode } = request;
    const oldRoot = project.path;

    // --- Assistant guard. Killing the Assistant's PTY tears down its whole
    // sub-agent tree (a security-boundary action, #7509); phase 3 refuses rather
    // than silently destroying in-flight agent work. Phase 4/5 own hibernate.
    if (disposition === "refuse" && (await getAssistantBackend(projectId))) {
      throw new ProjectRelocationError(
        "assistant-active",
        "Stop the Daintree Assistant for this project before moving it."
      );
    }

    // --- Preflight: ALL validation before anything is stopped.
    let requestedNewRoot = normalizeProjectPath(request.newPath);
    if (mode === "move") {
      requestedNewRoot = this.validateManagedMove(oldRoot, request.newPath);
    } else if (!existsSync(request.newPath)) {
      throw new ProjectRelocationError(
        "invalid-destination",
        `The folder to reattach doesn't exist: ${request.newPath}`
      );
    }

    // --- Quiesce the project's live runtimes (borrowed from `project:free-memory`
    // MINUS the renderer eviction — keeping the view + xterm alive is the point).
    await this.quiesceProject(projectId, oldRoot);

    // --- Arm the state-write guard so a late renderer layout write can't clobber
    // the migration once we cross the boundary.
    projectStore.beginRelocationRewrite(projectId, oldRoot, requestedNewRoot);

    // ===================== COMMIT BOUNDARY (fs.rename) =====================
    // Above this try/catch: rollback is safe. A managed move's rename is the
    // point of no return — everything after it is forward-only, never a reverse
    // rename. A reattach is already disk-committed at entry, so it has no
    // pre-commit window to roll back.
    if (mode === "move") {
      try {
        await rename(oldRoot, requestedNewRoot);
      } catch (error) {
        // Pre-commit failure: nothing durable changed. Reopen at the ORIGINAL
        // path so the user is left exactly where they started.
        projectStore.endRelocationRewrite(projectId);
        await this.reopenProjectAtPath(projectId, oldRoot, targetWindows);
        throw new ProjectRelocationError(
          "invalid-destination",
          formatErrorMessage(error, "Couldn't move the project folder")
        );
      }
    }

    // --- Finalize durable state (DB path + phase-2 migration + git/submodule
    // repair), PRESERVING the project's status so an open project stays open.
    const updated = await projectStore.finalizeRelocatedPath({
      projectId,
      expectedOldPath: oldRoot,
      newPath: requestedNewRoot,
      status: project.status,
    });
    const newRoot = updated.path;
    // Re-align the write guard with the canonicalized root.
    projectStore.beginRelocationRewrite(projectId, oldRoot, newRoot);

    // --- Repoint every cached view's `ViewEntry.projectPath` on its switchChain.
    await this.rebindViews(projectId, newRoot);

    // --- Live-repoint the renderer: replaces the project by id and (with the
    // phase-3 renderer change) rebases the live panel/worktree stores in place.
    broadcastToRenderer(CHANNELS.PROJECT_UPDATED, updated);

    // --- Reopen the workspace host / worktree feed / PTY context at the new
    // path. Forward-fail: a failure here shows the Tier-3 banner (Retry re-runs
    // loadProject at the now-current path) rather than reverting the move.
    await this.reopenProjectAtPath(projectId, newRoot, targetWindows);

    logInfo("project.relocated", { projectId, mode });
    return updated;
  }

  /**
   * Reject a managed move we can't perform atomically, and return the normalized
   * destination root. Same-volume only for the first cut: a same-volume rename
   * is O(1)/atomic on APFS; a cross-volume move is a non-atomic copy (out of
   * scope). The destination must not exist yet, and its parent must.
   */
  private validateManagedMove(oldRootRaw: string, newPathRaw: string): string {
    if (!newPathRaw || !path.isAbsolute(newPathRaw)) {
      throw new ProjectRelocationError(
        "invalid-destination",
        "The destination must be an absolute path."
      );
    }
    const oldRoot = normalizeProjectPath(oldRootRaw);
    const newRoot = normalizeProjectPath(newPathRaw);
    if (newRoot === oldRoot) {
      throw new ProjectRelocationError(
        "same-path",
        "The destination is the project's current folder."
      );
    }
    if (newRoot.startsWith(oldRoot + path.sep)) {
      throw new ProjectRelocationError(
        "invalid-destination",
        "Can't move a project into its own subfolder."
      );
    }
    if (existsSync(newRoot)) {
      throw new ProjectRelocationError(
        "destination-exists",
        `Something already exists at ${newRoot}.`
      );
    }
    const parent = path.dirname(newRoot);
    let parentStat: ReturnType<typeof statSync>;
    try {
      parentStat = statSync(parent);
    } catch {
      throw new ProjectRelocationError(
        "invalid-destination",
        `The destination's parent folder doesn't exist: ${parent}.`
      );
    }
    if (!parentStat.isDirectory()) {
      throw new ProjectRelocationError(
        "invalid-destination",
        `The destination's parent isn't a folder: ${parent}.`
      );
    }
    // Same-volume check: compare the OLD root's device with the destination
    // PARENT's (the new root doesn't exist yet). Cheap + synchronous — refuse
    // before we stop anything.
    let oldDev: number;
    try {
      oldDev = statSync(oldRoot).dev;
    } catch (error) {
      throw new ProjectRelocationError(
        "invalid-destination",
        formatErrorMessage(error, "Couldn't inspect the project folder")
      );
    }
    if (oldDev !== parentStat.dev) {
      throw new ProjectRelocationError(
        "cross-volume",
        "Moving across volumes isn't supported yet — the destination is on a different disk."
      );
    }
    return newRoot;
  }

  private async quiesceProject(projectId: string, oldRoot: string): Promise<void> {
    const { ptyClient, worktreeService } = this.deps;
    // Graceful, session-preserving PTY kill. Capture agent session ids (retained
    // for phase-5 continuity) and write hibernation markers so a reopen/restart
    // resumes rather than starting cold. Snapshot flush already happens inside
    // TerminalProcess.kill() (#3177) — do NOT add another here.
    if (ptyClient) {
      const killed = await ptyClient.gracefulKillByProject(projectId, { preserveSession: true });
      for (const terminal of killed) writeHibernatedMarker(terminal.id);
    }
    // Force-drop the workspace host rooted at the OLD path, bypassing the
    // refCount guard the open window holds (the folder is moving out from under
    // it). Respawned at the new path by the reopen's loadProject. The renderer
    // view is deliberately NOT evicted.
    worktreeService?.evictProjectForRelocation(oldRoot);
  }

  /** Repoint `ViewEntry.projectPath` on every window's cached/active view. */
  private async rebindViews(projectId: string, newRoot: string): Promise<void> {
    const registry = this.deps.windowRegistry;
    if (!registry) return;
    for (const ctx of registry.all()) {
      const pvm = ctx.services.projectViewManager;
      if (!pvm) continue;
      try {
        await pvm.rebindProjectPath(projectId, newRoot);
      } catch (error) {
        logError("relocate-rebind-view-failed", error, { projectId, windowId: ctx.windowId });
      }
    }
  }

  /**
   * Reopen the workspace host + worktree feed + PTY context at `root` for each
   * window that was showing the project — the post-swap subset of
   * `activateProjectView` (no view swap, since the view stays on-screen).
   */
  private async reopenProjectAtPath(
    projectId: string,
    root: string,
    targetWindows: TargetWindow[]
  ): Promise<void> {
    const { worktreeService, ptyClient, worktreePortBroker } = this.deps;
    for (const { windowId, ctx } of targetWindows) {
      const view = ctx.services.projectViewManager?.views.get(projectId)?.view;
      const wc: WebContents | undefined = view?.webContents;
      const live = wc && !wc.isDestroyed() ? wc : null;

      // Repoint the PTY host's active project/path for this window so future
      // spawns land at the new root.
      try {
        ptyClient?.onProjectSwitch(windowId, projectId, root);
      } catch (error) {
        logError("relocate-onProjectSwitch-failed", error, { projectId, windowId });
      }

      let worktreeLoadError: string | null = null;
      if (worktreeService) {
        try {
          await worktreeService.loadProject(root, windowId);
          if (live) {
            worktreeService.attachDirectPort(windowId, live);
            const host = worktreeService.getHostForProject(root);
            if (host && worktreePortBroker) worktreePortBroker.brokerPort(host, live);
          }
        } catch (error) {
          worktreeLoadError = formatErrorMessage(error, "Failed to load worktrees");
          logError("relocate-load-project-failed", error, { projectId, windowId });
        }
      }

      if (live) {
        live.send(CHANNELS.PROJECT_WORKTREE_LOAD_STATUS, { projectId, worktreeLoadError });
      }
    }
  }

  private snapshotWindowsShowingProject(projectId: string): TargetWindow[] {
    const registry = this.deps.windowRegistry;
    if (!registry) return [];
    const result: TargetWindow[] = [];
    for (const ctx of registry.all()) {
      if (ctx.services.projectViewManager?.getActiveProjectId() === projectId) {
        result.push({ windowId: ctx.windowId, ctx });
      }
    }
    return result;
  }
}

/**
 * Read the Assistant backend for a project, if one is live. Dynamically imported
 * to avoid pulling the heavy HelpSessionService into this module's eval graph
 * (the IPC layer loads it lazily too).
 */
async function getAssistantBackend(
  projectId: string
): Promise<{ terminalId: string; webContentsId: number } | null> {
  try {
    const { helpSessionService } = await import("./HelpSessionService.js");
    return helpSessionService.getAssistantBackend(projectId);
  } catch (error) {
    logError("relocate-assistant-check-failed", error, { projectId });
    return null;
  }
}

export const projectRelocationCoordinator = new ProjectRelocationCoordinator();
