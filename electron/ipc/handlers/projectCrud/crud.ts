import { dialog } from "electron";
import path from "path";
import { CHANNELS } from "../../channels.js";
import { getWindowForWebContents } from "../../../window/webContentsRegistry.js";
import { projectStore } from "../../../services/ProjectStore.js";
import {
  collectActiveProjectIds,
  projectViewManagersFrom,
} from "../../../window/activeProjectIds.js";
import { broadcastToRenderer, typedHandle, typedHandleWithContext } from "../../utils.js";
import { resolveScopedProjectForIpcContext } from "../../projectContext.js";
import { refreshProjectMenuState } from "../../../projectMenuState.js";
import { notificationService } from "../../../services/NotificationService.js";
import type { HandlerDependencies } from "../../types.js";
import type { Project, ProjectAddOptions } from "../../../types/index.js";
import type { ProjectCreationIdentity } from "../../../../shared/types/project.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
import { AppError } from "../../../utils/errorTypes.js";
import { pruneWindowStateForPath } from "../../../windowState.js";
import { gracefulTeardownAndJournalProject } from "../../../services/pty/projectSessionJournal.js";

/**
 * Rejection copy for a destructive teardown (close+kill / remove) the pty-host
 * couldn't confirm. We deliberately keep the project's restoration state rather
 * than wipe it out from under still-running agents (#11340).
 */
const UNCONFIRMED_TEARDOWN_MESSAGE =
  "Couldn't confirm the project's terminals stopped, so its state was kept. Try again.";

/**
 * Rejection copy for a close attempt against a project that is on-screen in
 * some window. Deliberately doesn't say "another window": the same guard covers
 * the invoking window, a second window, and the outgoing paint-gate bridge.
 */
const PROJECT_VISIBLE_MESSAGE =
  "Cannot close a project that's open in a window. Switch that window to another project first.";

/**
 * Validate, register, and broadcast a project for the given absolute path.
 * Extracted from `handleProjectAdd` so other handlers (e.g. scratch
 * Save-as-Project) can register a path as a project without going through IPC.
 */
export async function addProjectByPath(
  projectPath: string,
  options?: ProjectAddOptions
): Promise<Project> {
  if (typeof projectPath !== "string" || !projectPath) {
    throw new Error("Invalid project path");
  }
  if (!path.isAbsolute(projectPath)) {
    throw new Error("Project path must be absolute");
  }
  // The two halves are validated independently and stay separate keys.
  // `normalizeCreationIdentity` drops a malformed identity WHOLE, so folding
  // `gitBacked` in alongside `name`/`emoji` would make a lightweight-open
  // payload fail the identity gate and be discarded in silence.
  const project = await projectStore.addProject(projectPath, {
    // Narrowed rather than forwarded: a caller may only ever ask to *drop* the
    // git requirement. Anything else would let it assert a mode the folder
    // doesn't have, and `addProject` alone decides that a repository was found.
    ...(options?.gitBacked === false ? { gitBacked: false } : {}),
    identity: normalizeCreationIdentity(options?.identity),
  });
  broadcastToRenderer(CHANNELS.PROJECT_UPDATED, project);
  return project;
}

// Matches the in-repo `.daintree/project.json` cap so an identity chosen at
// creation can't exceed what enabling in-repo settings would later accept.
const MAX_CREATION_NAME_LENGTH = 100;
// Generous next to any real emoji (a flag-with-modifier sequence is ~14 code
// units) while still bounding what a compromised renderer can store.
const MAX_CREATION_EMOJI_LENGTH = 32;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1F\x7F]/;

/**
 * Creation identity arrives from the renderer, so treat it as untrusted: keep
 * it only when both halves are plain, bounded, control-character-free strings.
 * A partial or malformed payload is dropped whole rather than half-applied,
 * leaving `addProject` on its normal basename + default-emoji path.
 *
 * Reads own properties only and returns a fresh object, so neither inherited
 * fields nor extra keys (`id`, `path`) can ride along into the insert.
 */
function normalizeCreationIdentity(
  identity: ProjectCreationIdentity | undefined
): ProjectCreationIdentity | undefined {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) return undefined;
  if (!Object.hasOwn(identity, "name") || !Object.hasOwn(identity, "emoji")) return undefined;

  const { name, emoji } = identity;
  if (typeof name !== "string" || typeof emoji !== "string") return undefined;

  const trimmedName = name.trim();
  const trimmedEmoji = emoji.trim();
  if (!trimmedName || !trimmedEmoji) return undefined;
  if (trimmedName.length > MAX_CREATION_NAME_LENGTH) return undefined;
  if (trimmedEmoji.length > MAX_CREATION_EMOJI_LENGTH) return undefined;
  if (CONTROL_CHARS.test(trimmedName) || CONTROL_CHARS.test(trimmedEmoji)) return undefined;

  return { name: trimmedName, emoji: trimmedEmoji };
}

/**
 * Remove a project row and everything keyed to it. Extracted from
 * `handleProjectRemove` so non-IPC callers can offer removal too — the native
 * "Remove from recent" recovery on a dead Recent Projects entry (#11409) — with
 * the same teardown rather than a bare `removeProject` that would orphan PTYs
 * and leave stale window state behind.
 */
export async function removeProjectWithCleanup(
  projectId: string,
  deps: Pick<HandlerDependencies, "ptyClient" | "worktreeService">
): Promise<void> {
  // Resolve the path before removeProject() deletes the row — the prune below
  // keys window-states.json by path, which is unrecoverable once the row is gone.
  const removedPath = projectStore.getProjectById(projectId)?.path ?? null;

  if (deps.ptyClient) {
    // Gracefully tear down and journal each agent session before the row (and
    // its restoration state) is permanently deleted. Fail closed: if the host
    // can't confirm the kills, keep the project so its still-running agents
    // aren't orphaned by a deleted row (#11340).
    const { confirmed } = await gracefulTeardownAndJournalProject(
      projectId,
      deps.ptyClient,
      deps.worktreeService
    );
    if (!confirmed) {
      throw new AppError({
        code: "INTERNAL",
        message: UNCONFIRMED_TEARDOWN_MESSAGE,
        context: { projectId },
      });
    }
  }

  await projectStore.removeProject(projectId);
  if (removedPath) {
    pruneWindowStateForPath(removedPath);
  }
  broadcastToRenderer(CHANNELS.PROJECT_REMOVED, projectId);
  // The row is gone, so a window still bound to it no longer has a project open.
  refreshProjectMenuState();
  notificationService.refreshTitles();
}

export function registerProjectCrudCoreHandlers(deps: HandlerDependencies): () => void {
  const handleProjectAdd = async (projectPath: string, options?: ProjectAddOptions) =>
    addProjectByPath(projectPath, options);

  const handlers: Array<() => void> = [];

  const handleProjectGetAll = async () => {
    return projectStore.getAllProjects();
  };
  handlers.push(typedHandle(CHANNELS.PROJECT_GET_ALL, handleProjectGetAll));

  const handleProjectGetCurrent = async (ctx: import("../../types.js").IpcContext) => {
    const scopedProject = resolveScopedProjectForIpcContext(ctx, deps);
    if (scopedProject) {
      // Project-scoped views must not inherit the last-active global project.
      // Returning null for an unbound view lets the renderer show the WelcomeScreen
      // (#6015). Skip the worktree side-effect too: no port has been brokered
      // for that view, so the snapshot would be orphaned.
      return scopedProject.project;
    }

    const currentProject = projectStore.getCurrentProject();

    if (currentProject && deps.worktreeService) {
      const senderWindow = getWindowForWebContents(ctx.event.sender);
      const windowId = senderWindow?.id ?? deps.mainWindow?.id;
      try {
        if (windowId !== undefined) {
          await deps.worktreeService.loadProject(currentProject.path, windowId);
        }
      } catch (err) {
        console.error("Failed to load worktrees for current project:", err);
      }
    }

    return currentProject;
  };
  handlers.push(typedHandleWithContext(CHANNELS.PROJECT_GET_CURRENT, handleProjectGetCurrent));

  handlers.push(typedHandle(CHANNELS.PROJECT_ADD, handleProjectAdd));

  const handleProjectRemove = async (projectId: string) => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }

    await removeProjectWithCleanup(projectId, deps);
  };
  handlers.push(typedHandle(CHANNELS.PROJECT_REMOVE, handleProjectRemove));

  const handleProjectUpdate = async (projectId: string, updates: Partial<Project>) => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    if (typeof updates !== "object" || updates === null) {
      throw new Error("Invalid updates object");
    }
    // `id` and `path` are identity, not metadata: entry-scoped authorization
    // (fileBrowser's project routing) resolves hosts by the row's path, so a
    // renderer that could rewrite its own project's path to a sibling's would
    // point that resolution at the sibling's host. Path changes stay exclusive
    // to the main-owned relocation flow (#11282).
    // `gitBacked` joins them: it decides whether the workspace host enumerates
    // worktrees at all, and only `addProject` — which actually looked for a
    // repository — may set it (#11405).
    // `resumableAgentCount` joins them: it is main-owned derived state,
    // recomputed from the persisted project state on every write (#11801). A
    // renderer that could set it would hand a row a resume promise the restore
    // never intends to keep, and the number is re-derived on the next save
    // anyway, so accepting it would only ever be a lie.
    const {
      id: _id,
      path: _path,
      inRepoSettings: _inRepo,
      frecencyScore: _fs,
      lastAccessedAt: _lat,
      gitBacked: _gitBacked,
      resumableAgentCount: _rac,
      ...safeUpdates
    } = updates;
    const updated = projectStore.updateProject(projectId, safeUpdates);
    broadcastToRenderer(CHANNELS.PROJECT_UPDATED, updated);
    // A rename leaves the File-menu gates alone — the project is still open —
    // but every window showing it is now titled with a stale name. Status rides
    // along because a row turned "closed" here stops naming a window too.
    if (updates.name !== undefined || updates.status !== undefined) {
      notificationService.refreshTitles();
    }
    if (
      updated.inRepoSettings &&
      (updates.name !== undefined || updates.emoji !== undefined || "color" in updates)
    ) {
      projectStore
        .writeInRepoProjectIdentity(updated.path, {
          id: updated.id,
          name: updated.name,
          emoji: updated.emoji,
          color: updated.color,
        })
        .catch((err) => {
          console.warn(
            `[IPC] project:update: failed to sync .daintree/project.json for ${projectId}:`,
            err
          );
        });
    }
    return updated;
  };
  handlers.push(typedHandle(CHANNELS.PROJECT_UPDATE, handleProjectUpdate));

  const handleProjectOpenDialog = async (ctx: import("../../types.js").IpcContext) => {
    const senderWindow = getWindowForWebContents(ctx.event.sender);
    const dialogOpts = {
      properties: ["openDirectory" as const, "createDirectory" as const],
      // Not "Open Git Repository": a folder without one is now openable too,
      // and the picker shouldn't imply a requirement it no longer has (#11405).
      title: "Open Folder",
    };
    const result = senderWindow
      ? await dialog.showOpenDialog(senderWindow, dialogOpts)
      : await dialog.showOpenDialog(dialogOpts);

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  };
  handlers.push(typedHandleWithContext(CHANNELS.PROJECT_OPEN_DIALOG, handleProjectOpenDialog));

  const handleProjectClose = async (projectId: string, options?: { killTerminals?: boolean }) => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }

    const killTerminals = options?.killTerminals ?? false;
    console.log(`[IPC] project:close: ${projectId} (killTerminals: ${killTerminals})`);

    // Is the project on-screen in ANY window? The DB pointer tracks the
    // last-focused window only, so a project visible in a second window would
    // otherwise be closed out from under the user (#11102). Re-evaluated rather
    // than snapshotted: the checks below straddle awaits the user can switch
    // projects during.
    const isVisibleAnywhere = (): boolean =>
      collectActiveProjectIds(
        projectViewManagersFrom(deps.windowRegistry),
        projectStore.getCurrentProjectId(),
        "project-close"
      ).has(projectId);

    if (!killTerminals && isVisibleAnywhere()) {
      throw new Error(PROJECT_VISIBLE_MESSAGE);
    }

    const project = projectStore.getProjectById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    if (!killTerminals && project.status === "closed") {
      return { processesKilled: 0, terminalsKilled: 0 };
    }

    try {
      if (killTerminals) {
        // Gracefully tear down and journal each agent session before wiping the
        // project's restoration state, so agent conversations stay resumable
        // from the picker. Fail closed: if the host can't confirm the kills,
        // keep the state rather than orphan still-running agents (#11340).
        const { confirmed, terminalsKilled } = await gracefulTeardownAndJournalProject(
          projectId,
          deps.ptyClient!,
          deps.worktreeService
        );
        if (!confirmed) {
          throw new AppError({
            code: "INTERNAL",
            message: UNCONFIRMED_TEARDOWN_MESSAGE,
            context: { projectId },
          });
        }

        await projectStore.clearProjectState(projectId);

        // Read the pointer fresh, not from a snapshot taken before the awaits
        // above: another window can switch projects while the kill is in
        // flight, and clearing on a stale read would wipe a DIFFERENT
        // project's pointer. This is pointer bookkeeping, not a visibility
        // check — it must stay keyed on the DB pointer.
        if (projectId === projectStore.getCurrentProjectId()) {
          projectStore.clearCurrentProject();
        }
        projectStore.updateProjectStatus(projectId, "closed");

        // After the "closed" write, not merely after clearCurrentProject(): the
        // closing window's ProjectViewManager still points at this project, so
        // the row's status is what tells the menu resolver it isn't open.
        refreshProjectMenuState();
        notificationService.refreshTitles();

        console.log(
          `[IPC] project:close: Killed ${terminalsKilled} process(es) ` +
            `(${terminalsKilled} terminals)`
        );

        return {
          processesKilled: terminalsKilled,
          terminalsKilled,
        };
      } else {
        const ptyStats = await deps.ptyClient!.getProjectStats(projectId);

        // Re-check after the awaited stats call: the user can bring the project
        // on-screen in any window while it's in flight, and backgrounding it +
        // pausing its workspace host would then hit a visible project. Thrown as
        // an AppError so the catch below rethrows it as-is instead of relabelling
        // a guard rejection as an INTERNAL failure.
        if (isVisibleAnywhere()) {
          throw new AppError({
            code: "VALIDATION",
            message: PROJECT_VISIBLE_MESSAGE,
            context: { projectId },
          });
        }

        projectStore.updateProjectStatus(projectId, "background");
        if (deps.worktreeService) {
          deps.worktreeService.pauseProject(project.path);
        }

        console.log(
          `[IPC] project:close: Backgrounded project with ${ptyStats.terminalCount} running terminals`
        );

        return {
          processesKilled: 0,
          terminalsKilled: 0,
        };
      }
    } catch (error) {
      // A guard rejection (the project went visible mid-close) is a precondition
      // failure, not a crash — rethrow it rather than relabelling it INTERNAL.
      if (error instanceof AppError) throw error;

      console.error(`[IPC] project:close: Failed to close project ${projectId}:`, error);
      throw new AppError({
        code: "INTERNAL",
        message: formatErrorMessage(error, "Failed to close project"),
        context: { projectId },
        cause: error instanceof Error ? error : undefined,
      });
    }
  };
  handlers.push(typedHandle(CHANNELS.PROJECT_CLOSE, handleProjectClose));

  const handleProjectCheckMissing = async (): Promise<string[]> => {
    return projectStore.checkMissingProjects();
  };
  handlers.push(typedHandle(CHANNELS.PROJECT_CHECK_MISSING, handleProjectCheckMissing));

  const handleProjectLocate = async (
    ctx: import("../../types.js").IpcContext,
    projectId: string
  ): Promise<Project | null> => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    const project = projectStore.getProjectById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const senderWindow = getWindowForWebContents(ctx.event.sender);
    const openOpts: Electron.OpenDialogOptions = {
      title: `Locate "${project.name}"`,
      properties: ["openDirectory"],
      defaultPath: path.dirname(project.path),
    };
    const result = senderWindow
      ? await dialog.showOpenDialog(senderWindow, openOpts)
      : await dialog.showOpenDialog(openOpts);

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const newPath = result.filePaths[0];
    // Route through the relocation coordinator: it forks internally — an OPEN
    // project (visible in any window) runs the phase-3 quiesce/rebind pipeline
    // so the live view/host/PTYs are repointed rather than stranded; a closed
    // reattach delegates to the phase-1/2 path. It broadcasts PROJECT_UPDATED to
    // every cached view by immutable id, so the new path reaches windows other
    // than the one that ran the locate flow (#11282).
    const { projectRelocationCoordinator } =
      await import("../../../services/ProjectRelocationCoordinator.js");
    projectRelocationCoordinator.configure(deps);
    return projectRelocationCoordinator.relocate({ projectId, mode: "reattach", newPath });
  };
  handlers.push(typedHandleWithContext(CHANNELS.PROJECT_LOCATE, handleProjectLocate));

  return () => handlers.forEach((cleanup) => cleanup());
}
