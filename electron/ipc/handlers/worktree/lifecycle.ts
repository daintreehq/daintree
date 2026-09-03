// eager-import-allow: reads worktree settings via store.get synchronously in the IPC handler
import { isAbsolute, resolve as resolvePath } from "path";
import type { z } from "zod";
import { CHANNELS } from "../../channels.js";
import { store } from "../../../store.js";
import { projectStore } from "../../../services/ProjectStore.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
import type { HandlerDependencies, IpcContext } from "../../types.js";
import type { WorktreeDeletePayload } from "../../../types/index.js";
import type {
  WorktreeState,
  WorktreeListResult,
  WorktreeCreateResult,
} from "../../../../shared/types/worktree.js";
import { fileSearchService } from "../../../services/FileSearchService.js";
import { gitServiceCache } from "../../../services/GitServiceCache.js";
import { getSoundService } from "../../../services/getSoundService.js";
import type * as SoundServiceModule from "../../../services/SoundService.js";
import { defineIpcNamespace, op, opValidated } from "../../define.js";
import {
  WorktreeCreatePayloadSchema,
  WorktreeSetActivePayloadSchema,
} from "../../../schemas/ipc.js";
import { checkRateLimit, waitForBurstRateLimitSlot } from "../../utils.js";
import { validateBranchName } from "../../../../shared/utils/pathPattern.js";
import {
  WORKTREE_RATE_LIMIT_KEY,
  WORKTREE_RATE_LIMIT_INTERVAL_MS,
  WORKTREE_RATE_LIMIT_BURST,
} from "./constants.js";
import { shouldPlayUiFeedbackSound } from "../../../utils/uiFeedbackSound.js";

type SoundId = keyof typeof SoundServiceModule.SOUND_FILES;

const inFlightWorktreeCreateRequests = new Map<string, Promise<WorktreeCreateResult>>();

function playSoundFireAndForget(id: SoundId): void {
  if (!shouldPlayUiFeedbackSound(store.get("notificationSettings"))) return;
  void getSoundService()
    .then((svc) => svc.play(id))
    .catch((err) => console.error("[worktree.lifecycle] sound play failed:", err));
}

function getWorktreeCreateRequestKey(
  payload: z.output<typeof WorktreeCreatePayloadSchema>
): string {
  const absoluteRootPath = resolvePath(payload.rootPath);
  const absoluteCreatePath = isAbsolute(payload.options.path)
    ? resolvePath(payload.options.path)
    : resolvePath(payload.rootPath, payload.options.path);
  return JSON.stringify({
    rootPath: absoluteRootPath,
    path: absoluteCreatePath,
    baseBranch: payload.options.baseBranch,
    newBranch: payload.options.newBranch.trim(),
    fromRemote: payload.options.fromRemote ?? false,
    useExistingBranch: payload.options.useExistingBranch ?? false,
    // Part of the key because they change what a create DOES, not just how it
    // is described. Coalescing a `collisionPolicy: "error"` request onto a
    // concurrent `"suffix"` one would return the suffixed success the strict
    // caller asked to be refused, and differing submodule policies would become
    // first-request-wins.
    collisionPolicy: payload.options.collisionPolicy ?? "suffix",
    submoduleInit: payload.options.submoduleInit ?? "inherit",
    // These change what gets provisioned and what the worktree's card shows, so
    // two requests differing only here are still different requests.
    provisionResource: payload.options.provisionResource ?? false,
    worktreeMode: payload.options.worktreeMode ?? "local",
    sourcePrNumber: payload.options.sourcePrNumber ?? null,
    sourcePrLinkedIssueNumber: payload.options.sourcePrLinkedIssueNumber ?? null,
  });
}

export function registerWorktreeLifecycleHandlers(deps: HandlerDependencies): () => void {
  const handleWorktreeGetAll = async (ctx: IpcContext): Promise<WorktreeState[]> => {
    if (!deps.worktreeService) {
      return [];
    }
    // Resolve by the sender view's immutable project id (main-owned
    // `viewToProject`, captured synchronously at dispatch) rather than the
    // window id: `windowToProject` is repointed the instant a project switch
    // starts, so a window-scoped read of the hydration prefetch can be answered
    // by a *different* project's host and return a full list of foreign
    // worktree ids that restore then trusts as authoritative (#11387; same
    // class as #11366, fixed for the file browser via getAllStatesForProjectAsync).
    // An unresolved project — a null id during the startup window before view
    // registration completes, or an unknown id — returns [], the established
    // "unknown, keep saved state" sentinel (#11234); never a throw, which would
    // only spam hydration's warn-and-fallback path.
    const senderProjectId = ctx.projectId;
    if (senderProjectId === null) {
      return [];
    }
    const project = projectStore.getProjectById(senderProjectId);
    if (!project) {
      return [];
    }
    return (await deps.worktreeService.getAllStatesForProjectAsync(
      project.path,
      senderProjectId
    )) as WorktreeState[];
  };

  /**
   * `get-all` plus the host's own "is there a repository here" verdict (#11650).
   *
   * Hydration needs both in one round trip: the list alone cannot say whether
   * an empty answer means "folder with no repository" or "host still
   * registering", and the project row's `gitBacked` column cannot either
   * (NULL there means both "real repository" and "never classified"). Every
   * unresolved case below answers `gitBacked: null` — the same "unknown, keep
   * saved state" sentinel `[]` carries — because a `false` would tell the
   * renderer to discard a real repository's worktree state during the very
   * boot race these guards exist for.
   */
  const handleWorktreeGetAllWithStatus = async (ctx: IpcContext): Promise<WorktreeListResult> => {
    const unknown: WorktreeListResult = { worktrees: [], gitBacked: null };
    if (!deps.worktreeService) {
      return unknown;
    }
    const senderProjectId = ctx.projectId;
    if (senderProjectId === null) {
      return unknown;
    }
    const project = projectStore.getProjectById(senderProjectId);
    if (!project) {
      return unknown;
    }
    const { states, gitBacked } =
      await deps.worktreeService.getAllStatesWithGitBackedForProjectAsync(
        project.path,
        senderProjectId
      );
    return { worktrees: states as WorktreeState[], gitBacked };
  };

  const handleWorktreeRefresh = async (worktreeId?: string): Promise<void> => {
    if (!deps.worktreeService) {
      return;
    }
    await deps.worktreeService.refresh(worktreeId);
  };

  const handleWorktreeSetActive = async (
    ctx: IpcContext,
    payload: z.output<typeof WorktreeSetActivePayloadSchema>
  ): Promise<void> => {
    if (!deps.worktreeService) {
      return;
    }
    await deps.worktreeService.setActiveWorktree(payload.worktreeId, ctx.senderWindow?.id, {
      silent: true,
    });
  };

  const handleWorktreeCreate = async (
    payload: z.output<typeof WorktreeCreatePayloadSchema>
  ): Promise<WorktreeCreateResult> => {
    // Semantic guard: rootPath flows into createHardenedGit at the service
    // layer and must be an absolute path. The schema enforces structure
    // (non-empty, no null bytes); absoluteness is checked here. #3742.
    if (!isAbsolute(payload.rootPath)) {
      throw new Error("rootPath must be an absolute path");
    }
    // Defense-in-depth: WorkspaceService.createWorktree also validates, but
    // throwing here surfaces a clean Error to the renderer without consuming
    // a rate-limit slot or spinning up the workspace-host round-trip for
    // obviously-invalid input. #7033.
    const branchValidation = validateBranchName(payload.options.newBranch);
    if (!branchValidation.valid) {
      throw new Error(branchValidation.error ?? "Invalid branch name");
    }
    const createKey = getWorktreeCreateRequestKey(payload);
    const existingCreate = inFlightWorktreeCreateRequests.get(createKey);
    if (existingCreate) {
      return existingCreate;
    }

    const createPromise = (async (): Promise<WorktreeCreateResult> => {
      await waitForBurstRateLimitSlot(
        WORKTREE_RATE_LIMIT_KEY,
        WORKTREE_RATE_LIMIT_INTERVAL_MS,
        WORKTREE_RATE_LIMIT_BURST
      );
      if (!deps.worktreeService) {
        throw new Error("Workspace client not initialized");
      }
      const created = await deps.worktreeService.createWorktree(payload.rootPath, payload.options);
      const { worktreeId } = created;
      try {
        fileSearchService.invalidate(payload.options.path);
      } catch (error) {
        console.warn("[worktree.create] Failed to invalidate file search cache:", error);
      }
      try {
        deps.worktreeService?.invalidatePulseCache(worktreeId);
      } catch (error) {
        console.warn("[worktree.create] Failed to invalidate pulse cache:", error);
      }
      if (store.get("notificationSettings").uiFeedbackSoundEnabled) {
        playSoundFireAndForget("worktree-create");
      }
      return created;
    })();

    inFlightWorktreeCreateRequests.set(createKey, createPromise);
    void createPromise
      .finally(() => {
        if (inFlightWorktreeCreateRequests.get(createKey) === createPromise) {
          inFlightWorktreeCreateRequests.delete(createKey);
        }
      })
      .catch(() => {});
    return createPromise;
  };

  const handleWorktreeRestartService = async (ctx: IpcContext): Promise<void> => {
    if (!deps.worktreeService) return;
    const windowId = ctx.senderWindow?.id;
    if (windowId === undefined) {
      console.warn(
        "[worktree.restart-service] No sender window; cannot route manual restart to a host"
      );
      return;
    }
    deps.worktreeService.manualRestartForWindow(windowId);
  };

  // Recovery path for a project switch whose worktree load threw (#8400).
  // The switch forward-fails to the new project, so the current project is
  // already the one whose load failed — re-run loadProject for it rather than
  // re-issuing a no-op same-project switch.
  const handleWorktreeRetryProjectLoad = async (ctx: IpcContext): Promise<void> => {
    if (!deps.worktreeService) {
      throw new Error("Workspace service is not available");
    }
    const windowId = ctx.senderWindow?.id;
    if (windowId === undefined) {
      throw new Error("Couldn't identify the window to reload");
    }
    const project = projectStore.getCurrentProject();
    if (!project) {
      throw new Error("No active project to reload");
    }
    try {
      await deps.worktreeService.loadProject(project.path, windowId);

      // Re-establish the worktree MessagePort after a successful reload.
      // `loadProject()` alone reloads the host but does not re-broker the
      // port, so the renderer's worktree store never re-runs
      // `fetchInitialState()` and the sidebar stays stuck on the loading
      // skeleton even after a successful retry (#8796). Mirrors switch.ts.
      const sender = ctx.event.sender;
      if (!sender.isDestroyed()) {
        deps.worktreeService.attachDirectPort(windowId, sender);
        const host = deps.worktreeService.getHostForProject(project.path);
        if (host && deps.worktreePortBroker) {
          const brokered = deps.worktreePortBroker.brokerPort(host, sender);
          if (!brokered) {
            // The reload succeeded but the worktree MessagePort never
            // connected, so the renderer's worktree store can't fetch its
            // state. Throw so the error banner stays and Retry remains
            // available, rather than leaving the sidebar silently stuck.
            throw new Error("Reloaded the project but couldn't connect to the worktree service");
          }
        }
      }
    } catch (error) {
      throw new Error(formatErrorMessage(error, "Failed to load worktrees"), { cause: error });
    }
  };

  // User-triggered retry of auth-suspended fetches (#9736). Auth failures
  // suspend a repo's fetch cache indefinitely; clicking the auth-failed sync
  // badge clears the suspension and re-fetches. Silent no-op when the service
  // is absent — matches handleWorktreeRefresh (not a hard error).
  const handleWorktreeRetryAuthFetch = async (): Promise<void> => {
    deps.worktreeService?.retryAuthFetch();
  };

  const handleWorktreeDelete = async (
    ctx: IpcContext,
    payload: WorktreeDeletePayload
  ): Promise<void> => {
    checkRateLimit(CHANNELS.WORKTREE_DELETE, 10, 10_000);
    if (!deps.worktreeService) {
      throw new Error("Workspace client not initialized");
    }
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload");
    }
    if (typeof payload.worktreeId !== "string" || !payload.worktreeId) {
      throw new Error("Invalid worktree ID");
    }
    if (payload.force !== undefined && typeof payload.force !== "boolean") {
      throw new Error("Invalid force parameter");
    }
    if (payload.deleteBranch !== undefined && typeof payload.deleteBranch !== "boolean") {
      throw new Error("Invalid deleteBranch parameter");
    }
    const states = await deps.worktreeService.getAllStatesAsync(ctx.senderWindow?.id);
    const worktree = states.find((wt) => wt.id === payload.worktreeId);
    await deps.worktreeService.deleteWorktree(
      payload.worktreeId,
      payload.force,
      payload.deleteBranch
    );
    try {
      deps.worktreeService?.invalidatePulseCache(payload.worktreeId);
    } catch (error) {
      console.warn("[worktree.delete] Failed to invalidate pulse cache:", error);
    }
    if (worktree) {
      try {
        fileSearchService.invalidate(worktree.path);
      } catch (error) {
        console.warn("[worktree.delete] Failed to invalidate file search cache:", error);
      }
      try {
        gitServiceCache.delete(worktree.path);
      } catch (error) {
        console.warn("[worktree.delete] Failed to evict git service cache entry:", error);
      }
    }
    if (store.get("notificationSettings").uiFeedbackSoundEnabled) {
      playSoundFireAndForget("worktree-delete");
    }
    // Clean up persisted issue association
    const issueMap = store.get("worktreeIssueMap", {});
    if (issueMap[payload.worktreeId]) {
      const { [payload.worktreeId]: _, ...rest } = issueMap;
      store.set("worktreeIssueMap", rest);
    }
  };

  const namespace = defineIpcNamespace({
    name: "worktreeLifecycle",
    ops: {
      getAll: op(CHANNELS.WORKTREE_GET_ALL, handleWorktreeGetAll, { withContext: true }),
      getAllWithStatus: op(CHANNELS.WORKTREE_GET_ALL_WITH_STATUS, handleWorktreeGetAllWithStatus, {
        withContext: true,
      }),
      refresh: op(CHANNELS.WORKTREE_REFRESH, handleWorktreeRefresh),
      setActive: opValidated(
        CHANNELS.WORKTREE_SET_ACTIVE,
        WorktreeSetActivePayloadSchema,
        handleWorktreeSetActive,
        { withContext: true }
      ),
      create: opValidated(
        CHANNELS.WORKTREE_CREATE,
        WorktreeCreatePayloadSchema,
        handleWorktreeCreate
      ),
      restartService: op(CHANNELS.WORKTREE_RESTART_SERVICE, handleWorktreeRestartService, {
        withContext: true,
      }),
      retryProjectLoad: op(CHANNELS.WORKTREE_RETRY_PROJECT_LOAD, handleWorktreeRetryProjectLoad, {
        withContext: true,
      }),
      retryAuthFetch: op(CHANNELS.WORKTREE_RETRY_AUTH_FETCH, handleWorktreeRetryAuthFetch),
      delete: op(CHANNELS.WORKTREE_DELETE, handleWorktreeDelete, { withContext: true }),
    },
  });

  return namespace.register();
}
