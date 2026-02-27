import { create, type StateCreator } from "zustand";
import {
  persist,
  subscribeWithSelector,
  createJSONStorage,
  type StateStorage,
} from "zustand/middleware";
import type { Project, ProjectCloseResult, TerminalSnapshot } from "@shared/types";
import { projectClient } from "@/clients";
import { resetAllStoresForProjectSwitch } from "./resetStores";
import {
  forceReinitializeWorktreeDataStore,
  prePopulateWorktreeSnapshot,
  snapshotProjectWorktrees,
} from "./worktreeDataStore";
import { flushTerminalPersistence } from "./slices";
import { terminalPersistence, terminalToSnapshot } from "./persistence/terminalPersistence";
import { useNotificationStore } from "./notificationStore";
import { useTerminalStore } from "./terminalStore";
import { useWorktreeSelectionStore } from "./worktreeStore";
import {
  useProjectSettingsStore,
  snapshotProjectSettings,
  prePopulateProjectSettings,
} from "./projectSettingsStore";
import { logErrorWithContext } from "@/utils/errorContext";
import {
  prepareProjectSwitchRendererCache,
  cancelPreparedProjectSwitchRendererCache,
} from "@/services/projectSwitchRendererCache";

interface ProjectState {
  projects: Project[];
  currentProject: Project | null;
  isLoading: boolean;
  isSwitching: boolean;
  switchingToProjectName: string | null;
  error: string | null;
  gitInitDialogOpen: boolean;
  gitInitDirectoryPath: string | null;
  onboardingWizardOpen: boolean;
  onboardingProjectId: string | null;
  createFolderDialogOpen: boolean;

  loadProjects: () => Promise<void>;
  getCurrentProject: () => Promise<void>;
  addProject: () => Promise<void>;
  addProjectByPath: (path: string) => Promise<void>;
  createProjectFolder: (parentPath: string, folderName: string) => Promise<void>;
  switchProject: (projectId: string) => Promise<void>;
  updateProject: (id: string, updates: Partial<Project>) => Promise<void>;
  removeProject: (id: string) => Promise<void>;
  closeProject: (
    projectId: string,
    options?: { killTerminals?: boolean }
  ) => Promise<ProjectCloseResult>;
  reopenProject: (projectId: string) => Promise<void>;
  finishProjectSwitch: () => void;
  openGitInitDialog: (directoryPath: string) => void;
  closeGitInitDialog: () => void;
  handleGitInitSuccess: () => Promise<void>;
  closeOnboardingWizard: () => void;
  openCreateFolderDialog: () => void;
  closeCreateFolderDialog: () => void;
}

const memoryStorage: StateStorage = (() => {
  const storage = new Map<string, string>();
  return {
    getItem: (name) => storage.get(name) ?? null,
    setItem: (name, value) => {
      storage.set(name, value);
    },
    removeItem: (name) => {
      storage.delete(name);
    },
  };
})();

function getSafeStorage(): StateStorage {
  if (typeof localStorage !== "undefined") {
    const storage = localStorage as unknown as Partial<StateStorage>;
    const hasStorageApi =
      typeof storage.getItem === "function" &&
      typeof storage.setItem === "function" &&
      typeof storage.removeItem === "function";
    if (hasStorageApi) {
      try {
        storage.getItem!("__test__");
        return storage as StateStorage;
      } catch {
        return memoryStorage;
      }
    }
  }
  return memoryStorage;
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

// Monotonically incrementing counter to ignore stale background switch callbacks.
// Captured before each projectClient.switch/reopen call; checked in .then/.catch.
let switchEpoch = 0;

function evictRendererTerminalInstances(terminalIds: string[]): void {
  if (terminalIds.length === 0) {
    return;
  }

  void import("@/services/TerminalInstanceService")
    .then(({ terminalInstanceService }) => {
      for (const terminalId of terminalIds) {
        terminalInstanceService.destroy(terminalId);
      }
    })
    .catch((error) => {
      logErrorWithContext(error, {
        operation: "evict_project_switch_terminal_instances",
        component: "projectStore",
        errorType: "process",
        details: { terminalCount: terminalIds.length },
      });
    });
}

const createProjectStore: StateCreator<ProjectState> = (set, get) => ({
  projects: [],
  currentProject: null,
  isLoading: false,
  isSwitching: false,
  switchingToProjectName: null,
  gitInitDialogOpen: false,
  gitInitDirectoryPath: null,
  onboardingWizardOpen: false,
  onboardingProjectId: null,
  createFolderDialogOpen: false,
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
      await get().switchProject(newProject.id);

      if (isNewProject) {
        set({ onboardingWizardOpen: true, onboardingProjectId: newProject.id });
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
      useNotificationStore.getState().addNotification({
        type: "error",
        title: "Failed to add project",
        message,
        duration: 6000,
      });
      set({ error: message, isLoading: false });
    }
  },

  loadProjects: async () => {
    set({ isLoading: true, error: null });
    try {
      const projects = await projectClient.getAll();
      set({ projects, isLoading: false });
    } catch (error) {
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
    const currentProjectId = get().currentProject?.id ?? null;
    if (currentProjectId === projectId) {
      return;
    }

    const targetProject = get().projects.find((p) => p.id === projectId);
    const currentProject = get().currentProject;
    const oldProjectId = currentProject?.id ?? null;
    let preserveTerminalIds = new Set<string>();

    set({
      isLoading: true,
      isSwitching: true,
      switchingToProjectName: targetProject?.name ?? null,
      error: null,
    });
    try {
      // Save current project's panel state BEFORE switching
      if (oldProjectId) {
        // Flush persistence in the background, but don't block switch latency.
        // We persist from in-memory store state below.
        flushTerminalPersistence();
        void terminalPersistence.whenIdle().catch((error) => {
          logErrorWithContext(error, {
            operation: "wait_terminal_persistence_before_switch",
            component: "projectStore",
            errorType: "filesystem",
            details: { oldProjectId },
          });
        });

        // Get current terminals from store and save to per-project state
        const currentTerminals = useTerminalStore.getState().terminals;
        const terminalsToSave: TerminalSnapshot[] = currentTerminals
          .filter((t) => t.location !== "trash")
          .map(terminalToSnapshot);

        const terminalSizes: Record<string, { cols: number; rows: number }> = {};
        const { terminalInstanceService } = await import("@/services/TerminalInstanceService");
        for (const terminal of currentTerminals) {
          const instance = terminalInstanceService.get(terminal.id);
          if (instance) {
            terminalSizes[terminal.id] = {
              cols: instance.latestCols,
              rows: instance.latestRows,
            };
          }
        }

        console.log(
          `[ProjectSwitch] Saving ${terminalsToSave.length} panel(s) to per-project state`
        );
        // Fire saves sequentially in the background — don't block the switch on their completion.
        // Sequential chaining is required: both IPC handlers do a read-modify-write of the full
        // ProjectState JSON, so running them concurrently would cause a last-writer-wins race.
        // They only need to finish before the old project is re-opened.
        // Risk: data loss if the app crashes between fire and persist — acceptable trade-off.
        void projectClient
          .setTerminals(oldProjectId, terminalsToSave)
          .then(() => projectClient.setTerminalSizes(oldProjectId, terminalSizes))
          .catch((saveError) => {
            logErrorWithContext(saveError, {
              operation: "save_panel_state_before_switch",
              component: "projectStore",
              errorType: "filesystem",
              details: { oldProjectId, terminalCount: terminalsToSave.length },
            });
          });

        const preparedCache = prepareProjectSwitchRendererCache({
          outgoingProjectId: oldProjectId,
          targetProjectId: projectId,
          outgoingActiveWorktreeId: useWorktreeSelectionStore.getState().activeWorktreeId ?? null,
          outgoingTerminals: terminalsToSave.map((terminal) => ({
            id: terminal.id,
            worktreeId: terminal.worktreeId,
          })),
        });

        preserveTerminalIds = preparedCache.preserveTerminalIds;
        evictRendererTerminalInstances(preparedCache.evictTerminalIds);
      }

      // Snapshot outgoing project state before clearing stores so we can
      // pre-populate on switch-back (stale-while-revalidate).
      if (oldProjectId) {
        snapshotProjectWorktrees(oldProjectId);
        snapshotProjectSettings(oldProjectId);
      }

      console.log("[ProjectSwitch] Resetting renderer stores...");
      await resetAllStoresForProjectSwitch({
        preserveTerminalIds,
      });

      // Pre-populate stores from cached snapshots for an instant UI.
      console.log("[ProjectSwitch] Pre-populating snapshots...");
      prePopulateWorktreeSnapshot(projectId);
      prePopulateProjectSettings(projectId);

      // Set currentProject optimistically from the already-loaded project list.
      // The main process switch will confirm this (or error/rollback).
      if (targetProject) {
        set({ currentProject: targetProject, isLoading: false });
      }

      // Load fresh project settings in the background (will update cache when done)
      console.log("[ProjectSwitch] Loading project settings (background)...");
      void useProjectSettingsStore.getState().loadSettings(projectId);

      // Fire the main process switch in the background — don't block the UI.
      // When it completes, fetch fresh worktree data from the now-loaded workspace.
      console.log("[ProjectSwitch] Switching project in main process (background)...");
      const capturedEpoch = ++switchEpoch;
      projectClient
        .switch(projectId)
        .then((project) => {
          if (switchEpoch !== capturedEpoch) return; // Stale — user switched again
          // Update with the authoritative project data from the main process
          set({ currentProject: project, isLoading: false });

          // Now that backend has switched, fetch fresh worktree data
          console.log("[ProjectSwitch] Reinitializing worktree data store...");
          forceReinitializeWorktreeDataStore(projectId);

          // Refresh project list in the background
          void get().loadProjects();
        })
        .catch((error) => {
          if (switchEpoch !== capturedEpoch) return; // Stale — user switched again
          cancelPreparedProjectSwitchRendererCache(oldProjectId);
          logErrorWithContext(error, {
            operation: "switch_project",
            component: "projectStore",
            details: { projectId, targetProjectName: targetProject?.name },
          });
          const message = getProjectOpenErrorMessage(error);
          useNotificationStore.getState().addNotification({
            type: "error",
            title: "Failed to switch project",
            message,
            duration: 6000,
          });
          set({
            error: message,
            currentProject: currentProject,
            isLoading: false,
            isSwitching: false,
            switchingToProjectName: null,
          });
          // Restore cached state for the outgoing project so the UI isn't blank.
          if (oldProjectId) {
            prePopulateWorktreeSnapshot(oldProjectId);
            prePopulateProjectSettings(oldProjectId);
          }
          forceReinitializeWorktreeDataStore(oldProjectId ?? undefined);
        });

      // Note: State re-hydration is triggered by PROJECT_ON_SWITCH IPC event
      // which is handled in useProjectSwitchRehydration. We don't dispatch
      // project-switched here to avoid duplicate hydration.
    } catch (error) {
      // This catch handles errors from the synchronous setup phase
      // (store resets, snapshot, terminal persistence, etc.)
      cancelPreparedProjectSwitchRendererCache(oldProjectId);
      logErrorWithContext(error, {
        operation: "switch_project_setup",
        component: "projectStore",
        details: { projectId, targetProjectName: targetProject?.name },
      });
      const message = getProjectOpenErrorMessage(error);
      useNotificationStore.getState().addNotification({
        type: "error",
        title: "Failed to switch project",
        message,
        duration: 6000,
      });
      set({ error: message, isLoading: false, isSwitching: false, switchingToProjectName: null });
      if (oldProjectId) {
        prePopulateWorktreeSnapshot(oldProjectId);
        prePopulateProjectSettings(oldProjectId);
      }
      forceReinitializeWorktreeDataStore(oldProjectId ?? undefined);
    }
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
      console.log(`[ProjectStore] Closed (${action}) project ${projectId}`);

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

  reopenProject: async (projectId) => {
    const targetProject = get().projects.find((p) => p.id === projectId);
    const currentProject = get().currentProject;
    const oldProjectId = currentProject?.id ?? null;
    let preserveTerminalIds = new Set<string>();

    set({
      isLoading: true,
      isSwitching: true,
      switchingToProjectName: targetProject?.name ?? null,
      error: null,
    });
    try {
      // Save current project's panel state BEFORE switching (same as switchProject)
      if (oldProjectId) {
        // Flush persistence in the background, but don't block switch latency.
        // We persist from in-memory store state below.
        flushTerminalPersistence();
        void terminalPersistence.whenIdle().catch((error) => {
          logErrorWithContext(error, {
            operation: "wait_terminal_persistence_before_reopen",
            component: "projectStore",
            errorType: "filesystem",
            details: { oldProjectId },
          });
        });

        // Get current terminals from store and save to per-project state
        const currentTerminals = useTerminalStore.getState().terminals;
        const terminalsToSave: TerminalSnapshot[] = currentTerminals
          .filter((t) => t.location !== "trash")
          .map(terminalToSnapshot);

        const terminalSizes: Record<string, { cols: number; rows: number }> = {};
        const { terminalInstanceService } = await import("@/services/TerminalInstanceService");
        for (const terminal of currentTerminals) {
          const instance = terminalInstanceService.get(terminal.id);
          if (instance) {
            terminalSizes[terminal.id] = {
              cols: instance.latestCols,
              rows: instance.latestRows,
            };
          }
        }

        console.log(`[ProjectStore] Saving ${terminalsToSave.length} panel(s) before reopen`);
        try {
          await projectClient.setTerminals(oldProjectId, terminalsToSave);
          await projectClient.setTerminalSizes(oldProjectId, terminalSizes);
        } catch (saveError) {
          logErrorWithContext(saveError, {
            operation: "save_panel_state_before_reopen",
            component: "projectStore",
            errorType: "filesystem",
            details: { oldProjectId, terminalCount: terminalsToSave.length },
          });
        }

        const preparedCache = prepareProjectSwitchRendererCache({
          outgoingProjectId: oldProjectId,
          targetProjectId: projectId,
          outgoingActiveWorktreeId: useWorktreeSelectionStore.getState().activeWorktreeId ?? null,
          outgoingTerminals: terminalsToSave.map((terminal) => ({
            id: terminal.id,
            worktreeId: terminal.worktreeId,
          })),
        });

        preserveTerminalIds = preparedCache.preserveTerminalIds;
        evictRendererTerminalInstances(preparedCache.evictTerminalIds);
      }

      // Snapshot outgoing project state before clearing stores
      if (oldProjectId) {
        snapshotProjectWorktrees(oldProjectId);
        snapshotProjectSettings(oldProjectId);
      }

      console.log("[ProjectStore] Resetting renderer stores...");
      await resetAllStoresForProjectSwitch({
        preserveTerminalIds,
      });

      // Pre-populate stores from cached snapshots for an instant UI.
      console.log("[ProjectStore] Pre-populating snapshots...");
      prePopulateWorktreeSnapshot(projectId);
      prePopulateProjectSettings(projectId);

      // Set currentProject optimistically
      if (targetProject) {
        set({ currentProject: targetProject, isLoading: false });
      }

      // Load fresh project settings in the background (will update cache when done)
      console.log("[ProjectStore] Loading project settings (background)...");
      void useProjectSettingsStore.getState().loadSettings(projectId);

      // Fire the main process reopen in the background
      console.log("[ProjectStore] Reopening project in main process (background)...");
      const capturedEpoch = ++switchEpoch;
      projectClient
        .reopen(projectId)
        .then((project) => {
          if (switchEpoch !== capturedEpoch) return; // Stale — user switched again
          set({ currentProject: project, isLoading: false });

          console.log("[ProjectStore] Reinitializing worktree data store...");
          forceReinitializeWorktreeDataStore(projectId);

          void get().loadProjects();
        })
        .catch((error) => {
          if (switchEpoch !== capturedEpoch) return; // Stale — user switched again
          cancelPreparedProjectSwitchRendererCache(oldProjectId);
          logErrorWithContext(error, {
            operation: "reopen_project",
            component: "projectStore",
            details: { projectId, targetProjectName: targetProject?.name },
          });
          const message = getProjectOpenErrorMessage(error);
          useNotificationStore.getState().addNotification({
            type: "error",
            title: "Failed to reopen project",
            message,
            duration: 6000,
          });
          set({
            error: message,
            currentProject: currentProject,
            isLoading: false,
            isSwitching: false,
            switchingToProjectName: null,
          });
          if (oldProjectId) {
            prePopulateWorktreeSnapshot(oldProjectId);
            prePopulateProjectSettings(oldProjectId);
          }
          forceReinitializeWorktreeDataStore(oldProjectId ?? undefined);
        });

      // Note: State re-hydration is triggered by PROJECT_ON_SWITCH IPC event
    } catch (error) {
      cancelPreparedProjectSwitchRendererCache(oldProjectId);
      logErrorWithContext(error, {
        operation: "reopen_project_setup",
        component: "projectStore",
        details: { projectId, targetProjectName: targetProject?.name },
      });
      const message = getProjectOpenErrorMessage(error);
      useNotificationStore.getState().addNotification({
        type: "error",
        title: "Failed to reopen project",
        message,
        duration: 6000,
      });
      set({ error: message, isLoading: false, isSwitching: false, switchingToProjectName: null });
      if (oldProjectId) {
        prePopulateWorktreeSnapshot(oldProjectId);
        prePopulateProjectSettings(oldProjectId);
      }
      forceReinitializeWorktreeDataStore(oldProjectId ?? undefined);
      throw error;
    }
  },

  finishProjectSwitch: () => {
    set({ isSwitching: false, switchingToProjectName: null });
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
});

export const useProjectStore = create<ProjectState>()(
  subscribeWithSelector(
    persist(
      (...a) => ({
        ...createProjectStore(...a),
      }),
      {
        name: "project-storage",
        storage: createJSONStorage(() => getSafeStorage()),
        partialize: (state) => ({
          projects: state.projects,
          currentProject: state.currentProject,
        }),
      }
    )
  )
);

// Break circular dependency by injecting project ID getter
terminalPersistence.setProjectIdGetter(() => useProjectStore.getState().currentProject?.id);
