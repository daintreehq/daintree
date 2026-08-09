import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import { defineAction } from "../defineAction";
import { CopyTreeOptionsSchema, FileSearchPayloadSchema, BuiltInAgentIdSchema } from "./schemas";
import {
  withWorktreeLocation,
  withProjectLocation,
  requireWorktreePath,
  requireWorktreeId,
  requireExplicitWorktreeForAgentDispatch,
  resolveProjectLocation,
} from "./locationArgs";
import { z } from "zod";
import { notify } from "@/lib/notify";
import { formatCopyResultMessage } from "@/lib/formatCopyResult";
import { resolveCopyTreeRunSource } from "@/lib/copyTreeRunSource";
import {
  artifactClient,
  cliAvailabilityClient,
  copyTreeClient,
  filesClient,
  slashCommandsClient,
  systemClient,
} from "@/clients";
import { cancelContextInjection } from "@/hooks/useContextInjection";
import type { CopyTreeResult } from "@shared/types";
import { COPY_TREE_UNMATCHED_SELECTORS } from "@shared/types/ipc/copyTree";

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
      .describe(
        "Which supplied selector matched no files. For a folder, add '/**' to the pattern or use scopePaths instead."
      ),
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

function projectCopyTreeStats(stats: NonNullable<CopyTreeResult["stats"]>) {
  return {
    totalSize: stats.totalSize,
    duration: stats.duration,
    ...(stats.estimatedTokens !== undefined && { estimatedTokens: stats.estimatedTokens }),
    ...(stats.noFilesMatched !== undefined && { noFilesMatched: stats.noFilesMatched }),
    ...(stats.unmatchedSelector !== undefined && { unmatchedSelector: stats.unmatchedSelector }),
    ...(stats.truncated !== undefined && { truncated: stats.truncated }),
    ...(stats.truncatedCount !== undefined && { truncatedCount: stats.truncatedCount }),
    ...(stats.truncatedBy !== undefined && { truncatedBy: stats.truncatedBy }),
    ...(stats.budgetExceeded !== undefined && { budgetExceeded: stats.budgetExceeded }),
  };
}

/**
 * Turn an error-shaped CopyTree result into a thrown error.
 *
 * A returned value is serialized by the MCP bridge as a SUCCESSFUL tool result,
 * so a failure reported in an `error` field beside an empty dump is invisible to
 * an agent checking `isError` (#11543). Throwing routes it through
 * EXECUTION_ERROR, which the bridge reports as a tool error. `generate` already
 * did this; the other two returned their failures as success data.
 */
function throwOnCopyTreeFailure(result: CopyTreeResult): void {
  const failure =
    result && typeof result === "object" ? (result as { error?: string }).error : undefined;
  if (failure) throw new Error(failure);
}

/**
 * Narrow a file-backed result to the pair the schema declares as required.
 *
 * `filePath` and `outputBytes` are optional on `CopyTreeResult` — the inline
 * paths never set them — and only the handler's own check ties them to a
 * successful generation. Now that dispatch parses results (#11539) an unset one
 * would surface as RESULT_VALIDATION_ERROR, which tells a caller nothing. Assert
 * the invariant where it is used so the same condition reads as a plain failure.
 */
function requireGeneratedFile(result: CopyTreeResult): { filePath: string; outputBytes: number } {
  if (typeof result.filePath !== "string" || typeof result.outputBytes !== "number") {
    throw new Error("Failed to generate context");
  }
  return { filePath: result.filePath, outputBytes: result.outputBytes };
}

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
        "Read how much pressure the host machine is under and which adaptive performance mode is in effect. Use this to judge whether there is headroom before launching more agents or heavy work. Some readings are platform-specific and report as unknown elsewhere. It never fails — while the service is still starting it returns a neutral baseline, so treat an unremarkable reading early in a session with some caution.",
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
      run: async () => {
        return await systemClient.getResourceProfileSnapshot();
      },
    })
  );

  actions.set("cliAvailability.get", () => ({
    id: "cliAvailability.get",
    title: "Get CLI Availability",
    description:
      "Read which agent CLIs are installed on this machine, to confirm one exists before launching it. It answers from cache when one is warm and probes on demand when it is not, so a cached answer can miss a CLI installed since. Refresh explicitly when a stale answer would be misleading.",
    category: "system",
    kind: "query",
    danger: "safe",
    scope: "renderer",
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
        "List the slash commands an agent CLI offers, including any the project defines locally. Use this to discover what a given agent can be driven with before sending it a command. An empty list means the agent exposes none, whereas naming a project that is not open fails.",
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
        "Bundle a worktree's file tree and selected file contents into a context dump written to a temporary file, and return its path. Use this to hand a large codebase context to something that can read a file; inject directly into a terminal instead when the target is an agent. The bundle routinely runs to tens of megabytes and is never returned inline. Check the budget flags before trusting it as complete, and read the file promptly — it is pruned by age.",
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
        includeContent: z
          .boolean()
          .optional()
          .describe(
            "Also return a bounded head of the bundle in `content`. Capped well under the tool-result limit; `contentTruncated` reports when it was cut. The file at `filePath` always holds the whole bundle."
          ),
      }).optional(),
      resultSchema: CopyTreeGenerateResultSchema,
      // A `resultSchema` alone advertises nothing — the manifest only publishes
      // an MCP outputSchema when this flag is set too.
      mcpOutputSchema: true,
      run: async (args, ctx: ActionContext) => {
        const result = await copyTreeClient.generate(
          requireWorktreeId(args, ctx),
          args?.options,
          args?.includeContent,
          resolveCopyTreeRunSource(ctx.dispatchSource, ctx.copyTreeRunSource)
        );
        throwOnCopyTreeFailure(result);
        const { filePath, outputBytes } = requireGeneratedFile(result);
        // "generated"/"bundled", never "copied": this writes a temp file and
        // never touches the clipboard, so the clipboard wording would be false.
        // Ordered after both failure checks so a bundle that never landed can't
        // announce success. No `context.worktreeId` — see the note on
        // generateAndCopyFile below (#11735).
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
        notify({
          type: "success",
          title: "Context generated",
          message: formatCopyResultMessage(
            {
              fileCount: result.fileCount,
              stats: result.stats,
              format: args?.options?.format,
            },
            "temporary-file"
          ),
          rateLimitKey: "copyTree.generate",
          context: { eventKind: "agent" },
        });
        // Projected explicitly rather than passed through. Dispatch does parse
        // results against `resultSchema` now (#11539), but building the result
        // here is still what keeps the bundle off the wire: a parse would reject
        // an oversized `content`, not drop it.
        return {
          filePath,
          fileCount: result.fileCount,
          outputBytes,
          ...(result.outputFormatVersion !== undefined
            ? { outputFormatVersion: result.outputFormatVersion }
            : {}),
          // Gated on what was ASKED for, not on what came back: keying off the
          // response would forward a bundle to a caller who never opted in if
          // the layer below ever returned one.
          ...(args?.includeContent
            ? { content: result.content, contentTruncated: result.contentTruncated === true }
            : {}),
          ...(result.stats ? { stats: projectCopyTreeStats(result.stats) } : {}),
        };
      },
    })
  );

  actions.set("copyTree.generateAndCopyFile", () =>
    defineAction({
      id: "copyTree.generateAndCopyFile",
      title: "Generate And Copy Context",
      description:
        "Bundle a worktree's context to a file and put it on the system clipboard, replacing what the user had copied. Selection can mix exact files with globs, so this assembles a curated bundle of scattered related files, their supporting code and tests, rather than the whole worktree. Agent and MCP callers must name the worktree instead of relying on whichever is active. macOS and Linux copy the file, Windows its path. Never returned inline; check the budget flags for completeness.",
      category: "copyTree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      // run() resolves the target from ctx.activeWorktreeId and throws when none
      // is active. Disable-with-reason in the palette rather than letting the
      // pick produce a "No active worktree" error toast. Palette picks dispatch
      // with source "user", so the agent-only explicit-target guard below never
      // applies to them and this fallback stays intact.
      palette: {
        mode: "requireContext",
        isReady: (ctx) => Boolean(ctx.activeWorktreeId),
        reason: "Open a worktree to generate its context",
      },
      argsSchema: withWorktreeLocation({
        options: CopyTreeOptionsSchema.optional().describe(
          "Selection, exclusion, formatting, and size-budget settings for the bundle."
        ),
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
      run: async (args, ctx: ActionContext) => {
        requireExplicitWorktreeForAgentDispatch("copyTree.generateAndCopyFile", args, ctx);
        const result = await copyTreeClient.generateAndCopyFile(
          requireWorktreeId(args, ctx),
          args?.options,
          resolveCopyTreeRunSource(ctx.dispatchSource, ctx.copyTreeRunSource)
        );
        throwOnCopyTreeFailure(result);
        const { filePath, outputBytes } = requireGeneratedFile(result);
        // Announced for every dispatch source, not just agents. The old
        // agent-only gate assumed a person who triggered this already knows
        // their clipboard changed — true of a button with inline feedback, but
        // this action's only human route is the command palette, which leaves
        // nothing on screen at all (#11735). Ordered after the failure checks so
        // a failed generate or a failed clipboard write can never announce
        // success.
        //
        // No `context.worktreeId` here, deliberately: notify() suppresses a
        // high-priority toast into the inbox when context names the worktree
        // the user is already looking at, and copying the ACTIVE worktree is the
        // common case — passing it would silence exactly this toast. A clipboard
        // overwrite is invisible no matter which worktree is on screen, so the
        // origin-surface rule doesn't hold here.
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
        notify({
          type: "success",
          // Matches the title every other copy-tree completion uses for this
          // artifact ("context", never "reference file"), paired with the same
          // formatCopyResultMessage body — see worktreeContextActions.ts.
          title: "Context copied",
          message: formatCopyResultMessage({
            fileCount: result.fileCount,
            stats: result.stats,
            format: args?.options?.format,
          }),
          // Its own bucket. The key otherwise falls back to `type`, putting
          // every "success" toast in the app in one bucket — three unrelated
          // ones would swallow this into a generic overflow row and lose the
          // message that says what is on the clipboard.
          rateLimitKey: "copyTree.generateAndCopyFile",
          // "agent", not "completed": both route identically (active → high),
          // but "completed" owns the `completedEnabled` setting, which gates
          // only main-process completion watches and never a renderer
          // notify() — so it would offer a "silence completed notifications"
          // affordance that leaves these copies firing anyway.
          context: { eventKind: "agent" },
        });
        return {
          filePath,
          fileCount: result.fileCount,
          outputBytes,
          ...(result.stats ? { stats: projectCopyTreeStats(result.stats) } : {}),
        };
      },
    })
  );

  actions.set("copyTree.injectToTerminal", () =>
    defineAction({
      id: "copyTree.injectToTerminal",
      title: "Inject Context To Terminal",
      description:
        "Bundle a worktree's context and write it straight into a terminal, which is how an agent is given a large codebase context. The context goes to the terminal and never comes back in the result, so read the budget flags to tell whether the bundle was complete. This types a potentially enormous payload into a live pane, so target an idle terminal.",
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
      // No path: this bundle is streamed into the PTY and never written to disk.
      resultSchema: z.object({
        fileCount: z.number(),
        stats: CopyTreeStatsSchema,
      }),
      mcpOutputSchema: true,
      run: async ({ terminalId, worktreeId, options }, ctx: ActionContext) => {
        const resolvedWorktreeId = worktreeId ?? ctx.activeWorktreeId;
        if (!resolvedWorktreeId) throw new Error("No active worktree");
        const result = await copyTreeClient.injectToTerminal(
          terminalId,
          resolvedWorktreeId,
          options,
          undefined,
          resolveCopyTreeRunSource(ctx.dispatchSource, ctx.copyTreeRunSource)
        );
        throwOnCopyTreeFailure(result);
        // "injected … into terminal", not "copied": the bundle streams into a
        // PTY and never reaches the clipboard. Ordered after the failure check.
        // No `context.worktreeId` — see the note on generateAndCopyFile above.
        // The renderer's own injection path (`useContextInjection`) calls the
        // client directly and carries its own key, so the two never stack
        // (#11735).
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
        notify({
          type: "success",
          title: "Context injected",
          message: formatCopyResultMessage(
            {
              fileCount: result.fileCount,
              stats: result.stats,
              format: options?.format,
            },
            "terminal"
          ),
          rateLimitKey: "copyTree.injectToTerminal",
          context: { eventKind: "agent" },
        });
        return {
          fileCount: result.fileCount,
          ...(result.stats ? { stats: projectCopyTreeStats(result.stats) } : {}),
        };
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
