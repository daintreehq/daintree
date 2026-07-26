// eager-import-allow: reads last-project state via store.get synchronously during project switching
import path from "path";
import type { Project } from "../types/index.js";
import type { HandlerDependencies } from "../ipc/types.js";
import { projectStore, DEFAULT_PROJECT_EMOJI } from "./ProjectStore.js";
import { logBuffer } from "./LogBuffer.js";
import { gitServiceCache } from "./GitServiceCache.js";
import { contextInjectionTracker } from "./ContextInjectionTracker.js";
import { CHANNELS } from "../ipc/channels.js";
import { broadcastToRenderer } from "../ipc/utils.js";
import { broadcastProjectSwitchUpdates } from "../ipc/projectSwitchBroadcast.js";
import { getProjectHistory } from "./ProjectHistoryService.js";
import { randomUUID } from "crypto";
import { store } from "../store.js";
import { PERF_MARKS } from "../../shared/perf/marks.js";
import { markPerformance, withPerformanceSpan } from "../utils/performance.js";
import { buildSwitchHydrateResult } from "./AppHydrationService.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";

export class ProjectSwitchService {
  private deps: HandlerDependencies;
  private switchChain: Promise<void> = Promise.resolve();
  private readonly windowId: number | null;

  constructor(deps: HandlerDependencies) {
    this.deps = deps;
    this.windowId = deps.mainWindow?.id ?? null;
  }

  async switchProject(projectId: string): Promise<Project> {
    const task = this.switchChain.then(() => this.performSwitch(projectId));
    this.switchChain = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }

  private async performSwitch(projectId: string): Promise<Project> {
    const startedAt = Date.now();
    markPerformance(PERF_MARKS.PROJECT_SWITCH_START, { projectId });

    const project = projectStore.getProjectById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    console.log("[ProjectSwitch] Starting project switch to:", project.name);

    const previousProjectId = projectStore.getCurrentProjectId();
    if (previousProjectId === projectId) {
      console.log(
        "[ProjectSwitch] Ignoring switch request for already active project:",
        project.name
      );
      markPerformance(PERF_MARKS.PROJECT_SWITCH_END, {
        projectId,
        durationMs: Date.now() - startedAt,
        noOp: true,
      });
      return project;
    }

    // Fire the outgoing save early so the electron-store fs write overlaps
    // with the SQLite ops below. The method catches its own errors.
    const saveOutgoingPromise = previousProjectId
      ? this.saveOutgoingProjectWorktreeState(previousProjectId)
      : Promise.resolve();

    try {
      const cleanupPromise = withPerformanceSpan(
        PERF_MARKS.PROJECT_SWITCH_CLEANUP,
        () => this.cleanupSupportingServices(projectId, previousProjectId ?? null, project.path),
        { projectId }
      );

      console.log("[ProjectSwitch] Previous project cleanup in progress");

      await projectStore.setCurrentProject(projectId);

      // Apply portable project identity from .daintree/project.json if the user
      // hasn't customised the project name/emoji (still has defaults).
      await this.applyInRepoIdentity(project);

      // Fan out the persisted `lastOpened`/`status` flips to every renderer,
      // including LRU-cached project views. PROJECT_ON_SWITCH below only
      // carries the active project; the departing project's bumped
      // `lastOpened` would otherwise stay stale in cached stores (#8561).
      broadcastProjectSwitchUpdates(previousProjectId, projectId);

      // The legacy non-PVM fallback still has to feed history; the normal path
      // records from `activateProjectView`, which this branch never reaches.
      // Outgoing first so it sits directly behind the incoming project and
      // becomes the toggle target, matching the PVM path.
      if (this.windowId !== null) {
        const history = getProjectHistory(this.windowId);
        if (previousProjectId) history.record(previousProjectId);
        history.record(projectId);
      }

      const updatedProject = projectStore.getProjectById(projectId);
      if (!updatedProject) {
        throw new Error(`Project not found after update: ${projectId}`);
      }

      const [, , loadResult] = await Promise.all([
        saveOutgoingPromise,
        cleanupPromise,
        withPerformanceSpan(
          PERF_MARKS.PROJECT_SWITCH_LOAD_PROJECT,
          () => this.loadNewProject(project),
          { projectId }
        ),
      ]);
      const worktreeLoadError = loadResult?.error;

      const switchId = randomUUID();

      // Pre-build hydration data to embed in the switch payload, eliminating
      // the ~50-150ms IPC round-trip the renderer would otherwise make via
      // appClient.hydrate(). Soft-fail: if the builder throws, broadcast
      // without it and the renderer falls back to the IPC pull model.
      let hydrateResult: import("../../shared/types/ipc/app.js").HydrateResult | undefined;
      try {
        hydrateResult = await buildSwitchHydrateResult(projectId);
      } catch (error) {
        console.warn(
          "[ProjectSwitch] Failed to pre-build hydrate result, renderer will fallback to IPC:",
          error
        );
      }

      broadcastToRenderer(CHANNELS.PROJECT_ON_SWITCH, {
        project: updatedProject,
        switchId,
        ...(worktreeLoadError ? { worktreeLoadError } : {}),
        ...(hydrateResult ? { hydrateResult } : {}),
      });

      // Dedicated load-status event consumed by the renderer's Tier 3 banner
      // (#8400). Mirrors the targeted send on the production view-swap path so
      // both paths drive the same listener; null clears any stale banner.
      broadcastToRenderer(CHANNELS.PROJECT_WORKTREE_LOAD_STATUS, {
        projectId,
        worktreeLoadError: worktreeLoadError ?? null,
      });

      console.log("[ProjectSwitch] Project switch complete, switchId:", switchId);
      return updatedProject;
    } catch (error) {
      // Drain the in-flight save so it can't race with a subsequent switch's
      // write to the same outgoing project state file.
      await saveOutgoingPromise.catch(() => {});
      // No PTY rollback: the project store, git cache, log buffer, and context
      // tracker have already committed to the new project by the time we get
      // here. Reverting only the PTY would leave a split-brain state. Forward-
      // fail to the new project instead and surface the failure to the renderer
      // via the worktreeLoadError payload (see #8400).
      console.error("[ProjectSwitch] Project switch failed:", error);
      throw error;
    } finally {
      markPerformance(PERF_MARKS.PROJECT_SWITCH_END, {
        projectId,
        durationMs: Date.now() - startedAt,
      });
    }
  }

  /**
   * Persist the outgoing project's non-worktree per-project state on switch-away.
   *
   * The active worktree selection is owned by `persistOutgoingProjectState`
   * (project switch IPC handler), which writes the live renderer selection and
   * runs before this method on every switch. This method must NOT re-derive the
   * selection from `appState.activeWorktreeId`: that main-process value lags the
   * renderer by the async `app:set-state` write, so reading it here could
   * resurrect a stale or incidental worktree (e.g. a temporary PR worktree from
   * a batch merge) and clobber the correct value the renderer just persisted
   * (#9512). The existing `activeWorktreeId` is preserved verbatim.
   */
  private async saveOutgoingProjectWorktreeState(projectId: string): Promise<void> {
    try {
      const currentAppState = store.get("appState");

      // Get existing project state to preserve all fields, including the
      // renderer-authored activeWorktreeId.
      const existingState = await projectStore.getProjectState(projectId);

      await projectStore.saveProjectState(projectId, {
        ...existingState,
        projectId,
        activeWorktreeId: existingState?.activeWorktreeId,
        sidebarWidth: existingState?.sidebarWidth ?? currentAppState.sidebarWidth ?? 350,
        terminals: existingState?.terminals ?? [],
      });
    } catch (error) {
      // Non-fatal: log but don't block the switch
      console.error("[ProjectSwitch] Failed to save outgoing project worktree state:", error);
    }
  }

  private async cleanupSupportingServices(
    projectId: string,
    _previousProjectId: string | null,
    projectPath: string
  ): Promise<void> {
    console.log("[ProjectSwitch] Cleaning up previous project state...");

    const safeCall = (fn: () => unknown): Promise<unknown> => Promise.resolve().then(fn);
    const cleanupResults = await Promise.allSettled([
      safeCall(() => this.deps.ptyClient!.onProjectSwitch(this.windowId!, projectId, projectPath)),
      safeCall(() => logBuffer.onProjectSwitch()),
      this.deps.eventBuffer?.onProjectSwitch
        ? safeCall(() => this.deps.eventBuffer!.onProjectSwitch())
        : Promise.resolve(),
      safeCall(() => gitServiceCache.clear()),
      safeCall(() => contextInjectionTracker.onProjectSwitch()),
    ]);

    cleanupResults.forEach((result, index) => {
      if (result.status === "rejected") {
        const serviceNames = [
          "PtyClient",
          "LogBuffer",
          "EventBuffer",
          "GitServiceCache",
          "ContextInjectionTracker",
        ];
        console.error(`[ProjectSwitch] ${serviceNames[index]} cleanup failed:`, result.reason);
      }
    });
  }

  private async loadNewProject(project: Project): Promise<{ error?: string } | undefined> {
    if (!this.deps.worktreeService || this.windowId === null) {
      return undefined;
    }

    try {
      console.log("[ProjectSwitch] Loading worktrees for new project...");
      await this.deps.worktreeService.loadProject(project.path, this.windowId);
      console.log("[ProjectSwitch] Worktrees loaded successfully");
      return {};
    } catch (err) {
      console.error("[ProjectSwitch] Failed to load worktrees for project:", err);
      return { error: formatErrorMessage(err, "Failed to load worktrees") };
    }
  }

  /**
   * Apply portable project identity from .daintree/project.json during switch.
   * Only applies values when the project still has default name/emoji (user hasn't customised).
   */
  private async applyInRepoIdentity(project: Project): Promise<void> {
    try {
      const inRepo = await projectStore.readInRepoProjectIdentity(project.path);
      const updates: Partial<Project> = {};

      if (inRepo.found && !project.daintreeConfigPresent) {
        updates.daintreeConfigPresent = true;
      } else if (!inRepo.found && project.daintreeConfigPresent) {
        updates.daintreeConfigPresent = false;
      }

      const defaultName = path.basename(project.path);
      const defaultEmoji = DEFAULT_PROJECT_EMOJI;

      if (inRepo.name && project.name === defaultName) {
        updates.name = inRepo.name;
      }
      if (inRepo.emoji && project.emoji === defaultEmoji) {
        updates.emoji = inRepo.emoji;
      }
      if (inRepo.color && !project.color) {
        updates.color = inRepo.color;
      }

      if (Object.keys(updates).length > 0) {
        projectStore.updateProject(project.id, updates);
      }
    } catch (error) {
      console.error("[ProjectSwitch] Failed to apply in-repo identity:", error);
    }
  }

  /**
   * Reopen a background project, making it the active project.
   * This is essentially a switch operation but specifically for background projects.
   * Terminals that were running in the background will be reconnected on the frontend.
   */
  async reopenProject(projectId: string): Promise<Project> {
    return this.switchProject(projectId);
  }
}
