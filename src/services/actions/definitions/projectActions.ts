import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { z } from "zod";
import { projectClient } from "@/clients";
import { useProjectStore } from "@/store/projectStore";
import { getMruProjects } from "@/lib/projectMru";
import { notify } from "@/lib/notify";
import { formatErrorMessage } from "@shared/utils/errorMessage";

async function runMruFallbackSwitch(direction: "older" | "newer"): Promise<void> {
  const state = useProjectStore.getState();
  const currentId = state.currentProject?.id ?? null;
  const sorted = getMruProjects(state.projects);
  const otherProjects = sorted.filter((p) => p.id !== currentId);
  if (otherProjects.length === 0) return;

  const target = direction === "older" ? otherProjects[0] : otherProjects[otherProjects.length - 1];
  if (!target) return;

  try {
    if (target.status === "background") {
      await state.reopenProject(target.id);
    } else {
      await state.switchProject(target.id);
    }
  } catch (error) {
    notify({
      type: "error",
      title: "Failed to switch project",
      message: formatErrorMessage(error, "Failed to switch project"),
      actions: [
        {
          label: "Try again",
          variant: "primary",
          onClick: () => {
            void runMruFallbackSwitch(direction);
          },
        },
      ],
    });
  }
}

export function registerProjectActions(actions: ActionRegistry, callbacks: ActionCallbacks): void {
  actions.set("project.switcherPalette", () => ({
    id: "project.switcherPalette",
    title: "Open Project Switcher",
    description: "Open the quick project switcher palette",
    category: "project",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    nonRepeatable: true,
    run: async () => {
      callbacks.onOpenProjectSwitcherPalette();
    },
  }));

  actions.set("project.mruCycleOlder", () => ({
    id: "project.mruCycleOlder",
    title: "Switch to Previous Project (Older)",
    description: "Switch to the most recent other project; hold to scrub older",
    category: "project",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: () => runMruFallbackSwitch("older"),
  }));

  actions.set("project.mruCycleNewer", () => ({
    id: "project.mruCycleNewer",
    title: "Switch to Oldest Project (Newer)",
    description: "Switch to the oldest other project; hold to scrub newer",
    category: "project",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: () => runMruFallbackSwitch("newer"),
  }));

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
      await useProjectStore.getState().addProjectByPath(trimmedPath);
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
    argsSchema: z.object({
      projectId: z.string(),
      updates: z.object({
        name: z.string().optional(),
        emoji: z.string().optional(),
        color: z.string().optional(),
        pinned: z.boolean().optional(),
      }),
    }),
    run: async (args: unknown) => {
      const { projectId, updates } = args as {
        projectId: string;
        updates: { name?: string; emoji?: string; color?: string; pinned?: boolean };
      };
      await useProjectStore.getState().updateProject(projectId, updates);
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
      const state = useProjectStore.getState();
      if (projectId === state.currentProject?.id) {
        callbacks.onConfirmCloseActiveProject(projectId);
        return;
      }
      await state.closeProject(projectId);
    },
  }));

  actions.set("project.closeActive", () => ({
    id: "project.closeActive",
    title: "Close Project",
    description: "Close the currently active project and return to the welcome screen",
    category: "project",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    run: async () => {
      const projectId = useProjectStore.getState().currentProject?.id;
      if (!projectId) return;
      callbacks.onConfirmCloseActiveProject(projectId);
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
      // Merge over current settings rather than full-replace so dispatchers
      // (notably MCP callers) cannot wipe unrelated fields by sending a
      // partial object. Strip privilege-escalation keys before merging —
      // the MCP-tier knob lives in ProjectSettings and must not be
      // self-mutable by an agent.
      const current = await projectClient.getSettings(projectId);
      const sanitized: Record<string, unknown> = { ...settings };
      delete sanitized.daintreeMcpTier;
      delete sanitized.exposeDaintreeMcpToAgents;
      await projectClient.saveSettings(projectId, { ...current, ...sanitized } as any);
    },
  }));

  actions.set("project.muteNotifications", () => ({
    id: "project.muteNotifications",
    title: "Mute Project Notifications",
    description: "Suppress future agent completion and waiting notifications for a project",
    category: "project",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ projectId: z.string().min(1) }),
    run: async (args: unknown) => {
      const { projectId } = args as { projectId: string };
      try {
        const current = await projectClient.getSettings(projectId);
        await projectClient.saveSettings(projectId, {
          ...current,
          notificationOverrides: {
            ...current.notificationOverrides,
            completedEnabled: false,
            waitingEnabled: false,
          },
        });
        notify({
          type: "success",
          message: "Project notifications muted",
          priority: "low",
        });
      } catch (error) {
        notify({
          type: "error",
          title: "Failed to mute notifications",
          message: formatErrorMessage(error, "Failed to mute project notifications"),
          duration: 5000,
        });
        throw error;
      }
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

  actions.set("project.cloneRepo", () => ({
    id: "project.cloneRepo",
    title: "Clone Repository",
    description: "Clone a Git repository from a URL",
    category: "project",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      useProjectStore.getState().openCloneRepoDialog();
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
      window.dispatchEvent(
        new CustomEvent("daintree:open-settings-tab", {
          detail: { tab: "project:general" },
        })
      );
    },
  }));
}
