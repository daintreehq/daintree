import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { CopyTreeOptionsSchema, FileSearchPayloadSchema, LegacyAgentTypeSchema } from "./schemas";
import { z } from "zod";
import {
  artifactClient,
  cliAvailabilityClient,
  copyTreeClient,
  filesClient,
  slashCommandsClient,
  systemClient,
} from "@/clients";

export function registerSystemActions(actions: ActionRegistry, _callbacks: ActionCallbacks): void {
  actions.set("system.openExternal", () => ({
    id: "system.openExternal",
    title: "Open External URL",
    description: "Open a URL in the system browser",
    category: "system",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ url: z.string() }),
    run: async (args: unknown) => {
      const { url } = args as { url: string };
      await systemClient.openExternal(url);
    },
  }));

  actions.set("system.openPath", () => ({
    id: "system.openPath",
    title: "Open Path",
    description: "Open a file or folder in the system file manager",
    category: "system",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ path: z.string() }),
    run: async (args: unknown) => {
      const { path } = args as { path: string };
      await systemClient.openPath(path);
    },
  }));

  actions.set("system.checkCommand", () => ({
    id: "system.checkCommand",
    title: "Check Command Availability",
    description: "Check whether a command is available on PATH",
    category: "system",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ command: z.string() }),
    run: async (args: unknown) => {
      const { command } = args as { command: string };
      return await systemClient.checkCommand(command);
    },
  }));

  actions.set("system.checkDirectory", () => ({
    id: "system.checkDirectory",
    title: "Check Directory",
    description: "Check whether a directory exists",
    category: "system",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ path: z.string() }),
    run: async (args: unknown) => {
      const { path } = args as { path: string };
      return await systemClient.checkDirectory(path);
    },
  }));

  actions.set("system.getHomeDir", () => ({
    id: "system.getHomeDir",
    title: "Get Home Directory",
    description: "Get the user's home directory path",
    category: "system",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      return await systemClient.getHomeDir();
    },
  }));

  actions.set("cliAvailability.get", () => ({
    id: "cliAvailability.get",
    title: "Get CLI Availability",
    description: "Get cached agent CLI availability",
    category: "system",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      return await cliAvailabilityClient.get();
    },
  }));

  actions.set("cliAvailability.refresh", () => ({
    id: "cliAvailability.refresh",
    title: "Refresh CLI Availability",
    description: "Re-check agent CLI availability (slower)",
    category: "system",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      return await cliAvailabilityClient.refresh();
    },
  }));

  actions.set("files.search", () => ({
    id: "files.search",
    title: "Search Files",
    description: "Search for files in a directory",
    category: "files",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: FileSearchPayloadSchema,
    run: async (args: unknown) => {
      const payload = args as { cwd: string; query: string; limit?: number };
      return await filesClient.search(payload);
    },
  }));

  actions.set("slashCommands.list", () => ({
    id: "slashCommands.list",
    title: "List Slash Commands",
    description: "List available slash commands for an agent",
    category: "agents",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ agentId: LegacyAgentTypeSchema, projectPath: z.string().optional() }),
    run: async (args: unknown) => {
      const payload = args as {
        agentId: "claude" | "gemini" | "codex" | "opencode";
        projectPath?: string;
      };
      return await slashCommandsClient.list(payload);
    },
  }));

  actions.set("artifact.saveToFile", () => ({
    id: "artifact.saveToFile",
    title: "Save Artifact To File",
    description: "Save content to a file via save dialog",
    category: "artifacts",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    argsSchema: z.object({
      content: z.string(),
      suggestedFilename: z.string().optional(),
      cwd: z.string().optional(),
    }),
    run: async (args: unknown) => {
      return await artifactClient.saveToFile(args as any);
    },
  }));

  actions.set("artifact.applyPatch", () => ({
    id: "artifact.applyPatch",
    title: "Apply Patch",
    description: "Apply a unified diff patch to the filesystem",
    category: "artifacts",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    argsSchema: z.object({
      patchContent: z.string(),
      cwd: z.string(),
    }),
    run: async (args: unknown) => {
      return await artifactClient.applyPatch(args as any);
    },
  }));

  actions.set("copyTree.isAvailable", () => ({
    id: "copyTree.isAvailable",
    title: "CopyTree Availability",
    description: "Check whether CopyTree is available",
    category: "copyTree",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      return await copyTreeClient.isAvailable();
    },
  }));

  actions.set("copyTree.generate", () => ({
    id: "copyTree.generate",
    title: "Generate CopyTree Context",
    description: "Generate worktree context (returns content)",
    category: "copyTree",
    kind: "query",
    danger: "confirm",
    scope: "renderer",
    argsSchema: z.object({ worktreeId: z.string(), options: CopyTreeOptionsSchema.optional() }),
    run: async (args: unknown) => {
      const { worktreeId, options } = args as { worktreeId: string; options?: unknown };
      return await copyTreeClient.generate(worktreeId, options as any);
    },
  }));

  actions.set("copyTree.generateAndCopyFile", () => ({
    id: "copyTree.generateAndCopyFile",
    title: "Generate And Copy Context",
    description: "Generate worktree context and copy to clipboard",
    category: "copyTree",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    argsSchema: z.object({ worktreeId: z.string(), options: CopyTreeOptionsSchema.optional() }),
    run: async (args: unknown) => {
      const { worktreeId, options } = args as { worktreeId: string; options?: unknown };
      return await copyTreeClient.generateAndCopyFile(worktreeId, options as any);
    },
  }));

  actions.set("copyTree.injectToTerminal", () => ({
    id: "copyTree.injectToTerminal",
    title: "Inject Context To Terminal",
    description: "Inject worktree context into a terminal",
    category: "copyTree",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    argsSchema: z.object({
      terminalId: z.string(),
      worktreeId: z.string(),
      options: CopyTreeOptionsSchema.optional(),
    }),
    run: async (args: unknown) => {
      const { terminalId, worktreeId, options } = args as {
        terminalId: string;
        worktreeId: string;
        options?: unknown;
      };
      return await copyTreeClient.injectToTerminal(terminalId, worktreeId, options as any);
    },
  }));

  actions.set("copyTree.cancel", () => ({
    id: "copyTree.cancel",
    title: "Cancel CopyTree",
    description: "Cancel an in-progress CopyTree generation",
    category: "copyTree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      await copyTreeClient.cancel();
    },
  }));

  actions.set("copyTree.getFileTree", () => ({
    id: "copyTree.getFileTree",
    title: "Get File Tree",
    description: "Get file tree nodes for file picker",
    category: "copyTree",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ worktreeId: z.string(), dirPath: z.string().optional() }),
    run: async (args: unknown) => {
      const { worktreeId, dirPath } = args as { worktreeId: string; dirPath?: string };
      return await copyTreeClient.getFileTree(worktreeId, dirPath);
    },
  }));
}
