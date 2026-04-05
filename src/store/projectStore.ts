import { create, type StateCreator } from "zustand";
import { persist, subscribeWithSelector } from "zustand/middleware";
import type { Project, ProjectCloseResult } from "@shared/types";
import { projectClient } from "@/clients";
import { notify } from "@/lib/notify";
import { logErrorWithContext } from "@/utils/errorContext";
import { logDebug } from "@/utils/logger";
import { useUrlHistoryStore } from "./urlHistoryStore";
import { createSafeJSONStorage } from "./persistence/safeStorage";
import { terminalPersistence } from "./persistence/terminalPersistence";
import { useTerminalInputStore } from "./terminalInputStore";
import type { ProjectSwitchOutgoingState } from "@shared/types/ipc/project";

function buildOutgoingState(projectId: string): ProjectSwitchOutgoingState | undefined {
  const draftInputs = useTerminalInputStore.getState().getProjectDraftInputs(projectId);
  const hasDrafts = Object.keys(draftInputs).length > 0;
  if (!hasDrafts) return undefined;
  return { draftInputs };
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
    set({ isLoading: true, error: null });
    try {
      const projects = await projectClient.getAll();
      set({ projects, isLoading: false });
      // Check for missing directories in the background after updating the list
      void get().checkMissingProjects();
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
    if (get().currentProject?.id === projectId) return;

    // Capture outgoing state before the renderer gets detached
    const currentProjectId = get().currentProject?.id;
    const outgoingState = currentProjectId ? buildOutgoingState(currentProjectId) : undefined;

    set({ isLoading: true, error: null });
    // Fire-and-forget: the main process swaps WebContentsViews, so this
    // renderer gets detached. Don't write the response into stores — the
    // new view handles its own state independently.
    projectClient.switch(projectId, outgoingState).catch((error) => {
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
    const currentProjectId = get().currentProject?.id;
    const outgoingState = currentProjectId ? buildOutgoingState(currentProjectId) : undefined;

    set({ isLoading: true, error: null });
    projectClient.reopen(projectId, outgoingState).catch((error) => {
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
    try {
      await projectClient.checkMissing();
      const projects = await projectClient.getAll();
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
      }
    )
  )
);

// Break circular dependency by injecting project ID getter
terminalPersistence.setProjectIdGetter(() => useProjectStore.getState().currentProject?.id);
