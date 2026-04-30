import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { ProjectSettings } from "@shared/types";
import { z } from "zod";
import { projectClient } from "@/clients";

const resourceEnvSchema = z.object({
  provision: z.array(z.string()).optional(),
  teardown: z.array(z.string()).optional(),
  resume: z.array(z.string()).optional(),
  pause: z.array(z.string()).optional(),
  status: z.string().optional(),
  connect: z.string().optional(),
  icon: z.string().optional(),
});

export function registerEnvActions(actions: ActionRegistry, _callbacks: ActionCallbacks): void {
  actions.set("env.global.get", () => ({
    id: "env.global.get",
    title: "Get Global Environment Variables",
    description: "Read all global environment variables",
    category: "settings",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      return await window.electron.globalEnv.get();
    },
  }));

  actions.set("env.global.set", () => ({
    id: "env.global.set",
    title: "Set Global Environment Variables",
    description: "Replace the global environment variables map",
    category: "settings",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    argsSchema: z.object({ variables: z.record(z.string(), z.string()) }),
    run: async (args: unknown) => {
      const { variables } = args as { variables: Record<string, string> };
      await window.electron.globalEnv.set(variables);
    },
  }));

  actions.set("env.project.get", () => ({
    id: "env.project.get",
    title: "Get Project Environment Variables",
    description: "Read a project's environment variables",
    category: "settings",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ projectId: z.string() }),
    run: async (args: unknown) => {
      const { projectId } = args as { projectId: string };
      const settings = await projectClient.getSettings(projectId);
      return settings?.environmentVariables ?? {};
    },
  }));

  actions.set("env.project.set", () => ({
    id: "env.project.set",
    title: "Set Project Environment Variables",
    description: "Merge variables into a project's environment variables",
    category: "settings",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    argsSchema: z.object({
      projectId: z.string(),
      variables: z.record(z.string(), z.string()),
    }),
    run: async (args: unknown) => {
      const { projectId, variables } = args as {
        projectId: string;
        variables: Record<string, string>;
      };
      const current: Partial<ProjectSettings> = (await projectClient.getSettings(projectId)) ?? {};
      const next: ProjectSettings = {
        runCommands: [],
        ...current,
        environmentVariables: {
          ...(current.environmentVariables ?? {}),
          ...variables,
        },
      };
      await projectClient.saveSettings(projectId, next);
    },
  }));

  actions.set("worktree.resource.config.get", () => ({
    id: "worktree.resource.config.get",
    title: "Get Resource Environments Config",
    description: "Read a project's resource environments configuration",
    category: "worktree",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ projectId: z.string() }),
    run: async (args: unknown) => {
      const { projectId } = args as { projectId: string };
      const settings = await projectClient.getSettings(projectId);
      return settings?.resourceEnvironments ?? {};
    },
  }));

  actions.set("worktree.resource.config.set", () => ({
    id: "worktree.resource.config.set",
    title: "Set Resource Environments Config",
    description: "Replace a project's resource environments configuration",
    category: "worktree",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    argsSchema: z.object({
      projectId: z.string(),
      resourceEnvironments: z.record(z.string(), resourceEnvSchema),
    }),
    run: async (args: unknown) => {
      const { projectId, resourceEnvironments } = args as {
        projectId: string;
        resourceEnvironments: Record<string, z.infer<typeof resourceEnvSchema>>;
      };
      const current: Partial<ProjectSettings> = (await projectClient.getSettings(projectId)) ?? {};
      const next: ProjectSettings = { runCommands: [], ...current, resourceEnvironments };
      await projectClient.saveSettings(projectId, next);
    },
  }));
}
