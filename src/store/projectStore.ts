import { create, type StateCreator } from "zustand";
import { persist, subscribeWithSelector } from "zustand/middleware";
import type { Project, ProjectCloseResult, TerminalSnapshot } from "@shared/types";
import { projectClient } from "@/clients";
import { resetAllStoresForProjectSwitch } from "./resetStores";
import { forceReinitializeWorktreeDataStore } from "./worktreeDataStore";
import { flushTerminalPersistence } from "./slices";
import { terminalPersistence } from "./persistence/terminalPersistence";
import { useNotificationStore } from "./notificationStore";
import { useTerminalStore } from "./terminalStore";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import { useProjectSettingsStore } from "./projectSettingsStore";

interface ProjectState {
  projects: Project[];
  currentProject: Project | null;
  isLoading: boolean;
  isSwitching: boolean;
  switchingToProjectName: string | null;
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
  finishProjectSwitch: () => void;
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
  isSwitching: false,
  switchingToProjectName: null,
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
    const targetProject = get().projects.find((p) => p.id === projectId);
    set({
      isLoading: true,
      isSwitching: true,
      switchingToProjectName: targetProject?.name ?? null,
      error: null,
    });
    try {
      const currentProject = get().currentProject;
      const oldProjectId = currentProject?.id;

      // Save current project's panel state BEFORE switching
      if (oldProjectId) {
        // Flush any pending persistence and wait for completion
        flushTerminalPersistence();
        await terminalPersistence.whenIdle();

        // Get current terminals from store and save to per-project state
        const currentTerminals = useTerminalStore.getState().terminals;
        const terminalsToSave: TerminalSnapshot[] = currentTerminals
          .filter((t) => t.location !== "trash")
          .map((t) => {
            const base: TerminalSnapshot = {
              id: t.id,
              kind: t.kind,
              title: t.title,
              worktreeId: t.worktreeId,
              location: t.location === "trash" ? "grid" : t.location,
              cwd: t.cwd,
            };

            if (t.kind === "dev-preview") {
              // Special case for dev-preview: use devCommand, not command
              return {
                ...base,
                type: t.type,
                cwd: t.cwd,
                command: t.devCommand?.trim() || undefined,
                ...(t.browserUrl && { browserUrl: t.browserUrl }),
              };
            } else if (panelKindHasPty(t.kind ?? "terminal")) {
              return {
                ...base,
                type: t.type,
                agentId: t.agentId,
                command: t.command?.trim() || undefined,
              };
            } else if (t.kind === "notes") {
              return {
                ...base,
                notePath: t.notePath,
                noteId: t.noteId,
                scope: t.scope,
                createdAt: t.createdAt,
              };
            } else {
              return {
                ...base,
                ...(t.browserUrl && { browserUrl: t.browserUrl }),
              };
            }
          });

        console.log(
          `[ProjectSwitch] Saving ${terminalsToSave.length} panel(s) to per-project state`
        );
        try {
          await projectClient.setTerminals(oldProjectId, terminalsToSave);
        } catch (saveError) {
          console.warn("[ProjectSwitch] Failed to save per-project panel state:", saveError);
        }
      }

      console.log("[ProjectSwitch] Resetting renderer stores...");
      await resetAllStoresForProjectSwitch();

      console.log("[ProjectSwitch] Switching project in main process...");
      const project = await projectClient.switch(projectId);
      set({ currentProject: project, isLoading: false });

      // Clear old settings and pre-load new project settings for instant toolbar updates
      console.log("[ProjectSwitch] Pre-loading project settings...");
      useProjectSettingsStore.getState().reset();
      void useProjectSettingsStore.getState().loadSettings(projectId);

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
      set({ error: message, isLoading: false, isSwitching: false, switchingToProjectName: null });
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
      console.error(`[ProjectStore] Failed to close project ${projectId}:`, error);
      throw error;
    }
  },

  reopenProject: async (projectId) => {
    const targetProject = get().projects.find((p) => p.id === projectId);
    set({
      isLoading: true,
      isSwitching: true,
      switchingToProjectName: targetProject?.name ?? null,
      error: null,
    });
    try {
      const currentProject = get().currentProject;
      const oldProjectId = currentProject?.id;

      // Save current project's panel state BEFORE switching (same as switchProject)
      if (oldProjectId) {
        // Flush any pending persistence and wait for completion
        flushTerminalPersistence();
        await terminalPersistence.whenIdle();

        // Get current terminals from store and save to per-project state
        const currentTerminals = useTerminalStore.getState().terminals;
        const terminalsToSave: TerminalSnapshot[] = currentTerminals
          .filter((t) => t.location !== "trash")
          .map((t) => {
            const base: TerminalSnapshot = {
              id: t.id,
              kind: t.kind,
              title: t.title,
              worktreeId: t.worktreeId,
              location: t.location === "trash" ? "grid" : t.location,
              cwd: t.cwd,
            };

            if (t.kind === "dev-preview") {
              // Special case for dev-preview: use devCommand, not command
              return {
                ...base,
                type: t.type,
                cwd: t.cwd,
                command: t.devCommand?.trim() || undefined,
                ...(t.browserUrl && { browserUrl: t.browserUrl }),
              };
            } else if (panelKindHasPty(t.kind ?? "terminal")) {
              return {
                ...base,
                type: t.type,
                agentId: t.agentId,
                command: t.command?.trim() || undefined,
              };
            } else if (t.kind === "notes") {
              return {
                ...base,
                notePath: t.notePath,
                noteId: t.noteId,
                scope: t.scope,
                createdAt: t.createdAt,
              };
            } else {
              return {
                ...base,
                ...(t.browserUrl && { browserUrl: t.browserUrl }),
              };
            }
          });

        console.log(`[ProjectStore] Saving ${terminalsToSave.length} panel(s) before reopen`);
        try {
          await projectClient.setTerminals(oldProjectId, terminalsToSave);
        } catch (saveError) {
          console.warn("[ProjectStore] Failed to save per-project panel state:", saveError);
        }
      }

      console.log("[ProjectStore] Resetting renderer stores...");
      await resetAllStoresForProjectSwitch();

      console.log("[ProjectStore] Reopening project...");
      const project = await projectClient.reopen(projectId);
      set({ currentProject: project, isLoading: false });

      // Clear old settings and pre-load project settings for instant toolbar updates
      console.log("[ProjectStore] Pre-loading project settings...");
      useProjectSettingsStore.getState().reset();
      void useProjectSettingsStore.getState().loadSettings(projectId);

      await get().loadProjects();

      console.log("[ProjectStore] Triggering state re-hydration...");
      window.dispatchEvent(new CustomEvent("project-switched"));
    } catch (error) {
      console.error("Failed to reopen project:", error);
      const message = getProjectOpenErrorMessage(error);
      set({ error: message, isLoading: false, isSwitching: false, switchingToProjectName: null });
      throw error;
    }
  },

  finishProjectSwitch: () => {
    set({ isSwitching: false, switchingToProjectName: null });
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
