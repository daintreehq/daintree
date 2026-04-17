import { create, type StateCreator } from "zustand";
import { persist, subscribeWithSelector } from "zustand/middleware";
import type { Project, ProjectCloseResult } from "@shared/types";
import { projectClient } from "@/clients";
import { notify } from "@/lib/notify";
import { logErrorWithContext } from "@/utils/errorContext";
import { logDebug } from "@/utils/logger";
import { useUrlHistoryStore } from "./urlHistoryStore";
import { createSafeJSONStorage } from "./persistence/safeStorage";
import { registerPersistedStore } from "./persistence/persistedStoreRegistry";
import { panelPersistence, panelToSnapshot } from "./persistence/panelPersistence";
import { useTerminalInputStore } from "./terminalInputStore";
import { isSmokeTestTerminalId } from "@shared/utils/smokeTestTerminals";
import type { ProjectSwitchOutgoingState } from "@shared/types/ipc/project";
import type { TerminalInstance, TabGroup } from "@shared/types";

function shouldPersistTerminal(t: TerminalInstance): boolean {
  return (
    t.location !== "trash" &&
    t.location !== "background" &&
    t.kind !== "assistant" &&
    !isSmokeTestTerminalId(t.id)
  );
}

// Lazy reference to usePanelStore to break circular dependency.
// Injected at module-init time from panelStore.ts (same pattern as
// panelPersistence.setProjectIdGetter).
let _getPanelStoreState:
  | (() => {
      panelsById: Record<string, TerminalInstance>;
      panelIds: string[];
      tabGroups: Map<string, TabGroup>;
    })
  | null = null;

export function setPanelStoreGetter(
  getter: () => {
    panelsById: Record<string, TerminalInstance>;
    panelIds: string[];
    tabGroups: Map<string, TabGroup>;
  }
): void {
  _getPanelStoreState = getter;
}

// Lazy reference to useWorktreeSelectionStore to break circular dependency.
// worktreeStore → terminalInstanceService → terminalStore → setPanelStoreGetter
// would create a TDZ error if imported statically.
let _getWorktreeSelectionState: (() => { activeWorktreeId: string | null }) | null = null;

export function setWorktreeSelectionStoreGetter(
  getter: () => { activeWorktreeId: string | null }
): void {
  _getWorktreeSelectionState = getter;
}

// Lazy reference to the fleet-arming store's clear() so a project switch can
// drop armed selections synchronously before the WebContentsView gets detached.
// Registered from fleetArmingStore at module init.
let _clearFleetArming: (() => void) | null = null;

export function setFleetArmingClear(callback: () => void): void {
  _clearFleetArming = callback;
}

function buildOutgoingState(projectId: string): ProjectSwitchOutgoingState {
  const draftInputs = useTerminalInputStore.getState().getProjectDraftInputs(projectId);
  const activeWorktreeId = _getWorktreeSelectionState?.()?.activeWorktreeId ?? undefined;

  // Synchronously snapshot terminal state from the Zustand store before the
  // renderer gets detached.  This captures browser/dev-preview panel state
  // that would otherwise be lost because the debounced persistence hasn't
  // flushed yet.  Uses the same filter as PanelPersistence.save().
  const terminalState = _getPanelStoreState?.();
  if (!terminalState) {
    return { draftInputs, activeWorktreeId };
  }

  const { panelsById, panelIds, tabGroups } = terminalState;

  const terminals = panelIds
    .map((id) => panelsById[id])
    .filter((t): t is TerminalInstance => t != null && shouldPersistTerminal(t))
    .map(panelToSnapshot);

  const tabGroupArray = Array.from(tabGroups.values()).filter((g) => g.panelIds.length > 1);

  return {
    terminals,
    draftInputs,
    tabGroups: tabGroupArray,
    activeWorktreeId,
  };
}

interface ProjectState {
  projects: Project[];
  currentProject: Project | null;
  isLoading: boolean;
  error: string | null;
  gitInitDialogOpen: boolean;
  gitInitDirectoryPath: string | null;
  onboardingWizardOpen: boolean;
  onboardingProjectId: string | null;
  createFolderDialogOpen: boolean;
  cloneRepoDialogOpen: boolean;

  loadProjects: () => Promise<void>;
  getCurrentProject: () => Promise<void>;
  addProject: () => Promise<void>;
  addProjectByPath: (path: string) => Promise<void>;
  createProjectFolder: (parentPath: string, folderName: string) => Promise<void>;
  switchProject: (projectId: string) => Promise<void>;
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
  closeOnboardingWizard: () => void;
  openOnboardingWizard: (projectId: string) => void;
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
  updatedRegistered: boolean;
  removedRegistered: boolean;
}

const PROJECT_STORE_LISTENER_STATE_KEY = "__daintreeProjectStoreListenerState";

let projectTransitionRequestId = 0;
let projectListRequestId = 0;

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
    updatedRegistered: false,
    removedRegistered: false,
  };
  target[PROJECT_STORE_LISTENER_STATE_KEY] = created;
  return created;
}

function getProjectOpenErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (lower.includes("spawn git enoent") || lower.includes("git: not found")) {
    return "Git executable not found. Install Git and ensure it is available on your PATH.";
  }

  if (lower.includes("dubious ownership") || lower.includes("safe.directory")) {
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

  if (message.includes("ENOENT")) {
    return "The selected directory does not exist.";
  }

  if (message.includes("EACCES") || message.includes("EPERM")) {
    return "Permission denied. You don't have access to this directory.";
  }

  return message || "Failed to open project.";
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
  gitInitDialogOpen: false,
  gitInitDirectoryPath: null,
  onboardingWizardOpen: false,
  onboardingProjectId: null,
  createFolderDialogOpen: false,
  cloneRepoDialogOpen: false,
  error: null,

  addProjectByPath: async (path) => {
    set({ isLoading: true, error: null });
    let resolvedPath: string | undefined | null;
    try {
      resolvedPath = path.trim() || (await projectClient.openDialog());
      if (!resolvedPath) {
        set({ isLoading: false });
        return;
      }

      const existingProjectIds = new Set(get().projects.map((p) => p.id));
      const newProject = await projectClient.add(resolvedPath);
      const isNewProject = !existingProjectIds.has(newProject.id);

      await get().loadProjects();

      if (isNewProject) {
        // Open the onboarding wizard on the current view; the switch to the
        // new project happens when the wizard finishes. Swapping views first
        // strands the wizard in the deactivated (background-throttled) view,
        // where React state updates stall and the Finish button stays disabled.
        set({
          isLoading: false,
          onboardingWizardOpen: true,
          onboardingProjectId: newProject.id,
        });
      } else {
        await get().switchProject(newProject.id);
      }
    } catch (error) {
      logErrorWithContext(error, {
        operation: "add_project",
        component: "projectStore",
        details: { path: resolvedPath || path },
      });
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (errorMessage.includes("Not a git repository")) {
        const gitInitPath =
          resolvedPath || path.trim() || errorMessage.match(/Not a git repository: (.+)/)?.[1];
        const isAbsolutePath = (p: string) => p.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(p);
        if (gitInitPath && isAbsolutePath(gitInitPath)) {
          set({ isLoading: false });
          get().openGitInitDialog(gitInitPath);
          return;
        }
      }

      const message = getProjectOpenErrorMessage(error);
      notify({
        type: "error",
        title: "Failed to add project",
        message,
        duration: 6000,
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
      set({ projects, isLoading: false });
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
    set({ isLoading: true, error: null });
    try {
      const currentProject = await projectClient.getCurrent();
      set({ currentProject, isLoading: false });
    } catch (error) {
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

  switchProject: async (projectId) => {
    if (get().currentProject?.id === projectId) return;
    const requestId = ++projectTransitionRequestId;

    // Drop fleet arming selections synchronously — the outgoing view's armed
    // set is project-scoped and must not leak if the view is later restored
    // from the LRU cache.
    _clearFleetArming?.();

    // Capture outgoing state before the renderer gets detached
    const currentProjectId = get().currentProject?.id;
    const outgoingState = currentProjectId ? buildOutgoingState(currentProjectId) : undefined;

    set({ isLoading: true, error: null });
    // Fire-and-forget: the main process swaps WebContentsViews, so this
    // renderer gets detached. Don't write the response into stores — the
    // new view handles its own state independently.
    projectClient.switch(projectId, outgoingState).catch((error) => {
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
        title: "Failed to switch project",
        message,
        duration: 6000,
      });
      set({ error: message, isLoading: false });
    });
  },

  updateProject: async (id, updates) => {
    set({ isLoading: true, error: null });
    try {
      await projectClient.update(id, updates);
      await get().loadProjects();
      if (get().currentProject?.id === id) {
        await get().getCurrentProject();
      }
      set({ isLoading: false });
    } catch (error) {
      logErrorWithContext(error, {
        operation: "update_project",
        component: "projectStore",
        details: { projectId: id, updates },
      });
      set({ error: "Failed to update project", isLoading: false });
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
      if (get().onboardingProjectId === id) {
        set({ onboardingWizardOpen: false, onboardingProjectId: null });
      }
      useUrlHistoryStore.getState().removeProjectHistory(id);
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

      if (!result.success) {
        throw new Error(result.error || "Failed to close project");
      }

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

    try {
      const result = await projectClient.close(projectId, { killTerminals: true });

      if (!result.success) {
        throw new Error(result.error || "Failed to close project");
      }

      logDebug("[ProjectStore] Closed active project, transitioning to no-project state", {
        projectId,
      });

      set({ currentProject: null });
      await get().loadProjects();

      return result;
    } catch (error) {
      logErrorWithContext(error, {
        operation: "close_active_project",
        component: "projectStore",
        details: { projectId },
      });

      if (get().currentProject?.id === projectId) {
        set({ currentProject: null });
        void get().loadProjects();
      }

      throw error;
    }
  },

  reopenProject: async (projectId) => {
    const requestId = ++projectTransitionRequestId;
    const currentProjectId = get().currentProject?.id;
    const outgoingState = currentProjectId ? buildOutgoingState(currentProjectId) : undefined;

    set({ isLoading: true, error: null });
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
        title: "Failed to reopen project",
        message,
        duration: 6000,
      });
      set({ error: message, isLoading: false });
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

  closeOnboardingWizard: () => {
    set({ onboardingWizardOpen: false, onboardingProjectId: null });
  },

  openOnboardingWizard: (projectId) => {
    set({ onboardingWizardOpen: true, onboardingProjectId: projectId });
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
          projects: state.projects,
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
}
