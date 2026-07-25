import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import type { ProjectSettings } from "@shared/types";
import { z } from "zod";
import { projectClient } from "@/clients";
import { useProjectStore } from "@/store/projectStore";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { notify, EVENT_KIND_TO_SETTING_KEY, EVENT_KIND_LABEL } from "@/lib/notify";
import type { NotificationEventKind } from "@/lib/notify";
import { switchProjectByHistory } from "@/lib/projectHistoryNav";
import { formatErrorMessage } from "@shared/utils/errorMessage";

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
    title: "Go Back to Previous Project",
    description: "Step back through the projects this window has visited",
    category: "project",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: () => switchProjectByHistory("back"),
  }));

  actions.set("project.mruCycleNewer", () => ({
    id: "project.mruCycleNewer",
    title: "Go Forward to Next Project",
    description: "Step forward again after going back",
    category: "project",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: () => switchProjectByHistory("forward"),
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
    danger: "safe",
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
    danger: "safe",
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
    dangerRationale:
      "Removes a project from the list. Worktrees on disk remain but the project entry is lost.",
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
    danger: "safe",
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
    danger: "safe",
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
    description:
      "List every project registered in Daintree, open or not. Takes no args. Returns { projects } — an array of project records with id, name, path, and metadata. Never errors; returns an empty array when no projects are registered. Do NOT use this just to find the active project — call `project.getCurrent`, which returns only the one currently open.",
    category: "project",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    resultSchema: z.object({ projects: z.array(z.unknown()) }),
    run: async () => {
      const result = await projectClient.getAll();
      return { projects: result };
    },
  }));

  actions.set("project.getCurrent", () => ({
    id: "project.getCurrent",
    title: "Get Current Project",
    description:
      "Get the project currently open in the active window. Takes no args. Returns { project } — the active project record (id, name, path, metadata), or null when no project is open. Never errors. Do NOT use `project.getAll` for this — that lists every registered project; this returns only the active one.",
    category: "project",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    resultSchema: z.object({ project: z.unknown().nullable() }),
    run: async () => {
      const result = await projectClient.getCurrent();
      return { project: result };
    },
  }));

  actions.set("project.getSettings", () => ({
    id: "project.getSettings",
    title: "Get Project Settings",
    description:
      "Read a project's persisted settings (notification overrides, runner config, worktree path pattern, etc.). Args: `projectId` (optional) — a project id from `project.getAll` (the `id` field); defaults to the active project's id. Returns the settings object as an open-ended key/value map. Errors when no projectId is given and no project is active.",
    category: "project",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ projectId: z.string().optional() }).optional(),
    resultSchema: z.object({}).catchall(z.unknown()),
    run: async (args: unknown, ctx: ActionContext) => {
      const { projectId } = (args ?? {}) as { projectId?: string };
      const resolvedProjectId = projectId ?? ctx.projectId;
      if (!resolvedProjectId) throw new Error("No active project");
      return await projectClient.getSettings(resolvedProjectId);
    },
  }));

  actions.set("project.saveSettings", () => ({
    id: "project.saveSettings",
    title: "Save Project Settings",
    description: "Save a project's settings",
    category: "project",
    kind: "command",
    danger: "safe",
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
      const updated = { ...current, ...sanitized } as ProjectSettings;
      await projectClient.saveSettings(projectId, updated);

      const currentProjectId = useProjectStore.getState().currentProject?.id;
      const projectSettingsState = useProjectSettingsStore.getState();
      if (projectId === currentProjectId && projectSettingsState.projectId === projectId) {
        projectSettingsState.setSettings(updated);
      }
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
        const priorOverrides = { ...current.notificationOverrides };
        const updated = {
          ...current,
          notificationOverrides: {
            ...current.notificationOverrides,
            completedEnabled: false,
            waitingEnabled: false,
          },
        };
        await projectClient.saveSettings(projectId, updated);
        const settingsState = useProjectSettingsStore.getState();
        if (settingsState.projectId === projectId) {
          settingsState.setSettings(updated);
        }
        if (updated.notificationOverrides) {
          useProjectSettingsStore.setState((s) => ({
            notificationOverridesByProjectId: {
              ...s.notificationOverridesByProjectId,
              [projectId]: updated.notificationOverrides!,
            },
          }));
        }
        notify({
          type: "success",
          message: "Project notifications muted",
          priority: "high",
          duration: 5000,
          context: { eventKind: "settings" },
          // One-shot Undo confirmation; mute is reversible from the project's
          // notification settings tab, so the 5s Undo window plus the settings
          // surface make inbox persistence redundant.
          transient: true,
          action: {
            label: "Undo",
            onClick: async () => {
              try {
                const currentNow = await projectClient.getSettings(projectId);
                await projectClient.saveSettings(projectId, {
                  ...currentNow,
                  notificationOverrides: priorOverrides,
                });
              } catch {
                // Undo failed silently — settings can be restored manually
              }
            },
          },
        });
      } catch (error) {
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
        notify({
          type: "error",
          title: "Couldn't mute notifications",
          message: formatErrorMessage(error, "Couldn't mute project notifications"),
          duration: 5000,
        });
        throw error;
      }
    },
  }));

  actions.set("project.silenceNotificationKind", () => ({
    id: "project.silenceNotificationKind",
    title: "Silence Notification Kind",
    description: "Suppress a specific category of notifications",
    category: "project",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      kind: z.enum(["completed", "waiting", "workingPulse", "uiFeedback"]),
      projectId: z.string().min(1).optional(),
    }),
    run: async (args: unknown) => {
      const { kind, projectId } = args as { kind: NotificationEventKind; projectId?: string };
      const label = EVENT_KIND_LABEL[kind] ?? kind;
      const settingKey = EVENT_KIND_TO_SETTING_KEY[kind];
      // Routing-only kinds (e.g. "host", "git") have no persisted silence
      // toggle. The Zod enum below only admits the four silenceable kinds, so
      // this is a type-narrowing guard rather than a reachable runtime path.
      if (!settingKey) return;

      try {
        const isGlobalOnly = kind === "uiFeedback";
        let priorValue: boolean | undefined;
        let priorGlobalSnapshot: Partial<Record<string, boolean>> | undefined;

        if (projectId && !isGlobalOnly) {
          const current = await projectClient.getSettings(projectId);
          priorValue = (current.notificationOverrides as Record<string, unknown> | undefined)?.[
            settingKey
          ] as boolean | undefined;
          await projectClient.saveSettings(projectId, {
            ...current,
            notificationOverrides: {
              ...current.notificationOverrides,
              [settingKey]: false,
            },
          });
        } else {
          const current = await window.electron?.notification?.getSettings();
          if (current) {
            priorValue = (current as unknown as Record<string, unknown>)[settingKey] as
              boolean | undefined;
            priorGlobalSnapshot = {
              [settingKey]: (current as unknown as Record<string, unknown>)[settingKey] as
                boolean | undefined,
            };
            await window.electron.notification.setSettings({ [settingKey]: false });
          }
        }

        const scopeSuffix = isGlobalOnly
          ? " for all projects"
          : projectId
            ? " for this project"
            : "";

        notify({
          type: "success",
          message: `Silenced ${label}${scopeSuffix}`,
          priority: "high",
          duration: 5000,
          context: { eventKind: "settings" },
          // One-shot Undo confirmation; silenced kinds are reversible from
          // notification settings, so the 5s Undo plus the settings surface
          // make inbox persistence redundant.
          transient: true,
          action: {
            label: "Undo",
            onClick: async () => {
              try {
                if (projectId && !isGlobalOnly) {
                  const currentNow = await projectClient.getSettings(projectId);
                  const overrides = {
                    ...(currentNow.notificationOverrides as Record<string, unknown>),
                  };
                  if (priorValue === undefined) {
                    delete overrides[settingKey];
                  } else {
                    overrides[settingKey] = priorValue;
                  }
                  await projectClient.saveSettings(projectId, {
                    ...currentNow,
                    notificationOverrides: overrides,
                  });
                } else if (priorGlobalSnapshot) {
                  await window.electron?.notification?.setSettings(priorGlobalSnapshot);
                }
              } catch {
                // Undo failed silently — settings can be restored manually
              }
            },
          },
        });
      } catch (error) {
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
        notify({
          type: "error",
          title: "Couldn't silence notifications",
          message: formatErrorMessage(error, `Couldn't silence ${label}`),
          duration: 5000,
        });
        throw error;
      }
    },
  }));

  actions.set("project.detectRunners", () => ({
    id: "project.detectRunners",
    title: "Detect Runners",
    description:
      "Detect runnable commands (test/lint/build/dev scripts) for a project by inspecting its manifest files. Args: `projectId` (optional) — a project id from `project.getAll` (the `id` field); defaults to the active project. Returns { runners } — an array of { id, name, command }. Errors when no projectId is given and no project is active.",
    category: "project",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ projectId: z.string().optional() }).optional(),
    resultSchema: z.object({ runners: z.array(z.unknown()) }),
    run: async (args: unknown, ctx: ActionContext) => {
      const { projectId } = (args ?? {}) as { projectId?: string };
      const resolvedProjectId = projectId ?? ctx.projectId;
      if (!resolvedProjectId) throw new Error("No active project");
      const result = await projectClient.detectRunners(resolvedProjectId);
      return { runners: result };
    },
  }));

  actions.set("project.getStats", () => ({
    id: "project.getStats",
    title: "Get Project Stats",
    description:
      "Get aggregate statistics for a project (commit/issue/PR counts and activity). Args: `projectId` (optional) — a project id from `project.getAll` (the `id` field); defaults to the active project. Returns an open-ended stats object. Errors when no projectId is given and no project is active.",
    category: "project",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ projectId: z.string().optional() }).optional(),
    resultSchema: z.object({}).catchall(z.unknown()),
    run: async (args: unknown, ctx: ActionContext) => {
      const { projectId } = (args ?? {}) as { projectId?: string };
      const resolvedProjectId = projectId ?? ctx.projectId;
      if (!resolvedProjectId) throw new Error("No active project");
      return await projectClient.getStats(resolvedProjectId);
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
