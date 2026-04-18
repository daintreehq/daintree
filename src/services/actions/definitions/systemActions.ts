import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { defineAction } from "../defineAction";
import { CopyTreeOptionsSchema, FileSearchPayloadSchema, BuiltInAgentIdSchema } from "./schemas";
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
  actions.set("system.openExternal", () =>
    defineAction({
      id: "system.openExternal",
      title: "Open External URL",
      description: "Open a URL in the system browser",
      category: "system",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({ url: z.string() }),
      run: async ({ url }) => {
        await systemClient.openExternal(url);
      },
    })
  );

  actions.set("system.openPath", () =>
    defineAction({
      id: "system.openPath",
      title: "Open Path",
      description: "Open a file or folder in the system file manager",
      category: "system",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({ path: z.string() }),
      run: async ({ path }) => {
        await systemClient.openPath(path);
      },
    })
  );

  actions.set("system.checkCommand", () =>
    defineAction({
      id: "system.checkCommand",
      title: "Check Command Availability",
      description: "Check whether a command is available on PATH",
      category: "system",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({ command: z.string() }),
      run: async ({ command }) => {
        return await systemClient.checkCommand(command);
      },
    })
  );

  actions.set("system.checkDirectory", () =>
    defineAction({
      id: "system.checkDirectory",
      title: "Check Directory",
      description: "Check whether a directory exists",
      category: "system",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({ path: z.string() }),
      run: async ({ path }) => {
        return await systemClient.checkDirectory(path);
      },
    })
  );

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

  actions.set("files.search", () =>
    defineAction({
      id: "files.search",
      title: "Search Files",
      description:
        "Search for files by name in a directory. Requires cwd (use project.getCurrent to get the project path).",
      category: "files",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: FileSearchPayloadSchema,
      run: async (payload) => {
        return await filesClient.search(payload);
      },
    })
  );

  actions.set("slashCommands.list", () =>
    defineAction({
      id: "slashCommands.list",
      title: "List Slash Commands",
      description: "List available slash commands for an agent",
      category: "agent",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({ agentId: BuiltInAgentIdSchema, projectPath: z.string().optional() }),
      run: async (payload) => {
        return await slashCommandsClient.list(payload);
      },
    })
  );

  actions.set("artifact.saveToFile", () =>
    defineAction({
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
      run: async (args) => {
        return await artifactClient.saveToFile(args);
      },
    })
  );

  actions.set("artifact.applyPatch", () =>
    defineAction({
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
      run: async (args) => {
        return await artifactClient.applyPatch(args);
      },
    })
  );

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

  actions.set("copyTree.generate", () =>
    defineAction({
      id: "copyTree.generate",
      title: "Generate CopyTree Context",
      description: "Generate worktree context (returns content)",
      category: "copyTree",
      kind: "query",
      danger: "confirm",
      scope: "renderer",
      argsSchema: z.object({ worktreeId: z.string(), options: CopyTreeOptionsSchema.optional() }),
      run: async ({ worktreeId, options }) => {
        return await copyTreeClient.generate(worktreeId, options);
      },
    })
  );

  actions.set("copyTree.generateAndCopyFile", () =>
    defineAction({
      id: "copyTree.generateAndCopyFile",
      title: "Generate And Copy Context",
      description: "Generate worktree context and copy to clipboard",
      category: "copyTree",
      kind: "command",
      danger: "confirm",
      scope: "renderer",
      argsSchema: z.object({ worktreeId: z.string(), options: CopyTreeOptionsSchema.optional() }),
      run: async ({ worktreeId, options }) => {
        return await copyTreeClient.generateAndCopyFile(worktreeId, options);
      },
    })
  );

  actions.set("copyTree.injectToTerminal", () =>
    defineAction({
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
      run: async ({ terminalId, worktreeId, options }) => {
        return await copyTreeClient.injectToTerminal(terminalId, worktreeId, options);
      },
    })
  );

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

  actions.set("copyTree.getFileTree", () =>
    defineAction({
      id: "copyTree.getFileTree",
      title: "Get File Tree",
      description: "Get file tree nodes for file picker",
      category: "copyTree",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({
        worktreeId: z.string().describe("Worktree ID to browse"),
        dirPath: z
          .string()
          .optional()
          .describe(
            "Relative path within the worktree (e.g. 'src', 'src/components'). Omit for root."
          ),
      }),
      run: async ({ worktreeId, dirPath }) => {
        return await copyTreeClient.getFileTree(worktreeId, dirPath);
      },
    })
  );
}
