import { create, type StateCreator } from "zustand";
import type { Project, ProjectCloseResult } from "@shared/types";
import { projectClient, appClient } from "@/clients";
import { resetAllStoresForProjectSwitch } from "./resetStores";
import { flushTerminalPersistence } from "./slices";
import { useNotificationStore } from "./notificationStore";

interface ProjectState {
  projects: Project[];
  currentProject: Project | null;
  isLoading: boolean;
  error: string | null;

  loadProjects: () => Promise<void>;
  getCurrentProject: () => Promise<void>;
  addProject: () => Promise<void>;
  addProjectByPath: (path: string) => Promise<void>;
  switchProject: (projectId: string) => Promise<void>;
  updateProject: (id: string, updates: Partial<Project>) => Promise<void>;
  removeProject: (id: string) => Promise<void>;
  closeProject: (
    projectId: string,
    options?: { killTerminals?: boolean }
  ) => Promise<ProjectCloseResult>;
  reopenProject: (projectId: string) => Promise<void>;
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
  error: null,

  addProjectByPath: async (path) => {
    set({ isLoading: true, error: null });
    try {
      const resolvedPath = path.trim() || (await projectClient.openDialog());
      if (!resolvedPath) {
        set({ isLoading: false });
        return;
      }

      const newProject = await projectClient.add(resolvedPath);

      await get().loadProjects();
      await get().switchProject(newProject.id);
    } catch (error) {
      console.error("Failed to add project:", error);
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
      console.error("Failed to load projects:", error);
      set({ error: "Failed to load projects", isLoading: false });
    }
  },

  getCurrentProject: async () => {
    set({ isLoading: true, error: null });
    try {
      const currentProject = await projectClient.getCurrent();
      set({ currentProject, isLoading: false });
    } catch (error) {
      console.error("Failed to get current project:", error);
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
    set({ isLoading: true, error: null });
    try {
      const currentProject = get().currentProject;
      const oldProjectId = currentProject?.id;

      // Save current project state BEFORE switching
      // The backend persists terminals to electron-store so they're restored on hydration
      if (oldProjectId) {
        flushTerminalPersistence(); // ensure debounced terminal state is persisted
        console.log("[ProjectSwitch] Saving state for project:", oldProjectId);
        try {
          const currentState = await appClient.getState();
          if (currentState) {
            // Save current terminal state - backend handles per-project persistence
            await appClient.setState({
              terminals: currentState.terminals || [],
              activeWorktreeId: currentState.activeWorktreeId,
              terminalGridConfig: currentState.terminalGridConfig,
            });
          }
        } catch (saveError) {
          // Don't fail the switch if state save fails
          console.warn("[ProjectSwitch] Failed to save state:", saveError);
        }
      }

      console.log("[ProjectSwitch] Resetting renderer stores...");
      await resetAllStoresForProjectSwitch();

      console.log("[ProjectSwitch] Switching project in main process...");
      const project = await projectClient.switch(projectId);
      set({ currentProject: project, isLoading: false });

      await get().loadProjects();

      console.log("[ProjectSwitch] Triggering state re-hydration...");
      window.dispatchEvent(new CustomEvent("project-switched"));
    } catch (error) {
      console.error("Failed to switch project:", error);
      const message = getProjectOpenErrorMessage(error);
      useNotificationStore.getState().addNotification({
        type: "error",
        title: "Failed to switch project",
        message,
        duration: 6000,
      });
      set({ error: message, isLoading: false });
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
      console.error("Failed to update project:", error);
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
      set({ isLoading: false });
    } catch (error) {
      console.error("Failed to remove project:", error);
      set({ error: "Failed to remove project", isLoading: false });
    }
  },

  closeProject: async (projectId, options) => {
    const currentProjectId = get().currentProject?.id;

    // Prevent closing active project
    if (projectId === currentProjectId) {
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
      console.error(`[ProjectStore] Failed to close project ${projectId}:`, error);
      throw error;
    }
  },

  reopenProject: async (projectId) => {
    set({ isLoading: true, error: null });
    try {
      const currentProject = get().currentProject;
      const oldProjectId = currentProject?.id;

      // Save current project state BEFORE switching (same as switchProject)
      if (oldProjectId) {
        flushTerminalPersistence();
        console.log("[ProjectStore] Saving state before reopen:", oldProjectId);
        try {
          const currentState = await appClient.getState();
          if (currentState) {
            await appClient.setState({
              terminals: currentState.terminals || [],
              activeWorktreeId: currentState.activeWorktreeId,
              terminalGridConfig: currentState.terminalGridConfig,
            });
          }
        } catch (saveError) {
          console.warn("[ProjectStore] Failed to save state:", saveError);
        }
      }

      console.log("[ProjectStore] Resetting renderer stores...");
      await resetAllStoresForProjectSwitch();

      console.log("[ProjectStore] Reopening project...");
      const project = await projectClient.reopen(projectId);
      set({ currentProject: project, isLoading: false });

      await get().loadProjects();

      console.log("[ProjectStore] Triggering state re-hydration...");
      window.dispatchEvent(new CustomEvent("project-switched"));
    } catch (error) {
      console.error("Failed to reopen project:", error);
      const message = getProjectOpenErrorMessage(error);
      set({ error: message, isLoading: false });
      throw error;
    }
  },
});

export const useProjectStore = create<ProjectState>()(createProjectStore);
