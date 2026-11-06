import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import { defineAction } from "../defineAction";
import { CopyTreeOptionsSchema, FileSearchPayloadSchema, BuiltInAgentIdSchema } from "./schemas";
import { withWorktreeLocation, withProjectLocation } from "./locationArgs";
import { mayCopyWorkspaceRoot } from "./workspaceRootCopyTarget";
import { z } from "zod";
import { COPY_TREE_UNMATCHED_SELECTORS } from "@shared/types/ipc/copyTree";
import type { SystemActionRunArgs, SystemActionRunId } from "./systemActions.impl";

/**
 * The generation numbers every CopyTree action reports.
 *
 * Narrower than CopyTree's own `stats`: the per-reason exclusion breakdown stays
 * off, because #11528's whole point is that these tools return metadata rather
 * than bulk. The budget flags below are on for the opposite reason — they are
 * scalars, and they are the only way a caller learns its bundle is INCOMPLETE
 * now that the bundle itself sits in a file rather than in the result. Dispatch
 * parses results against this schema (#11539), so an undeclared flag is a flag
 * the caller never sees.
 */
const CopyTreeStatsSchema = z
  .object({
    totalSize: z.number(),
    duration: z.number(),
    estimatedTokens: z.number().optional().describe("Rough token count, accurate to about ±20%"),
    noFilesMatched: z.boolean().optional().describe("Nothing matched — a valid outcome, not error"),
    // Still a scalar, so it stays on the right side of #11528's line: it names
    // the field to fix rather than shipping the per-reason breakdown a caller
    // would have to interpret. Without it `noFilesMatched` says only that the
    // bundle is empty, and the caller guesses at the option shape (#11731).
    unmatchedSelector: z
      .enum(COPY_TREE_UNMATCHED_SELECTORS)
      .optional()
      .describe("Selector that matched no files. For a folder, add '/**' or use scopePaths."),
    truncated: z.boolean().optional().describe("A budget dropped or cut short some files"),
    truncatedCount: z.number().optional(),
    truncatedBy: z
      .string()
      .optional()
      .describe("Which budget bit first: maxFileCount, maxTotalSize or charLimit"),
    budgetExceeded: z
      .boolean()
      .optional()
      .describe("The retained set is larger than maxTotalSize — can be true without truncation"),
  })
  .optional();

const CopyTreeGenerateResultSchema = z.object({
  filePath: z
    .string()
    .describe("Absolute path of the written bundle. Temporary — read it promptly."),
  fileCount: z.number(),
  outputBytes: z.number().describe("UTF-8 size of the bundle on disk."),
  outputFormatVersion: z
    .string()
    .nullable()
    .optional()
    .describe("Version of the emitted format, e.g. `copytree-xml@1`."),
  content: z
    .string()
    .optional()
    .describe("Head of the bundle, only when `includeContent` was set."),
  contentTruncated: z.boolean().optional(),
  stats: CopyTreeStatsSchema,
});

/**
 * The optional display label an MCP caller can attach to a run (#11734).
 *
 * One definition for all three copy-tree tools: the field means the same thing
 * on each, and the text below is what an agent actually reads when deciding
 * whether to pass it, so a per-tool reword would be three chances to drift.
 * `.describe()` sits last in the chain because anything after it is what
 * `toJSONSchema` emits — attached earlier the text is silently dropped.
 */
const copyTreeRunNameField = z
  .string()
  .optional()
  .describe("2-4 word label ('auth flow context') for the copy-tree history and notification.");

/**
 * Run bodies load on first dispatch (#14274, after the git pilot in #14239).
 * Every view registers the system actions at boot for menus, keybindings and the
 * MCP manifest, but an empty view runs none of them. A failed chunk load
 * rejects inside `run`, which ActionService turns into an error result like any
 * other failure.
 */
async function runSystemAction<Id extends SystemActionRunId>(
  id: Id,
  args: SystemActionRunArgs<Id>,
  ctx: ActionContext
): Promise<unknown> {
  const { systemActionRuns } = await import("./systemActions.impl");
  return systemActionRuns[id](args, ctx);
}

export function registerSystemActions(actions: ActionRegistry, _callbacks: ActionCallbacks): void {
  actions.set("system.openExternal", () =>
    defineAction({
      id: "system.openExternal",
      title: "Open external URL",
      description: "Open a URL in the system browser",
      category: "system",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({ url: z.string() }),
      run: (args, ctx) => runSystemAction("system.openExternal", args, ctx),
    })
  );

  actions.set("system.openPath", () =>
    defineAction({
      id: "system.openPath",
      title: "Open path",
      description: "Open a file or folder in the system file manager",
      category: "system",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({ path: z.string() }),
      run: (args, ctx) => runSystemAction("system.openPath", args, ctx),
    })
  );

  actions.set("system.checkCommand", () =>
    defineAction({
      id: "system.checkCommand",
      title: "Check command availability",
      description:
        "Check whether an executable is present on the user's PATH, to confirm a tool exists before depending on it. Absence is reported as a negative result rather than an error, so this never fails for a missing command. It only establishes presence — it neither runs the command nor reports its version.",
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
      run: (args, ctx) => runSystemAction("system.checkCommand", args, ctx),
    })
  );

  actions.set("system.checkDirectory", () =>
    defineAction({
      id: "system.checkDirectory",
      title: "Check directory",
      description:
        "Check whether a filesystem directory exists at an absolute path. Absence is reported as a negative result rather than an error, so this never fails for a missing path. It reports existence only, not readability, contents or whether the path is a file.",
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
      run: (args, ctx) => runSystemAction("system.checkDirectory", args, ctx),
    })
  );

  actions.set("system.getHomeDir", () => ({
    id: "system.getHomeDir",
    title: "Get home directory",
    description: "Get the user's home directory path",
    category: "system",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    resultSchema: z.object({ path: z.string() }),
    run: (args, ctx) => runSystemAction("system.getHomeDir", args, ctx),
  }));

  actions.set("system.getResourceProfileSnapshot", () =>
    defineAction({
      id: "system.getResourceProfileSnapshot",
      title: "Get resource profile snapshot",
      description:
        "Read how much pressure the host machine is under and which adaptive performance mode is in effect. Use this to judge whether there is headroom before launching more agents or heavy work. Some readings are platform-specific and report as unknown elsewhere. It never fails: while the service is starting it returns a neutral baseline, so treat an unremarkable early reading with caution.",
      category: "system",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      mcpOutputSchema: true,
      resultSchema: z.object({
        profile: z.enum(["performance", "balanced", "efficiency"]),
        thermalState: z.enum(["unknown", "nominal", "fair", "serious", "critical"]),
        isOnBattery: z.boolean(),
        speedLimit: z.number(),
        lagPressureActive: z.boolean(),
      }),
      run: (args, ctx) => runSystemAction("system.getResourceProfileSnapshot", args, ctx),
    })
  );

  actions.set("cliAvailability.get", () => ({
    id: "cliAvailability.get",
    title: "Get CLI availability",
    description:
      "Read which agent CLIs are installed on this machine, to confirm one exists before launching it. It answers from cache when one is warm and probes on demand when it is not, so a cached answer can miss a CLI installed since. Refresh explicitly when a stale answer would be misleading.",
    category: "system",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    resultSchema: z.record(z.string(), z.string()),
    run: (args, ctx) => runSystemAction("cliAvailability.get", args, ctx),
  }));

  actions.set("cliAvailability.refresh", () => ({
    id: "cliAvailability.refresh",
    title: "Refresh CLI availability",
    description: "Re-check agent CLI availability (slower)",
    category: "system",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: (args, ctx) => runSystemAction("cliAvailability.refresh", args, ctx),
  }));

  actions.set("files.search", () =>
    defineAction({
      id: "files.search",
      title: "Search files",
      description:
        "Find files whose name or path contains the query, within a worktree. Matching is plain substring, not glob, and never looks at file contents — use a source-reading capability to search inside files. Results are capped and truncated silently rather than paged, so a full-looking result may not be exhaustive when the query is broad.",
      category: "files",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: FileSearchPayloadSchema,
      examples: [
        {
          args: { query: ".test.ts" },
          description: "Search for test files from the active worktree root",
        },
        {
          args: { query: "ActionService", limit: 10 },
          description: "Find up to 10 files matching 'ActionService'",
        },
      ],
      resultSchema: z.object({ files: z.array(z.string()) }),
      run: (args, ctx) => runSystemAction("files.search", args, ctx),
    })
  );

  actions.set("slashCommands.list", () =>
    defineAction({
      id: "slashCommands.list",
      title: "List slash commands",
      description:
        "List the slash commands an agent CLI offers, with what each does, project-local ones included. An empty list means it has none.",
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
      run: (args, ctx) => runSystemAction("slashCommands.list", args, ctx),
    })
  );

  actions.set("artifact.saveToFile", () =>
    defineAction({
      id: "artifact.saveToFile",
      title: "Save artifact to file",
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
      run: (args, ctx) => runSystemAction("artifact.saveToFile", args, ctx),
    })
  );

  actions.set("artifact.applyPatch", () =>
    defineAction({
      id: "artifact.applyPatch",
      title: "Apply patch",
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
      run: (args, ctx) => runSystemAction("artifact.applyPatch", args, ctx),
    })
  );

  actions.set("copyTree.isAvailable", () => ({
    id: "copyTree.isAvailable",
    title: "CopyTree availability",
    description: "Check whether CopyTree is available",
    category: "copyTree",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    resultSchema: z.object({ available: z.boolean() }),
    run: (args, ctx) => runSystemAction("copyTree.isAvailable", args, ctx),
  }));

  actions.set("copyTree.generate", () =>
    defineAction({
      id: "copyTree.generate",
      title: "Generate CopyTree context",
      description:
        "Bundle a worktree's file tree and selected contents into a context file on disk and return its path; never inline, often tens of MB. To give an agent context, inject into its terminal instead. Check the budget flags before trusting it, and read it promptly: it is pruned by age.",
      category: "copyTree",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      keywords: ["context", "dump", "snapshot", "tree"],
      // Kind stays `query` — this reads a worktree and the palette treats it as
      // one — but the annotations it would imply are now false: every call
      // writes a new temp file, so the result is neither read-only nor the same
      // twice (#11528).
      mcpAnnotations: { readOnlyHint: false, idempotentHint: false },
      argsSchema: withWorktreeLocation({
        options: CopyTreeOptionsSchema.optional(),
        name: copyTreeRunNameField,
        includeContent: z
          .boolean()
          .optional()
          .describe(
            "Also return a bounded head of the bundle in `content`; `contentTruncated` says if it was cut. The file always holds the whole bundle."
          ),
      }).optional(),
      resultSchema: CopyTreeGenerateResultSchema,
      // A `resultSchema` alone advertises nothing — the manifest only publishes
      // an MCP outputSchema when this flag is set too.
      mcpOutputSchema: true,
      run: (args, ctx) => runSystemAction("copyTree.generate", args, ctx),
    })
  );

  actions.set("copyTree.generateAndCopyFile", () =>
    defineAction({
      id: "copyTree.generateAndCopyFile",
      title: "Generate and copy context",
      description:
        "Bundle a worktree's context to a file and put it on the system clipboard, replacing what the user copied: the file on macOS/Linux, its path on Windows. Agents must name the worktree, or omit it if none exist to copy the root. Never returned inline; check budget flags.",
      category: "copyTree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      // run() resolves the target from ctx.activeWorktreeId, or the workspace
      // root when there is no worktree, and throws with no workspace at all.
      // Disable-with-reason in the palette rather than letting the pick produce
      // an error toast. Palette picks dispatch with source "user", so the
      // agent-only explicit-target guard in its run never applies to them and this
      // fallback stays intact.
      palette: {
        mode: "requireContext",
        isReady: (ctx) => Boolean(ctx.activeWorktreeId) || mayCopyWorkspaceRoot(ctx),
        reason: "Open a project or scratch to generate its context",
      },
      argsSchema: withWorktreeLocation({
        options: CopyTreeOptionsSchema.optional().describe(
          "Selection, exclusion, formatting and size budgets."
        ),
        name: copyTreeRunNameField,
      }).optional(),
      // `destructiveHint` is otherwise derived from `danger === "confirm"`, so
      // this would advertise as non-destructive while `actionRiskBand` already
      // classifies it `destructive-local`. It replaces the clipboard, which has
      // no inverse — the annotation should say so to a caller deciding whether
      // to ask first. `danger` stays "safe": the issue wants an assistant-driven
      // copy to land like a manual one, not behind a confirm dialog.
      mcpAnnotations: { destructiveHint: true, idempotentHint: false },
      resultSchema: z.object({
        filePath: z.string(),
        fileCount: z.number(),
        outputBytes: z.number(),
        stats: CopyTreeStatsSchema,
      }),
      mcpOutputSchema: true,
      run: (args, ctx) => runSystemAction("copyTree.generateAndCopyFile", args, ctx),
    })
  );

  actions.set("copyTree.injectToTerminal", () =>
    defineAction({
      id: "copyTree.injectToTerminal",
      title: "Inject context to terminal",
      description:
        "Paste a worktree's context into an agent, never a shell, as an unsent draft: the way to give an agent a large codebase context. Only budget flags come back, so check them for completeness. Target an idle agent: it can be enormous.",
      category: "copyTree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      keywords: ["context", "inject", "dump"],
      argsSchema: z.object({
        terminalId: z.string(),
        worktreeId: z.string().optional().describe("Worktree id (default: active worktree)."),
        options: CopyTreeOptionsSchema.optional(),
        name: copyTreeRunNameField,
      }),
      // No path: this bundle is streamed into the PTY and never written to disk.
      resultSchema: z.object({
        fileCount: z.number(),
        stats: CopyTreeStatsSchema,
      }),
      mcpOutputSchema: true,
      run: (args, ctx) => runSystemAction("copyTree.injectToTerminal", args, ctx),
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
    run: (args, ctx) => runSystemAction("copyTree.cancel", args, ctx),
  }));

  actions.set("copyTree.getFileTree", () =>
    defineAction({
      id: "copyTree.getFileTree",
      title: "Get file tree",
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
      run: (args, ctx) => runSystemAction("copyTree.getFileTree", args, ctx),
    })
  );
}
