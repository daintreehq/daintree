import { create, type StateCreator } from "zustand";
import { persist, subscribeWithSelector } from "zustand/middleware";
import type { Project, ProjectCloseResult } from "@shared/types";
import { projectClient } from "@/clients";
import { notify } from "@/lib/notify";
import { actionService } from "@/services/ActionService";
import { logErrorWithContext } from "@/utils/errorContext";
import { logDebug } from "@/utils/logger";
import { useUrlHistoryStore } from "./urlHistoryStore";
import { useHelpPanelStore } from "./helpPanelStore";
import { createSafeJSONStorage } from "./persistence/safeStorage";
import { registerPersistedStore } from "./persistence/persistedStoreRegistry";
import { panelPersistence, panelToSnapshot } from "./persistence/panelPersistence";
import { useTerminalInputStore } from "./terminalInputStore";
import { isSmokeTestTerminalId } from "@shared/utils/smokeTestTerminals";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { isClientAppError } from "@/utils/clientAppError";
import { getViewWorkspaceId } from "./viewWorkspaceId";
import {
  clearPanelStoreForSwitchThroughAccessor,
  clearFleetArmingThroughAccessor,
  getPanelStoreSnapshot,
  getWorktreeSelectionSnapshot,
  getWorktreeIdSet,
} from "./storeAccessors";
import type { ProjectSwitchOutgoingState } from "@shared/types/ipc/project";
import { getNarrowPanel } from "@/store/slices/panelRegistry/selectors";
import { isPtyPanel } from "@shared/types/panel";

type CarrierPanel = Parameters<typeof getNarrowPanel>[0][string];

function shouldPersistTerminal(t: NonNullable<CarrierPanel>): boolean {
  return (
    t.location !== "trash" &&
    t.location !== "background" &&
    // The carrier's kind is the discriminated union of built-in kinds; the
    // runtime can still hand us an assistant panel whose kind escapes the
    // declared union, so widen to string before comparing.
    (t.kind as string) !== "assistant" &&
    !(isPtyPanel(t) && t.excludeFromPersistence === true) &&
    !isSmokeTestTerminalId(t.id)
  );
}

function buildOutgoingState(projectId: string): ProjectSwitchOutgoingState {
  const draftInputs = useTerminalInputStore.getState().getProjectDraftInputs(projectId);
  // Persist the *durable* selection, not whatever is incidentally active. A
  // focus promotion (e.g. a temporary PR worktree spun up by a batch merge)
  // leaves `restoreWorktreeId` pointing at the last deliberate selection, so it
  // round-trips correctly on switch-back (#9512). Validate it against the
  // current view's worktrees: if it was removed before the switch, send
  // `undefined` so hydration falls back to the main worktree instead of
  // resurrecting a stale id. When no view store is mounted (`null`), skip
  // validation and preserve the candidate.
  const restoreId = getWorktreeSelectionSnapshot()?.restoreWorktreeId ?? undefined;
  const knownIds = getWorktreeIdSet();
  const activeWorktreeId =
    restoreId && (knownIds === null || knownIds.has(restoreId)) ? restoreId : undefined;

  // Synchronously snapshot terminal state from the Zustand store before the
  // renderer gets detached.  This captures browser/dev-preview panel state
  // that would otherwise be lost because the debounced persistence hasn't
  // flushed yet.  Uses the same filter as PanelPersistence.save().
  const terminalState = getPanelStoreSnapshot();
  if (!terminalState) {
    return { draftInputs, activeWorktreeId };
  }

  const { panelsById, panelIds, tabGroups } = terminalState;

  // Thread previously-persisted snapshots per panel so the outgoing state
  // preserves kind-specific fields for unregistered kinds (issue #5201).
  // The main process pre-applies this payload to the previous project's
  // persisted state during PROJECT_SWITCH (see projectCrud.ts:184-217), so
  // without preservation here a switch would silently overwrite an extension
  // panel's on-disk fields with a base-only snapshot.
  const prevSnapshotMap = panelPersistence.getPreviousSnapshotMap(projectId);
  const terminals = panelIds
    .map((id) => panelsById[id])
    .filter((t): t is NonNullable<CarrierPanel> => t != null && shouldPersistTerminal(t))
    .map((t) => panelToSnapshot(t, prevSnapshotMap?.get(t.id)));

  const tabGroupArray = Array.from(tabGroups.values()).filter((g) => g.panelIds.length > 1);

  return {
    terminals,
    draftInputs,
    tabGroups: tabGroupArray,
    activeWorktreeId,
  };
}

/**
 * Yield one macrotask so a pending React commit can paint before the caller
 * resumes. A project switch flips the busy flags and then must run the heavy
 * synchronous `buildOutgoingState()` snapshot and fire the switch IPC; doing all
 * of it in one task blocks the event loop so the click press never visually
 * settles until they finish, and the click reads as unresponsive. Awaiting this
 * between the flag flip and the heavy work lets that commit paint first, at the
 * cost of one macrotask before the IPC fires. `setTimeout` (a macrotask), not
 * `queueMicrotask`, because the browser paints between macrotasks, never between
 * microtasks.
 */
function yieldToPaint(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface ProjectState {
  projects: Project[];
  currentProject: Project | null;
  isLoading: boolean;
  /**
   * True while a project switch is in flight (#10736). Distinct from the shared
   * `isLoading`, which also fires for load/add/remove — this scopes the
   * busy state to the switch so `clearSwitching` knows the in-flight load is the
   * switch's own and can reset it on a cached-view reveal-back. Set
   * synchronously in `switchProject` before the fire-and-forget IPC; never
   * cleared on the happy path (the outgoing renderer is detached and replaced),
   * only in the `.catch()` where the outgoing view stays visible. Transient,
   * never persisted.
   */
  isSwitching: boolean;
  /**
   * Id of the project being switched to while `isSwitching` is true.
   * Set/cleared atomically with `isSwitching`.
   */
  switchingToProjectId: string | null;
  error: string | null;
  /**
   * True once the batched boot payload has seeded `projects` + `currentProject`
   * (#10390). The Toolbar's mount effect uses this to skip its redundant
   * initial `loadProjects()` + `getCurrentProject()` IPC pair during the boot
   * window; post-switch refetches are unaffected. Never reset — boot seeding
   * happens once per renderer context.
   */
  isBootstrapped: boolean;
  /**
   * Set when a project switch committed to the new project but its worktree
   * load threw (#8400). Surfaced as a Tier 3 inline recovery banner. Transient
   * — never persisted, cleared on the next switch start or a successful retry.
   */
  worktreeLoadError: string | null;
  gitInitDialogOpen: boolean;
  gitInitDirectoryPath: string | null;
  createFolderDialogOpen: boolean;
  cloneRepoDialogOpen: boolean;

  loadProjects: () => Promise<void>;
  getCurrentProject: () => Promise<void>;
  addProject: () => Promise<void>;
  addProjectByPath: (
    path: string,
    options?: { skipDubiousOwnershipRetry?: boolean }
  ) => Promise<void>;
  createProjectFolder: (parentPath: string, folderName: string) => Promise<void>;
  switchProject: (
    projectId: string,
    options?: { focusIntent?: "focus-next-waiting" }
  ) => Promise<void>;
  setWorktreeLoadError: (error: string | null) => void;
  clearSwitching: () => void;
  updateProject: (id: string, updates: Partial<Project>) => Promise<void>;
  enableInRepoSettings: (id: string) => Promise<Project>;
  disableInRepoSettings: (id: string) => Promise<Project>;
  removeProject: (id: string) => Promise<void>;
  closeProject: (
    projectId: string,
    options?: { killTerminals?: boolean }
  ) => Promise<ProjectCloseResult>;
  closeActiveProject: (projectId: string) => Promise<ProjectCloseResult>;
  reopenProject: (projectId: string) => Promise<void>;
  checkMissingProjects: () => Promise<void>;
  locateProject: (projectId: string) => Promise<void>;
  openGitInitDialog: (directoryPath: string) => void;
  closeGitInitDialog: () => void;
  handleGitInitSuccess: () => Promise<void>;
  openCreateFolderDialog: () => void;
  closeCreateFolderDialog: () => void;
  openCloneRepoDialog: () => void;
  closeCloneRepoDialog: () => void;
  handleCloneSuccess: (clonedPath: string) => Promise<void>;
}

/**
 * Module-reload-resilient state for the renderer's IPC subscriptions.
 *
 * HMR or test re-imports would otherwise re-register the `onUpdated`/
 * `onRemoved` listeners on every module load without ever removing the prior
 * registration, so each project update would fire N times per reload cycle.
 * We store registration state on `globalThis` — persistent across module
 * instances in the same window — and keep mutable `applyUpdated`/
 * `applyRemoved` pointers that the latest module instance rebinds to its
 * own store on import. New module instances reuse the existing subscription
 * but drive the *current* store.
 */
interface ProjectStoreListenerState {
  applyUpdated: ((project: Project) => void) | null;
  applyRemoved: ((projectId: string) => void) | null;
  applyWorktreeLoadStatus:
    | ((payload: { projectId: string; worktreeLoadError: string | null }) => void)
    | null;
  updatedRegistered: boolean;
  removedRegistered: boolean;
  worktreeLoadStatusRegistered: boolean;
}

const PROJECT_STORE_LISTENER_STATE_KEY = "__daintreeProjectStoreListenerState";

let projectTransitionRequestId = 0;
let projectListRequestId = 0;
let currentProjectRequestId = 0;

const PROJECT_VIEW_CURRENT_RETRY_DELAYS_MS = [100, 250, 500, 1000, 2000, 3000];

function cancelProjectReadRequests(): void {
  projectListRequestId++;
  currentProjectRequestId++;
}

function getLocationProjectId(): string | null {
  return getViewWorkspaceId();
}

function getProjectForCurrentLocation(projects: Project[]): Project | null {
  const projectId = getLocationProjectId();
  if (!projectId) return null;

  const project = projects.find((candidate) => candidate.id === projectId);
  if (project?.status === "closed") return null;
  return project ?? null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function getCurrentProjectWithViewRetry(): Promise<Project | null> {
  const expectedProjectId = getLocationProjectId();
  const firstResult = await projectClient.getCurrent();
  if (firstResult || !expectedProjectId) {
    return firstResult;
  }

  for (const delayMs of PROJECT_VIEW_CURRENT_RETRY_DELAYS_MS) {
    await delay(delayMs);
    if (getLocationProjectId() !== expectedProjectId) {
      return null;
    }

    const retryResult = await projectClient.getCurrent();
    if (retryResult) {
      return retryResult;
    }
  }

  return null;
}

function getProjectStoreListenerState(): ProjectStoreListenerState {
  const target = globalThis as typeof globalThis & {
    [PROJECT_STORE_LISTENER_STATE_KEY]?: ProjectStoreListenerState;
  };
  const existing = target[PROJECT_STORE_LISTENER_STATE_KEY];
  if (existing) {
    return existing;
  }

  const created: ProjectStoreListenerState = {
    applyUpdated: null,
    applyRemoved: null,
    applyWorktreeLoadStatus: null,
    updatedRegistered: false,
    removedRegistered: false,
    worktreeLoadStatusRegistered: false,
  };
  target[PROJECT_STORE_LISTENER_STATE_KEY] = created;
  return created;
}

function isDubiousOwnershipError(error: unknown): boolean {
  const message = formatErrorMessage(error, "");
  const lower = message.toLowerCase();
  return lower.includes("dubious ownership") || lower.includes("safe.directory");
}

function getProjectOpenErrorMessage(error: unknown): string {
  if (isClientAppError(error) && error.code === "NOT_A_GIT_REPO") {
    return "The selected directory is not a Git repository.";
  }

  const message = formatErrorMessage(error, "");
  const lower = message.toLowerCase();

  if (lower.includes("spawn git enoent") || lower.includes("git: not found")) {
    return "Git executable not found. Install Git and ensure it is available on your PATH.";
  }

  if (isDubiousOwnershipError(error)) {
    return (
      "Git refused to open this repository due to 'dubious ownership'. " +
      "Mark it as safe.directory in Git settings and try again."
    );
  }

  if (message.includes("Not a git repository")) {
    return "The selected directory is not a Git repository.";
  }

  if (message.includes("Project path must be absolute")) {
    return "Project path must be an absolute path.";
  }

  if (message.includes("ELOOP")) {
    return "The selected directory contains a symbolic link loop and cannot be opened.";
  }

  if (message.includes("ENAMETOOLONG")) {
    return "The path is too long. Shorten the directory name or move it closer to the filesystem root.";
  }

  if (message.includes("ENOENT")) {
    return "The selected directory does not exist.";
  }

  if (message.includes("EACCES") || message.includes("EPERM")) {
    return "Permission denied. You don't have access to this directory.";
  }

  return message || "Couldn't open project.";
}

function isPersistedProject(value: unknown): value is Project {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Project>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.path === "string" &&
    typeof candidate.emoji === "string" &&
    typeof candidate.lastOpened === "number"
  );
}

const createProjectStore: StateCreator<ProjectState> = (set, get) => ({
  projects: [],
  currentProject: null,
  isLoading: false,
  isSwitching: false,
  switchingToProjectId: null,
  isBootstrapped: false,
  gitInitDialogOpen: false,
  gitInitDirectoryPath: null,
  createFolderDialogOpen: false,
  cloneRepoDialogOpen: false,
  error: null,
  worktreeLoadError: null,

  addProjectByPath: async (path, options) => {
    set({ isLoading: true, error: null });
    let resolvedPath: string | undefined | null;
    try {
      resolvedPath = path.trim() || (await projectClient.openDialog());
      if (!resolvedPath) {
        set({ isLoading: false });
        return;
      }

      const newProject = await projectClient.add(resolvedPath);

      await get().loadProjects();
      await get().switchProject(newProject.id);
    } catch (error) {
      logErrorWithContext(error, {
        operation: "add_project",
        component: "projectStore",
        details: { path: resolvedPath || path },
      });
      const errorMessage = formatErrorMessage(error, "Couldn't add project");

      // Absolute-path check: POSIX (/...), Windows drive letter (C:\... / C:/...),
      // and Windows UNC (\\server\share...) are all "absolute" here.
      const isAbsolutePath = (p: string) =>
        p.startsWith("/") || p.startsWith("\\\\") || /^[a-zA-Z]:[\\/]/.test(p);

      const isNotAGitRepo =
        (isClientAppError(error) && error.code === "NOT_A_GIT_REPO") ||
        errorMessage.includes("Not a git repository");
      if (isNotAGitRepo) {
        const gitInitPath =
          resolvedPath || path.trim() || errorMessage.match(/Not a git repository: (.+)/)?.[1];
        if (gitInitPath && isAbsolutePath(gitInitPath)) {
          set({ isLoading: false });
          get().openGitInitDialog(gitInitPath);
          return;
        }
      }

      if (isDubiousOwnershipError(error) && !options?.skipDubiousOwnershipRetry) {
        const targetPath = resolvedPath ?? path.trim();
        if (targetPath && isAbsolutePath(targetPath)) {
          notify({
            type: "error",
            title: "Repository ownership issue",
            message:
              "Git refused to open this repository due to an ownership mismatch. " +
              "You can mark it as trusted to open it.",
            duration: 0,
            actions: [
              {
                label: "Mark as safe",
                variant: "primary",
                onClick: async () => {
                  try {
                    await window.electron.git.markSafeDirectory(targetPath);
                  } catch (markError) {
                    const markMessage = formatErrorMessage(
                      markError,
                      "Couldn't mark directory as safe"
                    );
                    // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
                    notify({
                      type: "error",
                      title: "Couldn't mark as safe",
                      message: markMessage,
                      duration: 6000,
                    });
                    return;
                  }
                  // Pass skipDubiousOwnershipRetry so a persistent dubious
                  // ownership error (e.g., the path we wrote doesn't match
                  // what git canonicalizes to) falls through to the generic
                  // error toast instead of showing the same CTA indefinitely.
                  await get().addProjectByPath(targetPath, {
                    skipDubiousOwnershipRetry: true,
                  });
                },
              },
              {
                label: "Open logs",
                variant: "secondary",
                actionId: "errors.openLogs",
                onClick: () => {
                  void actionService.dispatch("errors.openLogs", undefined, { source: "user" });
                },
              },
            ],
          });
          set({
            error: "Git refused to open repository due to dubious ownership.",
            isLoading: false,
          });
          return;
        }
      }

      const message = getProjectOpenErrorMessage(error);
      // Capture a frozen snapshot of the actually-resolved path so the retry
      // re-attempts the directory the user picked, not the empty argument
      // value the dialog flow was originally invoked with.
      const retryPath = resolvedPath ?? path.trim();
      notify({
        type: "error",
        title: "Couldn't add project",
        message,
        actions: [
          {
            label: "Try again",
            variant: "primary",
            onClick: () => {
              void get().addProjectByPath(retryPath);
            },
          },
        ],
      });
      set({ error: message, isLoading: false });
    }
  },

  loadProjects: async () => {
    const requestId = ++projectListRequestId;
    set({ isLoading: true, error: null });
    try {
      const projects = await projectClient.getAll();
      if (requestId !== projectListRequestId) {
        return;
      }
      set((state) => ({
        projects,
        currentProject: state.currentProject ?? getProjectForCurrentLocation(projects),
        isLoading: false,
      }));
      // Check for missing directories in the background after updating the list
      void get().checkMissingProjects();
    } catch (error) {
      if (requestId !== projectListRequestId) {
        return;
      }
      logErrorWithContext(error, {
        operation: "load_projects",
        component: "projectStore",
        errorType: "filesystem",
      });
      set({ error: "Failed to load projects", isLoading: false });
    }
  },

  getCurrentProject: async () => {
    const requestId = ++currentProjectRequestId;
    set({ isLoading: true, error: null });
    try {
      const currentProject = await getCurrentProjectWithViewRetry();
      if (requestId !== currentProjectRequestId) {
        return;
      }
      set((state) => ({
        currentProject: currentProject ?? getProjectForCurrentLocation(state.projects),
        isLoading: false,
      }));
    } catch (error) {
      if (requestId !== currentProjectRequestId) {
        return;
      }
      logErrorWithContext(error, {
        operation: "get_current_project",
        component: "projectStore",
        errorType: "filesystem",
      });
      set({
        error: "Failed to get current project",
        currentProject: null,
        isLoading: false,
      });
    }
  },

  addProject: async () => {
    await get().addProjectByPath("");
  },

  switchProject: async (projectId, options) => {
    if (get().currentProject?.id === projectId) return;
    const requestId = ++projectTransitionRequestId;

    // Drop fleet arming selections synchronously — the outgoing view's armed
    // set is project-scoped and must not leak if the view is later restored
    // from the LRU cache.
    clearFleetArmingThroughAccessor();

    // Capture the outgoing project id now, while it's still the active project.
    const currentProjectId = get().currentProject?.id;

    // Flip the busy/switch flags FIRST and clear any stale worktree-load banner
    // atomically with the switch start (#8400, mirrors the #4451 atomic-swap
    // fix), THEN yield so the click stays responsive before we run the heavy
    // outgoing-state snapshot and fire the IPC. buildOutgoingState() walks the
    // whole panel graph synchronously; running it inline here blocked the event
    // loop so the click press never visually settled, and the click felt
    // unresponsive for the duration of the snapshot.
    set({
      isLoading: true,
      isSwitching: true,
      switchingToProjectId: projectId,
      error: null,
      worktreeLoadError: null,
    });

    await yieldToPaint();
    // A newer transition started while we yielded — let it own the switch so a
    // stale snapshot/IPC can't clobber it.
    if (requestId !== projectTransitionRequestId) return;

    // Capture outgoing state just before firing, after the paint. The outgoing
    // view is not detached until the main process handles the IPC, so the panel
    // store still reflects the outgoing project here.
    const outgoingState = currentProjectId ? buildOutgoingState(currentProjectId) : undefined;

    // Fire-and-forget: the main process swaps WebContentsViews, so this
    // renderer gets detached. Don't write the response into stores — the
    // new view handles its own state independently.
    projectClient.switch(projectId, outgoingState, options).catch((error) => {
      if (requestId !== projectTransitionRequestId) {
        return;
      }
      logErrorWithContext(error, {
        operation: "switch_project",
        component: "projectStore",
        details: { projectId },
      });
      const message = getProjectOpenErrorMessage(error);
      notify({
        type: "error",
        title: "Couldn't switch project",
        message,
        actions: [
          {
            label: "Try again",
            variant: "primary",
            onClick: () => {
              void get().switchProject(projectId);
            },
          },
        ],
      });
      // The switch failed before the view swap, so this outgoing renderer stays
      // visible — clear the busy flag here (the happy path never reaches this
      // renderer again, so it needs no clear).
      set({ error: message, isLoading: false, isSwitching: false, switchingToProjectId: null });
    });
  },

  setWorktreeLoadError: (worktreeLoadError) => {
    set({ worktreeLoadError });
  },

  /**
   * Force-clears the switch busy state (#10736 follow-up). The happy path
   * deliberately leaves `isSwitching`/`isLoading` set on the outgoing renderer
   * (the view is detached and replaced, so it never re-renders) — but that
   * renderer is kept in the LRU view cache and reactivated on a later switch
   * *back*, where it would otherwise resurface its stale flags: `ProjectSwitcher`
   * shows a stuck busy spinner and stays disabled on the stuck `isLoading`. This
   * is the reset `useClearSwitchBusyStateOnReveal` calls when a cached view
   * returns to the foreground.
   *
   * Gated on a switch actually being flagged so it never clobbers an unrelated
   * `isLoading` (load/add/remove also use it); `isLoading` is only reset here
   * because, in that branch, the in-flight load was the switch's own — a
   * reactivated parked view has no other operation running. Idempotent.
   */
  clearSwitching: () => {
    if (!get().isSwitching && get().switchingToProjectId === null) return;
    set({ isSwitching: false, switchingToProjectId: null, isLoading: false });
  },

  updateProject: async (id, updates) => {
    // Snapshot for rollback
    const prevProjects = get().projects;
    const prevCurrentProject = get().currentProject;

    // Optimistic apply — no isLoading spinner; UI reflects the change immediately
    set((state) => ({
      error: null,
      projects: state.projects.map((p) => (p.id === id ? { ...p, ...updates } : p)),
      currentProject:
        state.currentProject?.id === id
          ? { ...state.currentProject, ...updates }
          : state.currentProject,
    }));

    try {
      await projectClient.update(id, updates);
      // Reconcile with server-side normalization in the background. loadProjects
      // only fills currentProject when it's null, so explicitly re-sync the
      // active project from the reloaded list to pick up any normalization.
      await get().loadProjects();
      if (get().currentProject?.id === id) {
        const reconciled = get().projects.find((p) => p.id === id);
        if (reconciled) set({ currentProject: reconciled });
      }
    } catch (error) {
      // Rollback to pre-optimistic state
      set({ projects: prevProjects, currentProject: prevCurrentProject, isLoading: false });
      logErrorWithContext(error, {
        operation: "update_project",
        component: "projectStore",
        details: { projectId: id, updates },
      });
      set({ error: "Failed to update project" });
      throw error;
    }
  },

  enableInRepoSettings: async (id) => {
    const updatedProject = await projectClient.enableInRepoSettings(id);
    set((state) => ({
      projects: state.projects.map((p) => (p.id === id ? updatedProject : p)),
      currentProject: state.currentProject?.id === id ? updatedProject : state.currentProject,
    }));
    return updatedProject;
  },

  disableInRepoSettings: async (id) => {
    const updatedProject = await projectClient.disableInRepoSettings(id);
    set((state) => ({
      projects: state.projects.map((p) => (p.id === id ? updatedProject : p)),
      currentProject: state.currentProject?.id === id ? updatedProject : state.currentProject,
    }));
    return updatedProject;
  },

  removeProject: async (id) => {
    set({ isLoading: true, error: null });
    try {
      await projectClient.remove(id);
      await get().loadProjects();
      if (get().currentProject?.id === id) {
        set({ currentProject: null });
      }
      useUrlHistoryStore.getState().removeProjectHistory(id);
      useHelpPanelStore.getState().clearHibernateSession(id);
      set({ isLoading: false });
    } catch (error) {
      logErrorWithContext(error, {
        operation: "remove_project",
        component: "projectStore",
        details: { projectId: id },
      });
      set({ error: "Failed to remove project", isLoading: false });
    }
  },

  closeProject: async (projectId, options) => {
    const currentProjectId = get().currentProject?.id;

    // Prevent closing active project unless explicitly killing terminals (stop mode).
    if (projectId === currentProjectId && !options?.killTerminals) {
      throw new Error("Cannot close the active project. Switch to another project first.");
    }

    try {
      const result = await projectClient.close(projectId, options);

      const action = options?.killTerminals ? "killed" : "backgrounded";
      logDebug("[ProjectStore] Closed project", { action, projectId });

      // Refresh project list to get updated status
      await get().loadProjects();

      return result;
    } catch (error) {
      logErrorWithContext(error, {
        operation: "close_project",
        component: "projectStore",
        details: { projectId, killTerminals: options?.killTerminals },
      });
      throw error;
    }
  },

  closeActiveProject: async (projectId) => {
    const currentProjectId = get().currentProject?.id;
    if (projectId !== currentProjectId) {
      throw new Error("Project is not currently active");
    }

    cancelProjectReadRequests();

    try {
      // Closing the active project deletes its persisted panel state in main.
      // Drop any queued renderer-side saves so a debounce cannot rewrite the
      // just-deleted state while terminals are being killed.
      panelPersistence.cancel();
      const result = await projectClient.close(projectId, { killTerminals: true });
      panelPersistence.cancel();
      cancelProjectReadRequests();

      logDebug("[ProjectStore] Closed active project, transitioning to no-project state", {
        projectId,
      });

      clearFleetArmingThroughAccessor();
      set({ currentProject: null, worktreeLoadError: null });
      clearPanelStoreForSwitchThroughAccessor();
      await get().loadProjects();

      return result;
    } catch (error) {
      logErrorWithContext(error, {
        operation: "close_active_project",
        component: "projectStore",
        details: { projectId },
      });

      if (get().currentProject?.id === projectId) {
        cancelProjectReadRequests();
        set({ currentProject: null });
        void get().loadProjects();
      }

      throw error;
    }
  },

  reopenProject: async (projectId) => {
    const requestId = ++projectTransitionRequestId;
    const currentProjectId = get().currentProject?.id;

    // Flip the busy/switch flags first, then yield so the click stays responsive
    // before the heavy outgoing-state snapshot + IPC (see switchProject for the why).
    set({
      isLoading: true,
      isSwitching: true,
      switchingToProjectId: projectId,
      error: null,
      worktreeLoadError: null,
    });

    await yieldToPaint();
    if (requestId !== projectTransitionRequestId) return;

    const outgoingState = currentProjectId ? buildOutgoingState(currentProjectId) : undefined;
    projectClient.reopen(projectId, outgoingState).catch((error) => {
      if (requestId !== projectTransitionRequestId) {
        return;
      }
      logErrorWithContext(error, {
        operation: "reopen_project",
        component: "projectStore",
        details: { projectId },
      });
      const message = getProjectOpenErrorMessage(error);
      notify({
        type: "error",
        title: "Couldn't reopen project",
        message,
        actions: [
          {
            label: "Try again",
            variant: "primary",
            onClick: () => {
              void get().reopenProject(projectId);
            },
          },
        ],
      });
      // The reopen failed before the view swap, so this outgoing renderer stays
      // visible — clear the busy flag (mirrors switchProject). Guarded by the
      // requestId check above so a superseded reopen never clobbers a newer
      // transition's state.
      set({ error: message, isLoading: false, isSwitching: false, switchingToProjectId: null });
    });
  },

  checkMissingProjects: async () => {
    const requestId = projectListRequestId;
    try {
      await projectClient.checkMissing();
      const projects = await projectClient.getAll();
      if (requestId !== projectListRequestId) {
        return;
      }
      set({ projects });
    } catch (error) {
      logErrorWithContext(error, {
        operation: "check_missing_projects",
        component: "projectStore",
      });
    }
  },

  locateProject: async (projectId) => {
    try {
      const updated = await projectClient.locate(projectId);
      if (updated) {
        // Relocation regenerates the project id from its new path (sha256(path)),
        // so the pre-relocation id is now dead. GC its orphaned hibernate session.
        // Skip when the id is unchanged (canonicalization produced the same hash).
        if (updated.id !== projectId) {
          useHelpPanelStore.getState().clearHibernateSession(projectId);
        }
        const projects = await projectClient.getAll();
        set({ projects });
      }
    } catch (error) {
      logErrorWithContext(error, {
        operation: "locate_project",
        component: "projectStore",
        details: { projectId },
      });
    }
  },

  openGitInitDialog: (directoryPath: string) => {
    set({ gitInitDialogOpen: true, gitInitDirectoryPath: directoryPath });
  },

  closeGitInitDialog: () => {
    set({ gitInitDialogOpen: false, gitInitDirectoryPath: null });
  },

  handleGitInitSuccess: async () => {
    const directoryPath = get().gitInitDirectoryPath;
    get().closeGitInitDialog();
    if (directoryPath) {
      await get().addProjectByPath(directoryPath);
    }
  },

  openCreateFolderDialog: () => {
    set({ createFolderDialogOpen: true });
  },

  closeCreateFolderDialog: () => {
    set({ createFolderDialogOpen: false });
  },

  createProjectFolder: async (parentPath, folderName) => {
    const newFolderPath = await projectClient.createFolder(parentPath, folderName);
    await get().addProjectByPath(newFolderPath);
  },

  openCloneRepoDialog: () => {
    set({ cloneRepoDialogOpen: true });
  },

  closeCloneRepoDialog: () => {
    set({ cloneRepoDialogOpen: false });
  },

  handleCloneSuccess: async (clonedPath: string) => {
    get().closeCloneRepoDialog();
    await get().addProjectByPath(clonedPath);
  },
});

export const useProjectStore = create<ProjectState>()(
  subscribeWithSelector(
    persist(
      (...a) => ({
        ...createProjectStore(...a),
      }),
      {
        name: "project-storage",
        storage: createSafeJSONStorage(),
        partialize: (state) => ({
          // `lastKnownStats` is main-owned (issue #11078): it is written to the
          // SQLite project row on a clean stats poll and arrives here via boot
          // hydration and the project-switch broadcast. Persisting it locally
          // too would make this blob a second durable writer — and a lossy one,
          // since every `WebContentsView` serializes the whole `projects` array
          // from its own copy, so a view holding a stale snapshot would clobber
          // a newer one. Strip it and let main stay authoritative.
          projects: state.projects.map(({ lastKnownStats: _lastKnownStats, ...rest }) => rest),
        }),
        merge: (persistedState, currentState) => {
          const persisted = persistedState as { projects?: unknown } | undefined;
          const projects = Array.isArray(persisted?.projects)
            ? persisted.projects.filter(isPersistedProject)
            : currentState.projects;
          return {
            ...currentState,
            projects,
          };
        },
      }
    )
  )
);

registerPersistedStore({
  storeId: "projectStore",
  store: useProjectStore,
  persistedStateType: "{ projects: Project[] }",
});

// Break circular dependency by injecting project ID getter
panelPersistence.setProjectIdGetter(() => useProjectStore.getState().currentProject?.id);

// Keep this renderer's cached project state in sync when another renderer
// (e.g., the welcome view where the onboarding wizard ran) adds, updates,
// or removes a project. Each project view runs its own zustand store, so
// without these subscriptions a stale view will keep showing old project
// names or miss newly-added projects entirely.
if (typeof window !== "undefined" && window.electron?.project) {
  const listenerState = getProjectStoreListenerState();
  listenerState.applyUpdated = (updated) => {
    useProjectStore.setState((state) => {
      const exists = state.projects.some((p) => p.id === updated.id);
      const projects = exists
        ? state.projects.map((p) => (p.id === updated.id ? updated : p))
        : [...state.projects, updated];
      const currentProject =
        state.currentProject?.id === updated.id ? updated : state.currentProject;
      return { projects, currentProject };
    });
  };
  listenerState.applyRemoved = (projectId) => {
    useProjectStore.setState((state) => {
      const projects = state.projects.filter((p) => p.id !== projectId);
      const currentProject = state.currentProject?.id === projectId ? null : state.currentProject;
      return { projects, currentProject };
    });
  };
  // The worktree-load-status event resolves the banner for the project this
  // view now shows. The production path targets a single view, but the legacy
  // path broadcasts to every view (incl. LRU-cached other-project views), so
  // ignore events whose projectId doesn't match this view's current project.
  // The guard is *permissive*: a cold-started view may receive the event before
  // `getCurrentProject()` has populated `currentProject`, so a null
  // currentProject still accepts the targeted event rather than dropping it.
  listenerState.applyWorktreeLoadStatus = (payload) => {
    useProjectStore.setState((state) => {
      if (state.currentProject && state.currentProject.id !== payload.projectId) {
        return state;
      }
      return { worktreeLoadError: payload.worktreeLoadError };
    });
  };

  const projectApi = window.electron.project;
  if (projectApi.onUpdated && !listenerState.updatedRegistered) {
    listenerState.updatedRegistered = true;
    projectApi.onUpdated((updated) => {
      if (!updated || typeof updated !== "object") return;
      listenerState.applyUpdated?.(updated as Project);
    });
  }
  if (projectApi.onRemoved && !listenerState.removedRegistered) {
    listenerState.removedRegistered = true;
    projectApi.onRemoved((projectId) => {
      listenerState.applyRemoved?.(projectId);
    });
  }
  // Guarded like onUpdated/onRemoved above: partial environments (and test
  // doubles that only stub the methods they exercise) may not expose this.
  if (
    typeof projectClient.onWorktreeLoadStatus === "function" &&
    !listenerState.worktreeLoadStatusRegistered
  ) {
    listenerState.worktreeLoadStatusRegistered = true;
    projectClient.onWorktreeLoadStatus((payload) => {
      listenerState.applyWorktreeLoadStatus?.(payload);
    });
  }
}
