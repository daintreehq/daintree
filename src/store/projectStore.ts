import { create, type StateCreator } from "zustand";
import type { Project, ProjectCloseResult } from "@shared/types";
import { projectClient } from "@/clients";
import { resetAllStoresForProjectSwitch } from "./resetStores";
import { forceReinitializeWorktreeDataStore } from "./worktreeDataStore";
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
  closeProject: (projectId: string) => Promise<ProjectCloseResult>;
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
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (errorMessage.includes("Not a git repository")) {
        const resolvedPath = path.trim() || errorMessage.match(/Not a git repository: (.+)/)?.[1];
        if (resolvedPath) {
          useNotificationStore.getState().addNotification({
            type: "warning",
            title: "Not a Git repository",
            message: "Would you like to initialize a Git repository in this directory?",
            duration: 0,
            action: {
              label: "Initialize Git",
              onClick: async () => {
                try {
                  await projectClient.initGit(resolvedPath);
                  await get().addProjectByPath(resolvedPath);
                } catch (initError) {
                  console.error("Failed to initialize git:", initError);
                  useNotificationStore.getState().addNotification({
                    type: "error",
                    title: "Failed to initialize Git",
                    message:
                      initError instanceof Error ? initError.message : "Unknown error occurred",
                    duration: 6000,
                  });
                }
              },
            },
          });
          set({ isLoading: false });
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
      // Terminals stay running in the backend - no need to save state
      // They will be discovered via getForProject() when switching back

      console.log("[ProjectSwitch] Resetting renderer stores...");
      await resetAllStoresForProjectSwitch();

      console.log("[ProjectSwitch] Switching project in main process...");
      const project = await projectClient.switch(projectId);
      set({ currentProject: project, isLoading: false });

      // Now that backend has switched, reinitialize worktree data for the new project
      console.log("[ProjectSwitch] Reinitializing worktree data store...");
      forceReinitializeWorktreeDataStore();

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

  closeProject: async (projectId) => {
    const currentProjectId = get().currentProject?.id;

    // Prevent closing active project
    if (projectId === currentProjectId) {
      throw new Error("Cannot close the active project. Switch to another project first.");
    }

    try {
      const result = await projectClient.close(projectId);

      if (!result.success) {
        throw new Error(result.error || "Failed to close project");
      }

      console.log(
        `[ProjectStore] Closed project ${projectId}: ${result.processesKilled} processes killed`
      );

      return result;
    } catch (error) {
      console.error(`[ProjectStore] Failed to close project ${projectId}:`, error);
      throw error;
    }
  },
});

export const useProjectStore = create<ProjectState>()(createProjectStore);
