import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import type { AgentVisibleProjectSettingsKey, ProjectSettings } from "@shared/types";
import { pickAgentVisibleProjectSettings } from "@shared/types";
import { z } from "zod";
import { projectClient } from "@/clients";
import { useProjectStore } from "@/store/projectStore";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { notify, EVENT_KIND_TO_SETTING_KEY, EVENT_KIND_LABEL } from "@/lib/notify";
import type { NotificationEventKind } from "@/lib/notify";
import { switchToLastProject } from "@/lib/projectHistoryNav";
import { formatErrorMessage } from "@shared/utils/errorMessage";

/**
 * Wire shape of `project.getSettings`.
 *
 * Typing the shape as `Record<AgentVisibleProjectSettingsKey, z.ZodType>` is what keeps
 * this honest: omitting a key classified `exposed`, or adding one that isn't, is a
 * compile error, so the advertised schema cannot drift from
 * `PROJECT_SETTINGS_AGENT_EXPOSURE`. The schema is documentation only —
 * `ActionService.dispatch` never parses results — so the actual filtering is done by
 * `pickAgentVisibleProjectSettings` in `run()`.
 */
const agentVisibleProjectSettingsShape: Record<AgentVisibleProjectSettingsKey, z.ZodType> = {
  runCommands: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      command: z.string(),
      icon: z.string().optional(),
      description: z.string().optional(),
      preferredLocation: z.enum(["dock", "grid"]).optional(),
      preferredAutoRestart: z.boolean().optional(),
      isFrameworkDefault: z.boolean().optional(),
    })
  ),
  excludedPaths: z.array(z.string()).optional(),
  defaultWorktreeRecipeId: z.string().optional(),
  devServerCommand: z.string().optional(),
  devServerLoadTimeout: z.number().optional(),
  turbopackEnabled: z.boolean().optional(),
  copyTreeSettings: z.record(z.string(), z.unknown()).optional(),
  branchPrefixMode: z.enum(["none", "username", "custom"]).optional(),
  branchPrefixCustom: z.string().optional(),
  forgeRemote: z.string().optional(),
  forgeProviderOverride: z.string().nullable().optional(),
  worktreePathPattern: z.string().optional(),
  terminalSettings: z
    .object({
      shell: z.string().optional(),
      shellArgs: z.array(z.string()).optional(),
      defaultWorkingDirectory: z.string().optional(),
      scrollbackLines: z.number().optional(),
    })
    .optional(),
  notificationOverrides: z.record(z.string(), z.unknown()).optional(),
  activeResourceEnvironment: z.string().optional(),
  defaultWorktreeMode: z.string().optional(),
};

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

  // Id kept from when this was one half of a cycle pair; renaming it would
  // orphan any binding a user has already customised.
  actions.set("project.mruCycleOlder", () => ({
    id: "project.mruCycleOlder",
    title: "Switch to Last Project",
    description:
      "Switch to the project this window was in before the current one. Running it again returns to where you started.",
    category: "project",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: () => switchToLastProject(),
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
      "Read the operational subset of a project's persisted settings (run commands, dev server command, worktree path pattern, branch prefix, forge remote, notification overrides, terminal overrides, etc.). Args: `projectId` (optional) — a project id from `project.getAll` (the `id` field); defaults to the active project's id. Returns only that fixed field set: environment variables (including secure ones), the project icon SVG, resource environment definitions, access-control state (MCP tier, browser allow-list), and renderer-only UI preferences are deliberately omitted and cannot be read through this action. Errors when no projectId is given and no project is active.",
    category: "project",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ projectId: z.string().optional() }).optional(),
    resultSchema: z.object(agentVisibleProjectSettingsShape),
    mcpOutputSchema: true,
    run: async (args: unknown, ctx: ActionContext) => {
      const { projectId } = (args ?? {}) as { projectId?: string };
      const resolvedProjectId = projectId ?? ctx.projectId;
      if (!resolvedProjectId) throw new Error("No active project");
      const settings = await projectClient.getSettings(resolvedProjectId);
      // Project down to the agent-safe field set before returning. This action is on
      // every MCP tier's allowlist, and the settings payload carries decrypted secure
      // env vars (ProjectSettingsManager resolves them) plus a 250KB icon blob.
      // `resultSchema` cannot do this — dispatch never validates results — so the
      // filtering has to happen here, on a fresh object (projectClient caches the value
      // it returns and the renderer's settings UI legitimately needs the full payload).
      return pickAgentVisibleProjectSettings(settings);
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
