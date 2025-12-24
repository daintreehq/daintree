import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { z } from "zod";
import { projectClient } from "@/clients";
import { useNotificationStore } from "@/store/notificationStore";
import { useProjectStore } from "@/store/projectStore";

export function registerProjectActions(actions: ActionRegistry, _callbacks: ActionCallbacks): void {
  actions.set("project.add", () => ({
    id: "project.add",
    title: "Add Project",
    description: "Add a project (optionally by path)",
    category: "project",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z
      .object({
        path: z.string().optional(),
      })
      .optional(),
    run: async (args: unknown) => {
      const { path } = (args as { path?: string } | undefined) ?? {};
      const trimmedPath = path?.trim();
      if (!trimmedPath) {
        await useProjectStore.getState().addProject();
        return;
      }

      const project = await projectClient.add(trimmedPath);
      await useProjectStore.getState().switchProject(project.id);
    },
  }));

  actions.set("project.openDialog", () => ({
    id: "project.openDialog",
    title: "Pick Directory",
    description: "Open a directory picker dialog",
    category: "project",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    resultSchema: z.string().nullable(),
    run: async () => {
      return await projectClient.openDialog();
    },
  }));

  actions.set("project.switch", () => ({
    id: "project.switch",
    title: "Switch Project",
    description: "Switch to another project",
    category: "project",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    argsSchema: z.object({ projectId: z.string() }),
    run: async (args: unknown) => {
      const { projectId } = args as { projectId: string };
      useNotificationStore.getState().addNotification({
        type: "info",
        title: "Switching projects",
        message: "Resetting state for clean project isolation",
        duration: 1500,
      });
      await useProjectStore.getState().switchProject(projectId);
    },
  }));

  actions.set("project.update", () => ({
    id: "project.update",
    title: "Update Project",
    description: "Update project metadata",
    category: "project",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    argsSchema: z.object({ projectId: z.string(), updates: z.record(z.string(), z.unknown()) }),
    run: async (args: unknown) => {
      const { projectId, updates } = args as {
        projectId: string;
        updates: Record<string, unknown>;
      };
      await useProjectStore.getState().updateProject(projectId, updates as any);
    },
  }));

  actions.set("project.remove", () => ({
    id: "project.remove",
    title: "Remove Project",
    description: "Remove a project from the list",
    category: "project",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    argsSchema: z.object({ projectId: z.string() }),
    run: async (args: unknown) => {
      const { projectId } = args as { projectId: string };
      await useProjectStore.getState().removeProject(projectId);
    },
  }));

  actions.set("project.close", () => ({
    id: "project.close",
    title: "Close Project",
    description: "Close a project and kill its processes",
    category: "project",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    argsSchema: z.object({ projectId: z.string() }),
    run: async (args: unknown) => {
      const { projectId } = args as { projectId: string };
      await useProjectStore.getState().closeProject(projectId);
    },
  }));

  actions.set("project.getAll", () => ({
    id: "project.getAll",
    title: "List Projects",
    description: "Get all projects",
    category: "project",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      return await projectClient.getAll();
    },
  }));

  actions.set("project.getCurrent", () => ({
    id: "project.getCurrent",
    title: "Get Current Project",
    description: "Get the current active project",
    category: "project",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      return await projectClient.getCurrent();
    },
  }));

  actions.set("project.getSettings", () => ({
    id: "project.getSettings",
    title: "Get Project Settings",
    description: "Get a project's settings",
    category: "project",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ projectId: z.string() }),
    run: async (args: unknown) => {
      const { projectId } = args as { projectId: string };
      return await projectClient.getSettings(projectId);
    },
  }));

  actions.set("project.saveSettings", () => ({
    id: "project.saveSettings",
    title: "Save Project Settings",
    description: "Save a project's settings",
    category: "project",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    argsSchema: z.object({ projectId: z.string(), settings: z.record(z.string(), z.unknown()) }),
    run: async (args: unknown) => {
      const { projectId, settings } = args as {
        projectId: string;
        settings: Record<string, unknown>;
      };
      await projectClient.saveSettings(projectId, settings as any);
    },
  }));

  actions.set("project.detectRunners", () => ({
    id: "project.detectRunners",
    title: "Detect Runners",
    description: "Detect runnable commands for a project",
    category: "project",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ projectId: z.string() }),
    run: async (args: unknown) => {
      const { projectId } = args as { projectId: string };
      return await projectClient.detectRunners(projectId);
    },
  }));

  actions.set("project.getStats", () => ({
    id: "project.getStats",
    title: "Get Project Stats",
    description: "Get project statistics",
    category: "project",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ projectId: z.string() }),
    run: async (args: unknown) => {
      const { projectId } = args as { projectId: string };
      return await projectClient.getStats(projectId);
    },
  }));

  actions.set("project.settings.open", () => ({
    id: "project.settings.open",
    title: "Open Project Settings",
    description: "Open the project settings dialog",
    category: "project",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      window.dispatchEvent(new CustomEvent("canopy:open-project-settings"));
    },
  }));
}
