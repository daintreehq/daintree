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
 * `PROJECT_SETTINGS_AGENT_EXPOSURE`.
 *
 * `ActionService.dispatch` now parses results through this schema (#11539), so it
 * filters as well as documents. `pickAgentVisibleProjectSettings` in `run()` is kept
 * as the inner boundary: it cannot fail, whereas a parse that rejects the payload
 * would surface `RESULT_VALIDATION_ERROR` instead of a safe subset.
 */
const agentVisibleProjectSettingsShape: Record<AgentVisibleProjectSettingsKey, z.ZodType> = {
  runCommands: z.array(
    z.object({
      id: z.string(),
      // Every optional key here is typed rather than left open, which is only
      // safe because `pickAgentVisibleRunCommand` now drops a value whose type
      // doesn't match instead of forwarding it. Nothing below that projection
      // guarantees these types: the codec admits any entry with a string
      // `id`/`command` and copies the rest through verbatim, and the
      // agent-callable `project.saveSettings` types runCommands as
      // `z.array(z.unknown())`. Without the sanitize, one persisted
      // `preferredLocation: "sidebar"` would make this action return
      // RESULT_VALIDATION_ERROR for that project on every call, forever.
      name: z.string().optional(),
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
    description:
      "Change a project's stored metadata, such as its display name. This persists immediately and has no undo here, so read the project's current record first rather than overwriting fields blindly.",
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
      "List every project registered in the app, whether or not it is currently open. Use this to discover project ids; ask for the current project instead when all you need is the one the user is working in. It never fails — an empty list means no projects are registered rather than an error.",
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
      "Get the project currently open in the active window, which is what most work should be scoped to. Use the full project listing only when you genuinely need projects the user is not in. It never fails: an empty result means no project is open.",
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
      "Read a project's operational settings — run commands, dev server command, worktree naming, forge remote and notification overrides. This deliberately exposes only that fixed set: environment variables, secrets, access-control state and UI preferences are withheld and cannot be read here at all, so their absence is by design rather than a sign they are unset.",
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
      // Dispatch also parses the result against `resultSchema` (#11539), but this stays
      // as the inner boundary — it builds a fresh object (projectClient caches the value
      // it returns and the renderer's settings UI legitimately needs the full payload)
      // and, unlike a parse, has no failure mode that could fall back to the raw value.
      return pickAgentVisibleProjectSettings(settings);
    },
  }));

  actions.set("project.saveSettings", () => ({
    id: "project.saveSettings",
    title: "Save Project Settings",
    description:
      "Persist a project's settings, replacing the stored values with the ones supplied. This writes immediately and has no undo, and settings drive real behaviour such as run commands and worktree naming — read the current settings first so unrelated fields are not lost.",
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
    description:
      "Stop a project from raising notifications when its agents finish or need attention. The user will no longer be prompted for work that is waiting, so anything blocked on them may sit unnoticed. This persists until it is turned back on.",
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
      "Detect the runnable commands a project defines — its test, lint, build and dev scripts — by inspecting its manifest files. Use this to discover the right command to run rather than guessing one. It reads declared scripts only, so a project that drives tooling some other way returns nothing.",
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
      "Get aggregate resource usage for a project — how many processes and terminals it is running and roughly how much memory they consume. Use this to judge whether there is headroom before launching more work. Host process ids are deliberately withheld, so this cannot be used to target individual processes.",
    category: "project",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ projectId: z.string().optional() }).optional(),
    // Shaped, not open: the previous `z.object({}).catchall(z.unknown())` kept
    // every key, which shipped `ProjectStats.processIds` — live host pids — to
    // any agent that called this. Naming the fields is what strips them, since
    // a catchall opts out of zod's unknown-key stripping entirely (#11539).
    resultSchema: z.object({
      processCount: z.number(),
      terminalCount: z.number(),
      estimatedMemoryMB: z.number(),
      terminalTypes: z.record(z.string(), z.number()),
    }),
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
