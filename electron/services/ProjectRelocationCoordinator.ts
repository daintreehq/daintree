import { existsSync, lstatSync, statSync } from "fs";
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
import type { WindowRegistry } from "../window/WindowRegistry.js";
import type { WorktreePortBroker } from "./WorktreePortBroker.js";
import type { Project } from "../types/index.js";
import {
  CONTINUITY_TIER_ORDER,
  type AgentContinuitySummary,
  type ProjectRelocationReason,
  type RelocationBlocker,
  type RelocationPreview,
} from "../../shared/types/projectRelocation.js";
import {
  getEffectiveAgentConfig,
  resolveAgentContinuity,
} from "../../shared/config/agentRegistry.js";

export type { ProjectRelocationReason } from "../../shared/types/projectRelocation.js";

// How long the state-write rewrite guard lingers after a relocation resolves, to
// absorb a renderer layout write debounced with the old root (the persistence
// debounce is ~500ms; this comfortably outlasts it).
const RELOCATION_GUARD_GRACE_MS = 3000;

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
}

export class ProjectRelocationCoordinator {
  private deps: ProjectRelocationDeps = {};
  private readonly relocating = new Set<string>();
  private readonly guardReleaseTimers = new Map<string, ReturnType<typeof setTimeout>>();

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

    // Establish ownership SYNCHRONOUSLY, before the first await: whether this
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

    // Reserve BEFORE any branch so a concurrent relocation of the same project —
    // closed-delegate or pipeline — is rejected, not interleaved.
    this.relocating.add(projectId);
    try {
      // Closed reattach: the folder is already on disk and nothing is live, so
      // the phase-1/2 path is correct as-is — no quiesce machinery needed.
      if (mode === "reattach" && !openAtEntry) {
        const relocated = await projectStore.relocateProject(projectId, request.newPath);
        broadcastToRenderer(CHANNELS.PROJECT_UPDATED, relocated);
        return relocated;
      }
      return await this.runPipeline(project, request, disposition, targetWindows);
    } finally {
      this.relocating.delete(projectId);
      // Hold the state-write rewrite a beat past the operation: a renderer layout
      // write debounced with the old root can land after `relocate` resolves, and
      // must still be rebased. Released only if no newer relocation re-armed it.
      this.scheduleGuardRelease(projectId);
    }
  }

  /**
   * Read-only description of what a relocation WOULD do (#11282, phase 4). Runs
   * the same preflight checks as {@link relocate} but converts each into a typed
   * `blocker` instead of throwing, and enumerates the affected state — running
   * terminals, linked worktrees, panels whose stored paths would be rewritten —
   * without touching the filesystem, PTYs, hosts, views, or persisted state.
   *
   * Blockers ride the SUCCESSFUL result: a `ProjectRelocationError.reason` does
   * not survive IPC error serialization, so the renderer dialog gets structured
   * `{ reason, message }` to gate its confirm button on. `apply` re-validates —
   * the preview is a description, never an authorization.
   */
  async previewRelocate(request: RelocateProjectRequest): Promise<RelocationPreview> {
    const { projectId, mode } = request;

    const project = projectStore.getProjectById(projectId);
    if (!project) {
      throw new ProjectRelocationError("not-found", `Project not found: ${projectId}`);
    }
    const oldPath = project.path;
    // Resolve ownership SYNCHRONOUSLY before any await (#11131), mirroring
    // `relocate`. `apply` only quiesces (kills terminals, refuses on an active
    // Assistant) when it runs `runPipeline` — every move, plus a reattach of an
    // OPEN project. A reattach of a closed/missing project delegates straight to
    // `ProjectStore.relocateProject`, which touches no runtimes, so the preview
    // must NOT claim terminals will stop or block on a (possibly stale) Assistant
    // record there.
    const openAtEntry = collectActiveProjectIds(
      projectViewManagersFrom(this.deps.windowRegistry),
      projectStore.getCurrentProjectId(),
      "project-relocation-preview"
    ).has(projectId);
    const usesPipeline = mode === "move" || openAtEntry;

    const blockers: RelocationBlocker[] = [];
    const pushBlocker = (error: unknown): void => {
      if (error instanceof ProjectRelocationError) {
        blockers.push({ reason: error.reason, message: error.message });
      } else {
        throw error;
      }
    };

    if (this.relocating.has(projectId)) {
      blockers.push({
        reason: "in-progress",
        message: `A relocation is already running for "${project.name}".`,
      });
    }

    // Resolve + validate the destination without side effects.
    let newPath = normalizeProjectPath(request.newPath);
    if (mode === "move") {
      try {
        newPath = this.validateManagedMove(oldPath, request.newPath);
      } catch (error) {
        pushBlocker(error);
      }
    } else if (!existsSync(request.newPath)) {
      blockers.push({
        reason: "invalid-destination",
        message: `The folder to reattach doesn't exist: ${request.newPath}`,
      });
    }

    // A destination already registered to a DIFFERENT project blocks either mode.
    const conflict = await projectStore.getProjectByPath(newPath);
    if (conflict && conflict.id !== projectId) {
      blockers.push({
        reason: "destination-exists",
        message: `Another project ("${conflict.name}") is already registered at that location.`,
      });
    }

    // Assistant guard, fail-closed — mirrors runPipeline's check but as a blocker.
    // Only relevant when apply will quiesce (the pipeline path); a closed reattach
    // never stops the Assistant, so blocking on it there would be a phantom.
    if (usesPipeline) {
      try {
        const assistantActive = await hasAssistantBackend(projectId);
        if (assistantActive) {
          blockers.push({
            reason: "assistant-active",
            message: "Stop the Daintree Assistant for this project before moving it.",
          });
        }
      } catch (error) {
        logError("relocate-preview-assistant-check-failed", error, { projectId });
        blockers.push({
          reason: "assistant-active",
          message:
            "Couldn't check the Daintree Assistant for this project — stop it and try again.",
        });
      }
    }

    // Read-only enumeration. The folder sits at `oldPath` for a not-yet-run move
    // and at `request.newPath` for an already-moved reattach. Only the pipeline
    // path gracefully stops terminals, so a closed reattach reports zero.
    const folderPath = mode === "reattach" ? request.newPath : oldPath;
    const emptyTerminals = { count: 0, agentContinuity: [] as AgentContinuitySummary[] };
    const [terminals, linkedWorktrees, affectedPanelCount] = await Promise.all([
      usesPipeline ? this.describeRunningTerminals(projectId) : Promise.resolve(emptyTerminals),
      this.listLinkedWorktrees(folderPath),
      projectStore.countRebasedPanels(projectId, oldPath, newPath),
    ]);

    return {
      mode,
      oldPath,
      newPath,
      runningTerminalCount: terminals.count,
      agentContinuity: terminals.agentContinuity,
      linkedWorktrees,
      affectedPanelCount,
      blockers,
    };
  }

  /**
   * Enumerate the running terminals a relocation would gracefully stop, plus a
   * per-agent conversation-continuity breakdown (#11282, phase 5). The pty-host
   * already groups a project's live terminals by `launchAgentId`
   * (`getProjectStats().terminalTypes`, already project-scoped and trash/exit
   * excluded), so we classify each agent type live against the registry — no
   * per-terminal session-id plumbing, and no captured tier (which would go
   * stale). We key on `launchAgentId`, so a terminal only *detected* as an agent
   * after a plain-shell launch is classified as a shell — an accepted
   * best-effort limit for an advisory preview. Plain (non-agent) terminals key
   * on `"terminal"` and are excluded since they carry no conversation. Ordered
   * riskiest-first ({@link CONTINUITY_TIER_ORDER}) so the user sees what won't
   * survive before what will. Best-effort: an IPC failure reports zero rather
   * than throwing.
   */
  private async describeRunningTerminals(
    projectId: string
  ): Promise<{ count: number; agentContinuity: AgentContinuitySummary[] }> {
    const { ptyClient } = this.deps;
    if (!ptyClient) return { count: 0, agentContinuity: [] };
    try {
      const stats = await ptyClient.getProjectStats(projectId);
      const byAgent = stats.terminalTypes ?? {};
      const agentContinuity = Object.entries(byAgent)
        // Exclude plain shells, and defend against a corrupted count: a custom
        // agent named after an Object.prototype key (e.g. "toString") can make
        // the upstream tally a non-number, which must never reach the preview.
        .filter(([agentId, count]) => agentId !== "terminal" && Number.isFinite(count) && count > 0)
        .map(([agentId, count]): AgentContinuitySummary => {
          const { tier, detail } = resolveAgentContinuity(agentId);
          return {
            agentId,
            agentName: getEffectiveAgentConfig(agentId)?.name ?? agentId,
            count,
            tier,
            ...(detail !== undefined ? { detail } : {}),
          };
        })
        // Riskiest tier first, then agent id — deterministic regardless of the
        // pty-host's Object key order.
        .sort(
          (a, b) =>
            CONTINUITY_TIER_ORDER[a.tier] - CONTINUITY_TIER_ORDER[b.tier] ||
            a.agentId.localeCompare(b.agentId)
        );
      return { count: stats.terminalCount, agentContinuity };
    } catch (error) {
      logError("relocate-preview-terminal-describe-failed", error, { projectId });
      return { count: 0, agentContinuity: [] };
    }
  }

  private async listLinkedWorktrees(folderPath: string): Promise<string[]> {
    try {
      // Dynamic import keeps GitService (and simple-git) out of the coordinator's
      // eval graph, matching how the Assistant backend is loaded lazily below.
      const { GitService } = await import("./GitService.js");
      const worktrees = await new GitService(folderPath).listWorktrees();
      return worktrees.filter((w) => !w.isMainWorktree).map((w) => w.path);
    } catch {
      // A repo we can't enumerate (folder missing, not a git repo) simply reports
      // no linked worktrees — the preview stays best-effort, never fatal.
      return [];
    }
  }

  private scheduleGuardRelease(projectId: string): void {
    // Cancel any pending release so only the LATEST relocation's timer survives —
    // otherwise an older timer could fire after a newer relocation re-armed the
    // guard and delete it before that relocation's own grace expired.
    const existing = this.guardReleaseTimers.get(projectId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.guardReleaseTimers.delete(projectId);
      if (!this.relocating.has(projectId)) projectStore.endRelocationRewrite(projectId);
    }, RELOCATION_GUARD_GRACE_MS);
    timer.unref?.();
    this.guardReleaseTimers.set(projectId, timer);
  }

  private async runPipeline(
    project: Project,
    request: RelocateProjectRequest,
    disposition: AssistantDisposition,
    targetWindows: TargetWindow[]
  ): Promise<Project> {
    const { projectId, mode } = request;
    const oldRoot = project.path;

    // Assistant guard, FAIL-CLOSED. Killing the Assistant's PTY tears down its
    // whole sub-agent tree (a security-boundary action, #7509); phase 3 refuses
    // rather than silently destroying in-flight agent work. A failed check is
    // treated as "may be active" — never as "clear". Phase 4/5 own hibernate.
    if (disposition === "refuse") {
      let assistantActive: boolean;
      try {
        assistantActive = await hasAssistantBackend(projectId);
      } catch (error) {
        logError("relocate-assistant-check-failed", error, { projectId });
        throw new ProjectRelocationError(
          "assistant-active",
          "Couldn't check the Daintree Assistant for this project — stop it and try again."
        );
      }
      if (assistantActive) {
        throw new ProjectRelocationError(
          "assistant-active",
          "Stop the Daintree Assistant for this project before moving it."
        );
      }
    }

    // Preflight: ALL validation before anything is stopped.
    let requestedNewRoot = normalizeProjectPath(request.newPath);
    if (mode === "move") {
      requestedNewRoot = this.validateManagedMove(oldRoot, request.newPath);
    } else if (!existsSync(request.newPath)) {
      throw new ProjectRelocationError(
        "invalid-destination",
        `The folder to reattach doesn't exist: ${request.newPath}`
      );
    }

    // Refuse a destination already registered to a DIFFERENT project BEFORE
    // touching anything — otherwise a managed move could rename the folder into
    // place and only then discover the conflict at finalize, stranding one
    // project's folder under another's row (`getProjectByPath` compares the
    // stored path without needing the folder to exist yet, so this is safe
    // pre-rename).
    const conflict = await projectStore.getProjectByPath(requestedNewRoot);
    if (conflict && conflict.id !== projectId) {
      throw new ProjectRelocationError(
        "destination-exists",
        `Another project ("${conflict.name}") is already registered at that location.`
      );
    }

    // Quiesce the project's live runtimes (borrowed from `project:free-memory`
    // minus the renderer eviction — keeping the view + xterm alive is the point).
    await this.quiesceProject(projectId, oldRoot);

    // Arm the state-write guard so a late renderer layout write can't clobber the
    // migration once we cross the boundary.
    projectStore.beginRelocationRewrite(projectId, oldRoot, requestedNewRoot);

    // fs.rename is the commit boundary. Before this try/catch a failure rolls
    // back (reopen at the original path; nothing durable changed). A managed
    // move's rename is the point of no return — everything after is forward-only,
    // never a reverse rename. A reattach is already disk-committed at entry.
    if (mode === "move") {
      try {
        await rename(oldRoot, requestedNewRoot);
      } catch (error) {
        // Pre-commit failure. The quiesce did kill this project's PTYs (their
        // sessions are preserved and restartable) and dropped the host, so this
        // is a non-destructive reopen at the original path, not a perfect
        // undo — reopen restores the workspace host + worktree feed there.
        projectStore.endRelocationRewrite(projectId);
        await this.reopenProjectAtPath(projectId, oldRoot, targetWindows);
        throw new ProjectRelocationError(
          "invalid-destination",
          formatErrorMessage(error, "Couldn't move the project folder")
        );
      }
    }

    // Finalize durable state (DB path + phase-2 migration + git/submodule repair),
    // PRESERVING the project's status so an open project stays open.
    let updated: Project;
    try {
      updated = await projectStore.finalizeRelocatedPath({
        projectId,
        expectedOldPath: oldRoot,
        newPath: requestedNewRoot,
        status: project.status,
      });
    } catch (error) {
      // Post-commit: the folder is at the new root but the DB update failed. Do
      // NOT reverse the rename. The row still points at the (now-missing) old
      // path, so the project surfaces as "missing" and the user can re-locate it
      // at the new path — the reattach flow, which will now succeed.
      logError("relocate-finalize-failed-after-move", error, {
        projectId,
        oldRoot,
        newRoot: requestedNewRoot,
      });
      // Build the message directly: `formatErrorMessage` returns the cause's own
      // message for a normal Error and would drop the actionable guidance, so
      // append the cause rather than passing it as the fallback.
      const cause = formatErrorMessage(error, "unknown error");
      throw new ProjectRelocationError(
        "invalid-destination",
        `The folder moved to ${requestedNewRoot} but updating the project failed — re-locate it there (${cause})`
      );
    }
    const newRoot = updated.path;
    // Re-align the write guard with the canonicalized root.
    projectStore.beginRelocationRewrite(projectId, oldRoot, newRoot);

    // Repoint every cached view's `ViewEntry.projectPath` on its switchChain.
    await this.rebindViews(projectId, newRoot);

    // Live-repoint the renderer: replaces the project by id and (with the phase-3
    // renderer change) rebases the live panel/worktree stores in place.
    broadcastToRenderer(CHANNELS.PROJECT_UPDATED, updated);

    // Reopen the workspace host / worktree feed / PTY context at the new path.
    // Forward-fail: a failure here shows the Tier-3 banner (Retry re-runs
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
      // On a case-insensitive volume (APFS by default, NTFS) a case-only rename
      // (`Foo` → `foo`) resolves BOTH spellings to the same inode, so
      // `existsSync(newRoot)` is a false positive — it's the project's OWN
      // folder being re-cased, not a different item colliding. Allow it only
      // when the roots differ by case alone AND both stat to the same
      // device+inode; a genuinely different folder — or a case-SENSITIVE volume
      // where `Foo` and `foo` coexist as distinct dirs — still blocks. Inode is
      // unreliable (0/undefined) on some Windows volumes, so anything short of a
      // real integer inode match falls through to the block: refusing an exotic
      // case-only rename is safe, silently merging two folders is not.
      const caseOnly = newRoot.toLowerCase() === oldRoot.toLowerCase();
      let sameItem = false;
      if (caseOnly) {
        try {
          // lstat, NOT stat: a destination that is a symlink pointing back at the
          // project (`/x/foo` → `/x/Foo` on a case-sensitive volume) would share
          // the target's inode under stat and be wrongly treated as "the same
          // item"; lstat compares the symlink entry itself, so it stays blocked.
          const src = lstatSync(oldRoot);
          const dst = lstatSync(newRoot);
          sameItem =
            typeof src.ino === "number" &&
            src.ino !== 0 &&
            src.ino === dst.ino &&
            src.dev === dst.dev;
        } catch {
          sameItem = false;
        }
      }
      if (!sameItem) {
        throw new ProjectRelocationError(
          "destination-exists",
          `Something already exists at ${newRoot}.`
        );
      }
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
    const { worktreeService, ptyClient, worktreePortBroker, windowRegistry } = this.deps;
    for (const { windowId } of targetWindows) {
      // Re-resolve the window from the LIVE registry, not the entry snapshot: the
      // user may have switched it to another project (or closed it) while we
      // awaited. Reopening a window that no longer shows this project would
      // cross-route another project's PTY port / worktree feed (#11101).
      const ctx = windowRegistry?.getByWindowId(windowId);
      const pvm = ctx?.services.projectViewManager;
      if (!pvm || pvm.getActiveProjectId() !== projectId) continue;

      const wc: WebContents | undefined = pvm.views.get(projectId)?.view?.webContents;
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
          // Re-check AFTER the load await: a switch during loadProject could have
          // moved this window to another project, and attaching our (now
          // background) view's port to the window's new workspace entry would
          // cross-route it. Skip the port wiring if that happened.
          const stillShowing =
            windowRegistry
              ?.getByWindowId(windowId)
              ?.services.projectViewManager?.getActiveProjectId() === projectId;
          if (live && stillShowing) {
            worktreeService.attachDirectPort(windowId, live);
            const host = worktreeService.getHostForProject(root);
            if (host && worktreePortBroker && !worktreePortBroker.brokerPort(host, live)) {
              // The reload succeeded but the worktree MessagePort never
              // connected, so the renderer can't fetch its state — surface it as
              // a load failure so the banner + Retry stay (mirrors switch.ts).
              worktreeLoadError =
                "Reloaded the project but couldn't connect to the worktree service";
            }
          }
        } catch (error) {
          worktreeLoadError = formatErrorMessage(error, "Failed to load worktrees");
          logError("relocate-load-project-failed", error, { projectId, windowId });
        }
      }

      if (live) {
        // Best-effort: the view can die between the guard and the send, and a
        // notification failure must not turn a committed move into a rejection.
        try {
          live.send(CHANNELS.PROJECT_WORKTREE_LOAD_STATUS, { projectId, worktreeLoadError });
        } catch (error) {
          logError("relocate-status-send-failed", error, { projectId, windowId });
        }
      }
    }
  }

  private snapshotWindowsShowingProject(projectId: string): TargetWindow[] {
    const registry = this.deps.windowRegistry;
    if (!registry) return [];
    const result: TargetWindow[] = [];
    for (const ctx of registry.all()) {
      if (ctx.services.projectViewManager?.getActiveProjectId() === projectId) {
        result.push({ windowId: ctx.windowId });
      }
    }
    return result;
  }
}

/**
 * Whether the project has any live Assistant backend. Dynamically imported to
 * avoid pulling the heavy HelpSessionService into this module's eval graph
 * (the IPC layer loads it lazily too). THROWS on failure — the caller fails
 * closed (treats an unverifiable Assistant as possibly-active) rather than
 * risking a silent sub-agent-tree kill.
 *
 * Any lane counts (#12108): relocation quiesces the whole project, so one
 * running lane is enough to refuse.
 */
async function hasAssistantBackend(projectId: string): Promise<boolean> {
  const { helpSessionService } = await import("./HelpSessionService.js");
  return helpSessionService.getAssistantBackends(projectId).length > 0;
}

export const projectRelocationCoordinator = new ProjectRelocationCoordinator();
