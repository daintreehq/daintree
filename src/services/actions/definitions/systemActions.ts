import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import { defineAction } from "../defineAction";
import { CopyTreeOptionsSchema, FileSearchPayloadSchema, BuiltInAgentIdSchema } from "./schemas";
import {
  withWorktreeLocation,
  withProjectLocation,
  requireWorktreePath,
  requireWorktreeId,
  resolveProjectLocation,
} from "./locationArgs";
import { z } from "zod";
import {
  artifactClient,
  cliAvailabilityClient,
  copyTreeClient,
  filesClient,
  slashCommandsClient,
  systemClient,
} from "@/clients";
import { cancelContextInjection } from "@/hooks/useContextInjection";

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
      description:
        "Check whether an executable is available on the user's PATH. Args: `command` (required) — the executable name to look for (e.g. 'node', 'gh'). Returns { available: boolean }. Never errors for a missing command — absence is reported as available:false, not an exception.",
      category: "system",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({
        command: z.string().describe("Executable name to look for on PATH (e.g. 'node', 'gh')."),
      }),
      examples: [
        {
          args: { command: "node" },
          description: "Check if Node.js is available on PATH",
        },
        {
          args: { command: "gh" },
          description: "Check if the GitHub CLI is installed",
        },
      ],
      resultSchema: z.object({ available: z.boolean() }),
      run: async ({ command }) => {
        const result = await systemClient.checkCommand(command);
        return { available: result };
      },
    })
  );

  actions.set("system.checkDirectory", () =>
    defineAction({
      id: "system.checkDirectory",
      title: "Check Directory",
      description:
        "Check whether a filesystem directory exists. Args: `path` (required) — an absolute directory path. Returns { exists: boolean }. Never errors for a missing path — absence is reported as exists:false, not an exception.",
      category: "system",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({
        path: z.string().describe("Absolute directory path to test for existence."),
      }),
      examples: [
        {
          args: { path: "/Users/me/Projects/app" },
          description: "Check whether a project directory exists on disk",
        },
      ],
      resultSchema: z.object({ exists: z.boolean() }),
      run: async ({ path }) => {
        const result = await systemClient.checkDirectory(path);
        return { exists: result };
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
    resultSchema: z.object({ path: z.string() }),
    run: async () => {
      const result = await systemClient.getHomeDir();
      return { path: result };
    },
  }));

  actions.set("system.getResourceProfileSnapshot", () =>
    defineAction({
      id: "system.getResourceProfileSnapshot",
      title: "Get Resource Profile Snapshot",
      description:
        "Read a snapshot of the host machine's resource pressure and the active resource profile. Use this to gauge whether the machine has headroom before launching more agents or heavy work. No arguments. Returns { profile, thermalState, isOnBattery, speedLimit, lagPressureActive }: `profile` is 'performance' | 'balanced' | 'efficiency' (the adaptive mode currently in effect); `thermalState` is the OS thermal reading ('unknown' off macOS); `isOnBattery` is true when running unplugged; `speedLimit` is the OS CPU speed-limit percentage (0–100, 100 = unthrottled); `lagPressureActive` is true when sustained event-loop-lag mitigation is latched. Never errors — falls back to the balanced/unknown baseline when the service is still initializing.",
      category: "system",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      mcpVisibility: "discoverable",
      mcpOutputSchema: true,
      resultSchema: z.object({
        profile: z.enum(["performance", "balanced", "efficiency"]),
        thermalState: z.enum(["unknown", "nominal", "fair", "serious", "critical"]),
        isOnBattery: z.boolean(),
        speedLimit: z.number(),
        lagPressureActive: z.boolean(),
      }),
      run: async () => {
        return await systemClient.getResourceProfileSnapshot();
      },
    })
  );

  actions.set("cliAvailability.get", () => ({
    id: "cliAvailability.get",
    title: "Get CLI Availability",
    description:
      "Get the cached availability of agent CLIs (e.g. claude, codex, gemini) on the host. Use this to confirm an agent's CLI is installed before launching it. No arguments. Returns a map of agent id to a status string. Reads a cache populated at startup; call `cliAvailability.refresh` to force a re-check.",
    category: "system",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    mcpVisibility: "discoverable",
    resultSchema: z.record(z.string(), z.string()),
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
        "Search for files by name/glob within a directory tree. Args: `query` (required) — filename or glob; `cwd` (optional) — directory to search, defaults to the active worktree path; `limit` (optional) caps results. Returns { files } — an array of matching paths. Errors when `cwd` is omitted and no worktree is active.",
      category: "files",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: FileSearchPayloadSchema,
      examples: [
        {
          args: { query: "*.test.ts" },
          description: "Search for test files from the active worktree root",
        },
        {
          args: { query: "ActionService", limit: 10 },
          description: "Find up to 10 files matching 'ActionService'",
        },
      ],
      resultSchema: z.object({ files: z.array(z.string()) }),
      run: async (payload, ctx: ActionContext) => {
        const resolvedCwd = payload.cwd ?? ctx.activeWorktreePath;
        if (!resolvedCwd) throw new Error("No active worktree");
        return await filesClient.search({ ...payload, cwd: resolvedCwd });
      },
    })
  );

  actions.set("slashCommands.list", () =>
    defineAction({
      id: "slashCommands.list",
      title: "List Slash Commands",
      description:
        "List the slash commands available for an agent CLI. Args (all optional): `agentId` — built-in agent id (e.g. 'claude', 'codex'), defaults to 'claude'; `projectId` or `projectPath` — project to scope project-local commands, defaults to the active project. Returns { commands } — each with id, label, description, scope, agentId, and optional sourcePath/kind, and an empty list when the agent has none. Errors when `projectId` names a project that is not open.",
      category: "agent",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: withProjectLocation({
        agentId: BuiltInAgentIdSchema.optional().describe(
          "Agent ID. Defaults to 'claude' when omitted."
        ),
      }).optional(),
      resultSchema: z.object({
        commands: z.array(
          z.object({
            id: z.string(),
            label: z.string(),
            description: z.string(),
            scope: z.string(),
            agentId: z.string(),
            sourcePath: z.string().optional(),
            kind: z.string().optional(),
          })
        ),
      }),
      run: async (payload, ctx) => {
        const agentId = payload?.agentId ?? "claude";
        const result = await slashCommandsClient.list({
          agentId,
          projectPath: resolveProjectLocation(payload, ctx).projectPath,
        });
        return { commands: result };
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
      danger: "safe",
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
      description:
        "Apply a unified diff patch to the filesystem. Args: `patchContent` (required); `worktreeId` or `worktreePath` (required) — the worktree to apply into (`cwd` is accepted as a legacy alias for `worktreePath`). Errors when either argument is missing. There is deliberately no active-worktree default: a destructive write must name its target rather than fall back to whatever happens to be active.",
      category: "artifacts",
      kind: "command",
      danger: "confirm",
      dangerRationale:
        "Writes patch content directly into worktree files via git apply — a shared-state mutation with no automatic inverse; recovery is a manual git checkout of the touched files.",
      scope: "renderer",
      argsSchema: withWorktreeLocation(
        { patchContent: z.string() },
        { legacy: ["cwd"], requireSelector: true }
      ),
      run: async ({ patchContent, ...location }, ctx) => {
        return await artifactClient.applyPatch({
          patchContent,
          cwd: requireWorktreePath(location, ctx),
        });
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
    resultSchema: z.object({ available: z.boolean() }),
    run: async () => {
      const result = await copyTreeClient.isAvailable();
      return { available: result };
    },
  }));

  actions.set("copyTree.generate", () =>
    defineAction({
      id: "copyTree.generate",
      title: "Generate CopyTree Context",
      description:
        "Generate a CopyTree context dump (file tree plus selected file contents) for a worktree and return it as a string. Args (all optional): `worktreeId` or `worktreePath` — the worktree, defaults to the active one; `options` — CopyTree include/exclude options. Returns { content, fileCount, optional stats:{ totalSize, duration } }. Throws when generation fails or when no worktree is given and none is active. Do NOT use this to inject context into a terminal — use `copyTree.injectToTerminal`.",
      category: "copyTree",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      keywords: ["context", "dump", "snapshot", "tree"],
      argsSchema: withWorktreeLocation({
        options: CopyTreeOptionsSchema.optional(),
      }).optional(),
      resultSchema: z.object({
        content: z.string(),
        fileCount: z.number(),
        stats: z
          .object({
            totalSize: z.number(),
            duration: z.number(),
          })
          .optional(),
      }),
      run: async (args, ctx: ActionContext) => {
        const result = await copyTreeClient.generate(requireWorktreeId(args, ctx), args?.options);
        // A generation failure used to ride back in an `error` field beside an
        // empty dump. The MCP bridge serializes a returned value as a SUCCESSFUL
        // tool result, so an agent checking `isError` never saw it (#11543).
        // Throwing routes it through EXECUTION_ERROR, which the bridge reports
        // as a tool error. Everything else passes through untouched.
        const failure =
          result && typeof result === "object" ? (result as { error?: string }).error : undefined;
        if (failure) throw new Error(failure);
        return result;
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
      danger: "safe",
      scope: "renderer",
      // run() resolves the target from ctx.activeWorktreeId and throws when none
      // is active. Disable-with-reason in the palette rather than letting the
      // pick produce a "No active worktree" error toast.
      palette: {
        mode: "requireContext",
        isReady: (ctx) => Boolean(ctx.activeWorktreeId),
        reason: "Open a worktree to generate its context",
      },
      argsSchema: z
        .object({
          worktreeId: z
            .string()
            .optional()
            .describe("Worktree ID. Defaults to the active worktree."),
          options: CopyTreeOptionsSchema.optional(),
        })
        .optional(),
      run: async (args, ctx: ActionContext) => {
        const worktreeId = args?.worktreeId ?? ctx.activeWorktreeId;
        if (!worktreeId) throw new Error("No active worktree");
        return await copyTreeClient.generateAndCopyFile(worktreeId, args?.options);
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
      danger: "safe",
      scope: "renderer",
      keywords: ["context", "inject", "dump"],
      argsSchema: z.object({
        terminalId: z.string(),
        worktreeId: z.string().optional().describe("Worktree ID. Defaults to the active worktree."),
        options: CopyTreeOptionsSchema.optional(),
      }),
      run: async ({ terminalId, worktreeId, options }, ctx: ActionContext) => {
        const resolvedWorktreeId = worktreeId ?? ctx.activeWorktreeId;
        if (!resolvedWorktreeId) throw new Error("No active worktree");
        return await copyTreeClient.injectToTerminal(terminalId, resolvedWorktreeId, options);
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
      // Clears renderer injection state and cancels the active injection by
      // UUID, then sweeps any other in-flight CopyTree operations
      // (generate/copy-file). An injection started between these two calls
      // would be swept too — accepted: both are user-initiated cancels and
      // the window is a single microtask turn.
      cancelContextInjection();
      await copyTreeClient.cancel();
    },
  }));

  actions.set("copyTree.getFileTree", () =>
    defineAction({
      id: "copyTree.getFileTree",
      title: "Get File Tree",
      description: "List a directory as the generated context sees it",
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
        includeExcluded: z
          .boolean()
          .optional()
          .describe(
            "Also return entries the context leaves out, each flagged `excluded`. Omit to list only what would be copied."
          ),
      }),
      resultSchema: z.object({ nodes: z.array(z.unknown()) }),
      run: async ({ worktreeId, dirPath, includeExcluded }) => {
        const result = await copyTreeClient.getFileTree(worktreeId, dirPath, includeExcluded);
        return { nodes: result };
      },
    })
  );
}
