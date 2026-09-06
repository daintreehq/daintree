/**
 * Zod schemas for IPC payload validation between main and renderer processes.
 */

import { z } from "zod";
import { BUILT_IN_PANEL_KINDS, panelKindHasPty } from "../../shared/config/panelKindRegistry.js";
import { BUILT_IN_AGENT_IDS } from "../../shared/config/agentIds.js";
import { MAX_TERMINAL_GRID_DIMENSION } from "../../shared/types/terminal.js";
import { COPY_TREE_RUN_SOURCES } from "../../shared/types/ipc/copyTreeHistory.js";
import {
  ASSISTANT_HOST_PROTOCOL_VERSION,
  type AssistantHostEvent,
  type AssistantHostCommand,
  type AssistantHostSessionDescriptor,
  type AssistantToolState,
} from "../../shared/types/ipc/assistantHost.js";
import type {
  McpAuditResult,
  McpAuditSeverity,
  McpConfirmationDecision,
  TurnOutcomeClass,
} from "../../shared/types/ipc/mcpServer.js";
import { MAX_TERMINALS_PER_RECIPE_ADMISSION_BATCH } from "../../shared/utils/recipeSanitizer.js";

/** Schema for a launch hint — built-in agent id or plugin-provided string. */
const LaunchAgentIdSchema = z.union([z.enum(BUILT_IN_AGENT_IDS), z.string().min(1)]);
const TitleModeSchema = z.enum(["default", "custom", "user"]);

// ============================================================================
// Terminal Entry Validation Schemas
// ============================================================================

/**
 * Schema for terminal location in appState - only grid or dock are persisted.
 * Note: "trash" is a runtime state not persisted at the app level.
 */
export const AppStateTerminalLocationSchema = z.enum(["grid", "dock"]);

/**
 * Schema for terminal location in project state - includes all locations.
 */
export const TerminalLocationSchema = z.enum(["grid", "dock", "overlay", "trash", "background"]);

/**
 * Schema for panel/terminal kind - distinguishes built-in panel types.
 */
/**
 * Whether a passthrough `kindRef` marks this snapshot as a project-local
 * plugin's panel (#12280). Deliberately structural rather than schema-validated:
 * `kindRef` is never declared on the snapshot schemas, because a malformed one
 * would fail validation and take the whole panel with it.
 */
function isProjectPanelKindRef(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  return (value as { origin?: unknown }).origin === "project";
}

export const PanelKindSchema = z.union([
  z.enum(BUILT_IN_PANEL_KINDS),
  z.string(), // Allow extension-provided kinds
]);

/**
 * Schema for terminal entries in appState.terminals (persisted globally).
 * This is the minimal schema for ordering/metadata preservation.
 * Note: Uses AppStateTerminalLocationSchema which excludes "trash" to match StoreSchema.
 * Uses passthrough() to preserve unknown fields for forward compatibility with extensions.
 *
 * PTY-backed panels (terminal, agent, dev-preview) require `type` and `cwd`.
 * Non-PTY panels (browser) have these fields optional since they don't spawn processes.
 */
export const AppStateTerminalEntrySchema = z
  .object({
    id: z.string().min(1),
    kind: PanelKindSchema.optional(),
    launchAgentId: LaunchAgentIdSchema.optional(),
    title: z.string(),
    titleMode: TitleModeSchema.optional(),
    cwd: z.string().optional(),
    worktreeId: z.string().optional(),
    location: AppStateTerminalLocationSchema,
    command: z.string().optional(),
    settings: z
      .object({
        autoRestart: z.boolean().optional(),
      })
      .optional(),
    isInputLocked: z.boolean().optional(),
    browserUrl: z.string().optional(),
    devCommand: z.string().optional(),
    devServerStatus: z.enum(["stopped", "starting", "installing", "running", "error"]).optional(),
    devServerPhaseLabel: z.string().nullable().optional(),
    devServerUrl: z.string().optional(),
    devServerError: z
      .object({
        type: z.string(),
        message: z.string(),
      })
      .optional(),
    devServerTerminalId: z.string().optional(),
    browserConsoleOpen: z.boolean().optional(),
    devPreviewConsoleOpen: z.boolean().optional(),
    pluginId: z.string().optional(),
  })
  .passthrough()
  .refine(
    (data) => {
      // PTY-backed panels require type and cwd
      // Non-PTY panels (browser) don't need them

      // Infer kind from content fields if missing (backwards compatibility)
      let kind = data.kind;
      if (!kind) {
        if (data.browserUrl !== undefined) {
          kind = "browser";
        } else if (data.devCommand !== undefined) {
          kind = "dev-preview";
        } else {
          kind = "terminal"; // default to terminal
        }
      }

      // A project-local plugin's kind is persisted PORTABLY (#12280), and that
      // portable form is byte-identical to a global plugin's runtime form. So a
      // registry lookup here can answer from a DIFFERENT plugin that happens to
      // share the manifest and kind id — an ordinary situation while developing
      // a plugin in `.daintree/plugins` with the published one still installed.
      // If that global kind declares `hasPty`, this refinement would demand a
      // `cwd` the project panel never had and `filterValidTerminalEntries` would
      // drop the panel outright. Plugin panels are not PTY-backed in v1 (their
      // kind collapses to `terminal` at creation), so a project ref is exempt.
      if (isProjectPanelKindRef(data.kindRef)) return true;
      if (panelKindHasPty(kind)) {
        return data.cwd !== undefined;
      }
      return true;
    },
    {
      message: "PTY-backed panels require a 'cwd' field",
    }
  );

/**
 * Schema for terminal snapshots in ProjectState.terminals (per-project state).
 * Matches the PanelSnapshot interface from shared/types/project.ts.
 * Uses passthrough() to preserve unknown fields for forward compatibility with extensions.
 */
export const TerminalSnapshotSchema = z
  .object({
    id: z.string().min(1),
    kind: PanelKindSchema.optional(),
    launchAgentId: LaunchAgentIdSchema.optional(),
    title: z.string(),
    titleMode: TitleModeSchema.optional(),
    cwd: z.string().optional(),
    worktreeId: z.string().optional(),
    location: TerminalLocationSchema,
    command: z.string().optional(),
    browserUrl: z.string().optional(),
    devCommand: z.string().optional(),
    devServerStatus: z.enum(["stopped", "starting", "installing", "running", "error"]).optional(),
    devServerPhaseLabel: z.string().nullable().optional(),
    devServerUrl: z.string().optional(),
    devServerError: z
      .object({
        type: z.string(),
        message: z.string(),
      })
      .optional(),
    devServerTerminalId: z.string().optional(),
    browserConsoleOpen: z.boolean().optional(),
    devPreviewConsoleOpen: z.boolean().optional(),
    agentSessionId: z.string().optional(),
    agentLaunchFlags: z.array(z.string()).optional(),
    agentModelId: z.string().optional(),
    agentPresetId: z.string().optional(),
    agentPresetColor: z.string().optional(),
    originalPresetId: z.string().optional(),
    // Captured launch env replayed on restore so a session keeps its provider
    // environment (#10922). Re-sanitized on the renderer serialize/respawn
    // boundary; validated here only as a string map.
    env: z.record(z.string(), z.string()).optional(),
    isUsingFallback: z.boolean().optional(),
    fallbackChainIndex: z.number().int().nonnegative().optional(),
    pluginId: z.string().optional(),
  })
  .passthrough()
  .refine(
    (data) => {
      // PTY-backed panels require type and cwd
      // Non-PTY panels (browser) don't need them

      // Infer kind from content fields if missing (backwards compatibility)
      let kind = data.kind;
      if (!kind) {
        if (data.browserUrl !== undefined) {
          kind = "browser";
        } else if (data.devCommand !== undefined) {
          kind = "dev-preview";
        } else {
          kind = "terminal"; // default to terminal
        }
      }

      // A project-local plugin's kind is persisted PORTABLY (#12280), and that
      // portable form is byte-identical to a global plugin's runtime form. So a
      // registry lookup here can answer from a DIFFERENT plugin that happens to
      // share the manifest and kind id — an ordinary situation while developing
      // a plugin in `.daintree/plugins` with the published one still installed.
      // If that global kind declares `hasPty`, this refinement would demand a
      // `cwd` the project panel never had and `filterValidTerminalEntries` would
      // drop the panel outright. Plugin panels are not PTY-backed in v1 (their
      // kind collapses to `terminal` at creation), so a project ref is exempt.
      if (isProjectPanelKindRef(data.kindRef)) return true;
      if (panelKindHasPty(kind)) {
        return data.cwd !== undefined;
      }
      return true;
    },
    {
      message: "PTY-backed panels require a 'cwd' field",
    }
  );

export type AppStateTerminalEntry = z.infer<typeof AppStateTerminalEntrySchema>;
export type TerminalSnapshotEntry = z.infer<typeof TerminalSnapshotSchema>;

// ============================================================================
// Recipe Validation Schemas
// ============================================================================

/**
 * Schema for a single terminal definition within a recipe.
 * Matches the RecipeTerminal interface from shared/types/project.ts.
 * Uses passthrough() to preserve unknown fields for forward compatibility.
 */
export const RecipeTerminalSchema = z
  .object({
    type: z.string().min(1),
    title: z.string().optional(),
    command: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    initialPrompt: z.string().optional(),
    args: z.string().optional(),
    devCommand: z.string().optional(),
    exitBehavior: z.enum(["keep", "trash", "remove", "restart"]).optional(),
    agentModelId: z.string().optional(),
    agentLaunchFlags: z.array(z.string()).optional(),
  })
  .passthrough();

/**
 * Schema for a saved terminal recipe.
 * Matches the TerminalRecipe interface from shared/types/project.ts.
 * Uses passthrough() to preserve unknown fields for forward compatibility.
 */
export const TerminalRecipeSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    projectId: z.string().optional(),
    worktreeId: z.string().optional(),
    terminals: z.array(RecipeTerminalSchema),
    createdAt: z.number().finite(),
    showInEmptyState: z.boolean().optional(),
    lastUsedAt: z.number().finite().optional(),
    usageHistory: z.array(z.number().finite()).max(20).optional(),
    autoAssign: z.enum(["always", "never", "prompt"]).optional(),
    scope: z.enum(["inrepo"]).optional(),
  })
  .passthrough();

export type RecipeTerminalEntry = z.infer<typeof RecipeTerminalSchema>;
export type TerminalRecipeEntry = z.infer<typeof TerminalRecipeSchema>;

/**
 * Validates an array of terminal entries and returns only the valid ones.
 * Logs warnings for any filtered invalid entries.
 *
 * @param entries - The raw terminal entries array to validate
 * @param schema - The Zod schema to validate against
 * @param context - Context string for logging (e.g., "appState" or "projectState")
 * @returns Array of valid terminal entries
 */
export function filterValidTerminalEntries<T>(
  entries: unknown[] | null | undefined,
  schema: z.ZodType<T>,
  context: string
): T[] {
  // Guard against null/undefined entries array
  if (!Array.isArray(entries)) {
    if (entries !== undefined && entries !== null) {
      console.warn(`[${context}] Expected array but received ${typeof entries}`);
    }
    return [];
  }

  const validEntries: T[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const result = schema.safeParse(entry);

    if (result.success) {
      validEntries.push(result.data);
    } else {
      // Prefer non-empty string id, otherwise use index
      const entryId =
        entry &&
        typeof entry === "object" &&
        "id" in entry &&
        typeof entry.id === "string" &&
        entry.id.length > 0
          ? entry.id
          : `index-${i}`;

      const flattened = z.flattenError(result.error);
      // Log both field errors and form errors for better diagnostics
      const errorDetails =
        Object.keys(flattened.fieldErrors).length > 0
          ? flattened.fieldErrors
          : flattened.formErrors.length > 0
            ? { _errors: flattened.formErrors }
            : { type: typeof entry };

      console.warn(`[${context}] Filtering invalid terminal entry ${entryId}:`, errorDetails);
    }
  }

  return validEntries;
}

/**
 * Renderer `ActionContext` snapshot, captured synchronously at launch and
 * threaded through `terminal.spawn` so a `daintree-assistant` CLI session can
 * be pinned to the worktree/terminal focused when it was launched (#10647).
 * All fields are optional and validated structurally — `dispatchSource` is
 * accepted but always overwritten from the canonical source at dispatch time,
 * so a renderer cannot spoof it into a capability grant. Mirrors the
 * `ActionContext` interface in `shared/types/actions.ts`.
 */
export const ActionContextSchema = z.object({
  projectId: z.string().optional(),
  projectName: z.string().optional(),
  projectPath: z.string().optional(),
  activeWorktreeId: z.string().optional(),
  activeWorktreeName: z.string().optional(),
  activeWorktreePath: z.string().optional(),
  activeWorktreeBranch: z.string().optional(),
  activeWorktreeIsMain: z.boolean().optional(),
  focusedWorktreeId: z.string().optional(),
  focusedTerminalId: z.string().optional(),
  focusedTerminalKind: z.string().optional(),
  focusedTerminalType: z.string().optional(),
  focusedTerminalTitle: z.string().optional(),
  isSettingsOpen: z.boolean().optional(),
  // The active workspace is a project OR a scratch (#11076); without these an
  // action dispatched in a scratch sees no workspace at all. This schema is a
  // strict object, so an unlisted field is stripped rather than passed through.
  scratchId: z.string().optional(),
  scratchName: z.string().optional(),
  scratchPath: z.string().optional(),
  dispatchSource: z
    .enum(["user", "keybinding", "menu", "agent", "context-menu", "plugin"])
    .optional(),
});

export const TerminalSpawnOptionsSchema = z.object({
  id: z.string().optional(),
  kind: PanelKindSchema.optional(),
  launchAgentId: LaunchAgentIdSchema.optional(),
  projectId: z.string().optional(),
  cwd: z.string().optional(),
  shell: z.string().optional(),
  cols: z.number().int().positive().max(MAX_TERMINAL_GRID_DIMENSION),
  rows: z.number().int().positive().max(MAX_TERMINAL_GRID_DIMENSION),
  // `command` is interpolated raw into a shell startup script in
  // buildCommandLaunchShell — shell metacharacters are intentional (pipes,
  // redirects, env vars), but control characters are never legitimate and
  // become injection vectors via newlines or terminal escape sequences.
  command: z
    .string()
    .refine(
      (cmd) =>
        // eslint-disable-next-line no-control-regex
        !/[\x00-\x1F\x7F]/.test(cmd),
      {
        message: "command must not contain control characters",
      }
    )
    .optional(),
  env: z.record(z.string(), z.string()).optional(),
  title: z.string().optional(),
  titleMode: TitleModeSchema.optional(),
  restore: z.boolean().optional(),
  spawnBatchId: z.string().uuid().optional(),
  spawnBatchSize: z.number().int().min(2).max(MAX_TERMINALS_PER_RECIPE_ADMISSION_BATCH).optional(),
  isEphemeral: z.boolean().optional(),
  agentLaunchFlags: z.array(z.string()).optional(),
  agentModelId: z.string().optional(),
  // Session id already known at launch (#11782), recorded on the terminal
  // record at spawn. Must be listed here or zod strips it and the id never
  // reaches the pty-host.
  agentSessionId: z.string().optional(),
  worktreeId: z.string().optional(),
  agentPresetId: z.string().optional(),
  agentPresetColor: z.string().optional(),
  originalAgentPresetId: z.string().optional(),
  // Launch-time ActionContext snapshot, consumed only for the
  // `daintree-assistant` pinned-session path (#10647). Ignored for every other
  // agent. Optional so existing spawn callers are unaffected.
  actionContext: ActionContextSchema.optional(),
});

export const TerminalResizePayloadSchema = z.object({
  id: z.string().min(1),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

/**
 * Agent-session-history retention window in days. Fixed set of choices
 * (`0` = keep forever) mirroring the privacy log-retention picker — reject any
 * other value at the IPC boundary.
 */
export const AgentSessionRetentionDaysSchema = z.union([
  z.literal(7),
  z.literal(30),
  z.literal(90),
  z.literal(0),
]);

// ============================================================================
// Session bookmark payloads (#11288)
// ============================================================================

/** Bounded, trimmed bookmark label — the durable retrieval key. */
const BookmarkLabelSchema = z.string().trim().min(1).max(120);
/** Bounded id addressing a terminal, journaled session, panel, or preset. */
const BookmarkRefSchema = z.string().trim().min(1).max(256);

/**
 * Renderer-supplied pane-presentation metadata captured with a bookmark. Every
 * field is optional and additive; `.strict()` rejects unknown keys so no
 * terminal output, transcript, prompt, or environment value can be smuggled
 * into the durable record (the feature's privacy boundary).
 */
export const AgentSessionBookmarkMetadataInputSchema = z
  .object({
    sourcePanelId: BookmarkRefSchema.optional(),
    sourceLocation: z.enum(["grid", "dock"]).optional(),
    titleMode: TitleModeSchema.optional(),
    agentPresetId: BookmarkRefSchema.optional(),
    agentPresetColor: z.string().trim().min(1).max(64).optional(),
    originalPresetId: BookmarkRefSchema.optional(),
    isUsingFallback: z.boolean().optional(),
    fallbackChainIndex: z.number().int().nonnegative().optional(),
    isInputLocked: z.boolean().optional(),
  })
  .strict();

/** `prepareBookmark` — capture a live agent pane's native session and pin it. */
export const PrepareBookmarkPayloadSchema = z
  .object({
    terminalId: BookmarkRefSchema,
    label: BookmarkLabelSchema,
    metadata: AgentSessionBookmarkMetadataInputSchema.optional(),
  })
  .strict();

/** `promote`/`rename` — pin or relabel an existing journaled session by id. */
export const BookmarkMutatePayloadSchema = z
  .object({
    sessionId: BookmarkRefSchema,
    label: BookmarkLabelSchema,
  })
  .strict();

/** `delete` — remove exactly one bookmark by session id. */
export const BookmarkDeletePayloadSchema = z
  .object({
    sessionId: BookmarkRefSchema,
  })
  .strict();

/** `listBookmarks` — optional project scope. */
export const ListBookmarksPayloadSchema = z
  .object({
    projectId: BookmarkRefSchema.optional(),
  })
  .strict()
  .optional();

export const FileSearchPayloadSchema = z.object({
  cwd: z.string().min(1),
  query: z.string(),
  limit: z.number().int().positive().max(100).optional(),
});

export const SlashCommandListRequestSchema = z.object({
  // Accept plugin-contributed agent ids too (#10560), not just built-ins. The
  // handler's `SlashCommandService.list()` returns [] for any unrecognized id,
  // so plugin agents simply have no slash commands rather than erroring.
  agentId: LaunchAgentIdSchema,
  projectPath: z.string().optional(),
});

export const CopyTreeFormatSchema = z.enum(["xml", "json", "markdown", "tree", "ndjson", "sarif"]);

/**
 * The unrefined object base, mirroring `PanelContributionObjectSchema`. It exists
 * so {@link CopyTreeTestConfigOptionsSchema} can `.extend()` a plain object —
 * that is the one operation the refined schema below cannot serve.
 *
 * Extend from here ONLY when you also re-apply
 * {@link requireScopeForIgnoreFileBypass}; anything that just needs to validate
 * should use {@link CopyTreeOptionsSchema}. Notably the history codec unwraps
 * the refined schema on purpose, so a persisted record cannot rehydrate into a
 * request the generate handlers would have rejected — swapping it to this base
 * would silently drop that check.
 */
export const CopyTreeOptionsObjectSchema = z.object({
  format: CopyTreeFormatSchema.optional(),
  // `filter`/`includePaths` are one selection set and are unioned in
  // CopyTreeService. Non-empty at both levels, like `scopePaths` below: an
  // empty list or a blank entry leaves the selection empty, which the SDK
  // reads as "no filter" — i.e. the whole worktree. Rejecting them here keeps
  // a malformed narrow request from widening into a full-repo copy.
  filter: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
  exclude: z.union([z.string(), z.array(z.string())]).optional(),
  always: z.array(z.string()).optional(),
  includePaths: z.array(z.string().min(1)).min(1).optional(),
  // Non-empty at both levels: an empty list or a blank entry would resolve to
  // the worktree root, turning a folder copy into a whole-worktree copy that
  // no caller asked for. Absent still means "no scoping".
  scopePaths: z.array(z.string().min(1)).min(1).optional(),
  scopeIgnoresIgnoreFiles: z.boolean().optional(),
  modified: z.boolean().optional(),
  changed: z.string().optional(),
  maxFileSize: z.number().int().positive().optional(),
  maxTotalSize: z.number().int().positive().optional(),
  maxFileCount: z.number().int().positive().optional(),
  withLineNumbers: z.boolean().optional(),
  charLimit: z.number().int().positive().optional(),
  sort: z.enum(["path", "size", "modified", "name", "extension", "depth"]).optional(),
});

/**
 * `scopeIgnoresIgnoreFiles` is scope-bound: the SDK only consults it while
 * walking `scope` entries, so setting it alone does exactly nothing. Silently
 * accepting that is the shape of the bug #11750 was filed about — a caller
 * believes it asked for the ignored files back, gets a short bundle, and is
 * told nothing. Rejecting names the missing field instead, in one round trip.
 *
 * Shared by the ordinary and test-config variants so the rule cannot drift
 * between them.
 */
function requireScopeForIgnoreFileBypass(
  options: { scopeIgnoresIgnoreFiles?: boolean; scopePaths?: string[] },
  ctx: z.RefinementCtx
): void {
  if (options.scopeIgnoresIgnoreFiles === true && !options.scopePaths?.length) {
    ctx.addIssue({
      code: "custom",
      path: ["scopeIgnoresIgnoreFiles"],
      message: "scopeIgnoresIgnoreFiles requires scopePaths",
    });
  }
}

export const CopyTreeOptionsSchema = CopyTreeOptionsObjectSchema.superRefine(
  requireScopeForIgnoreFileBypass
).optional();

/**
 * Which surface asked for a copy-tree run (#11732). Left `.optional()` rather
 * than given a `.default()` so the schema keeps describing omission honestly —
 * the main handler is what maps an absent source to `unknown`, and it is the
 * only writer of the history.
 */
export const CopyTreeRunSourceSchema = z.enum(COPY_TREE_RUN_SOURCES);

/**
 * Caller-supplied display label for a run (#11734).
 *
 * Unconstrained beyond being a string, deliberately. Blank is valid input and
 * resolves as absent, and `resolveCopyTreeRunName` is the single trim/truncate
 * seam for every consumer — a `.max()` here would reject an oversized cosmetic
 * label by failing the whole (expensive) generation instead of shortening it.
 */
const CopyTreeRunNameSchema = z.string().optional();

export const CopyTreeGeneratePayloadSchema = z.object({
  worktreeId: z.string().min(1),
  options: CopyTreeOptionsSchema,
  // Response shape, not a generation setting — see CopyTreeGeneratePayload.
  // Note there is deliberately no caller-supplied output path here or in
  // CopyTreeOptionsSchema: the destination is chosen by the main process, so a
  // tool call can never turn into an arbitrary file write.
  includeContent: z.boolean().optional(),
  name: CopyTreeRunNameSchema,
  source: CopyTreeRunSourceSchema.optional(),
});

export const CopyTreeGenerateAndCopyFilePayloadSchema = z.object({
  worktreeId: z.string().min(1),
  options: CopyTreeOptionsSchema,
  name: CopyTreeRunNameSchema,
  source: CopyTreeRunSourceSchema.optional(),
});

export const CopyTreeInjectPayloadSchema = z.object({
  terminalId: z.string().min(1),
  worktreeId: z.string().min(1),
  options: CopyTreeOptionsSchema,
  injectionId: z.string().min(1).optional(),
  name: CopyTreeRunNameSchema,
  source: CopyTreeRunSourceSchema.optional(),
});

export const CopyTreeCancelPayloadSchema = z.object({
  injectionId: z.string().min(1).optional(),
});

// Test-config dry runs send `null` for fields the user explicitly cleared in the
// unsaved settings form (Electron's structured clone drops `undefined` keys, so
// `null` is the only sentinel that survives IPC). `null` blocks the saved-settings
// back-fill in mergeCopyTreeOptions; absent/undefined still falls back.
export const CopyTreeTestConfigOptionsSchema = CopyTreeOptionsObjectSchema.extend({
  exclude: z.union([z.string(), z.array(z.string())]).nullish(),
  always: z.array(z.string()).nullish(),
  maxFileSize: z.number().int().positive().nullish(),
  maxTotalSize: z.number().int().positive().nullish(),
  charLimit: z.number().int().positive().nullish(),
  sort: z.enum(["path", "size", "modified", "name", "extension", "depth"]).nullish(),
})
  .superRefine(requireScopeForIgnoreFileBypass)
  .optional();

export const CopyTreeTestConfigPayloadSchema = z.object({
  worktreeId: z.string().min(1),
  options: CopyTreeTestConfigOptionsSchema,
});

export const CopyTreeProgressSchema = z.object({
  stage: z.string(),
  progress: z.number().min(0).max(1),
  message: z.string(),
  traceId: z.string().optional(),
});

export const CopyTreeGetFileTreePayloadSchema = z.object({
  worktreeId: z.string().min(1),
  dirPath: z.string().optional(),
  /**
   * Return the entries CopyTree would leave out, flagged `excluded`, instead of
   * omitting them. Off by default so the listing keeps its no-leak shape.
   */
  includeExcluded: z.boolean().optional(),
});

// Both strings are capped: they cross the boundary as untrusted input and end
// up in path joins, which should never see a megabyte-long value.
//
// `worktreeId` is optional but still `.min(1)` when present: absent selects the
// sender's own workspace root (#11482), while an empty string is a malformed
// worktree request and must fail rather than silently widen to that root.
export const FileBrowserListDirectoryPayloadSchema = z.object({
  worktreeId: z.string().min(1).max(4096).optional(),
  dirPath: z.string().max(4096).optional(),
});

// Batch-capped: one call validates the directory candidates of a single
// hovered terminal line, which is a handful of tokens, never hundreds.
export const FileBrowserStatPathsPayloadSchema = z.object({
  worktreeId: z.string().min(1).max(4096).optional(),
  paths: z.array(z.string().min(1).max(4096)).max(32),
});

// Capped at the widest tree the file browser polls in one sample: its root plus
// the directories it has expanded. A caller with more expanded than this sends
// the closest ones to the root — the cap is what keeps a restored 500-directory
// panel from turning one poll into 500 stats.
export const FileWatchFingerprintPayloadSchema = z.object({
  rootPath: z
    .string()
    .min(1)
    .max(4096)
    // eslint-disable-next-line no-control-regex
    .regex(/^[^\x00]*$/, "Null bytes not allowed"),
  paths: z
    .array(
      z
        .string()
        .min(1)
        .max(4096)
        // eslint-disable-next-line no-control-regex
        .regex(/^[^\x00]*$/, "Null bytes not allowed")
    )
    .max(32),
});

export const FileReadPayloadSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(4096)
    // eslint-disable-next-line no-control-regex
    .regex(/^[^\x00]*$/, "Null bytes not allowed"),
  rootPath: z
    .string()
    .min(1)
    .max(4096)
    // eslint-disable-next-line no-control-regex
    .regex(/^[^\x00]*$/, "Null bytes not allowed"),
  // Opt-in: mint a sandboxed-iframe preview URL for HTML files (#11191).
  htmlPreview: z.boolean().optional(),
});

export const DiffMediaReadFileVersionsPayloadSchema = z.object({
  cwd: z
    .string()
    .min(1)
    .max(4096)
    // eslint-disable-next-line no-control-regex
    .regex(/^[^\x00]*$/, "Null bytes not allowed"),
  filePath: z
    .string()
    .min(1)
    .max(4096)
    // eslint-disable-next-line no-control-regex
    .regex(/^[^\x00]*$/, "Null bytes not allowed"),
});

export const VoiceInputCorrectPayloadSchema = z.object({
  rawText: z.string(),
  recentContext: z.array(z.string()).optional(),
});

export const SystemOpenExternalPayloadSchema = z.object({
  url: z.string().url(),
});

export const SystemOpenPathPayloadSchema = z.object({
  path: z.string().min(1).max(4096),
});

// User-initiated reveal of a path that lives OUTSIDE project roots (the only
// caller is the OUTSIDE_ROOT recovery action on a file-link toast). Null bytes
// are rejected at the schema boundary (lesson #6263); roots containment is
// intentionally NOT applied here — that's the whole point — so the handler
// must keep the executable deny-list and realpath canonicalization itself.
export const SystemShowItemInFolderUnconfinedPayloadSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(4096)
    // eslint-disable-next-line no-control-regex
    .regex(/^[^\x00]*$/, "Null bytes not allowed"),
});

export const SystemOpenInEditorPayloadSchema = z.object({
  path: z.string().min(1).max(4096),
  line: z.number().int().positive().optional(),
  col: z.number().int().positive().optional(),
  projectId: z.string().optional(),
});

const MAX_REPLAY_LINES = 100000;
const MIN_REPLAY_LINES = 1;

export const TerminalReplayHistoryPayloadSchema = z.object({
  terminalId: z.string().min(1, "Terminal ID is required").max(100),
  maxLines: z
    .number()
    .int("maxLines must be an integer")
    .transform((val) => Math.max(MIN_REPLAY_LINES, Math.min(val, MAX_REPLAY_LINES)))
    .optional()
    .default(100),
});

const MIN_TERMINAL_DIMENSION = 10;
const MAX_TERMINAL_DIMENSION = 500;

export const DevPreviewStartPayloadSchema = z.object({
  panelId: z.string().min(1, "Panel ID is required").max(100),
  cwd: z.string().min(1, "Working directory is required").max(4096),
  cols: z
    .number()
    .int("cols must be an integer")
    .transform((val) => Math.max(MIN_TERMINAL_DIMENSION, Math.min(val, MAX_TERMINAL_DIMENSION))),
  rows: z
    .number()
    .int("rows must be an integer")
    .transform((val) => Math.max(MIN_TERMINAL_DIMENSION, Math.min(val, MAX_TERMINAL_DIMENSION))),
  devCommand: z
    .string()
    .max(1000)
    .refine(
      (cmd) =>
        // eslint-disable-next-line no-control-regex
        !/[\x00-\x1F\x7F]/.test(cmd),
      {
        message: "devCommand must not contain control characters",
      }
    )
    .optional(),
});

export const WorktreeSetActivePayloadSchema = z.object({
  worktreeId: z.string().min(1),
});

export const WorktreeCreatePayloadSchema = z.object({
  rootPath: z
    .string()
    .min(1)
    .max(4096)
    // eslint-disable-next-line no-control-regex
    .regex(/^[^\x00]*$/, "Null bytes not allowed"),
  // Mirrors CreateWorktreeOptions (shared/types/git.ts). All fields are declared
  // so none are silently stripped before reaching WorkspaceService.createWorktree
  // — the PR-dropdown, remote-mode, and branch-reuse paths all depend on the
  // optional fields surviving parse.
  options: z.object({
    baseBranch: z.string().min(1),
    newBranch: z.string().min(1),
    path: z
      .string()
      .min(1)
      .max(4096)
      // eslint-disable-next-line no-control-regex
      .regex(/^[^\x00]*$/, "Null bytes not allowed"),
    fromRemote: z.boolean().optional(),
    useExistingBranch: z.boolean().optional(),
    provisionResource: z.boolean().optional(),
    worktreeMode: z.string().optional(),
    sourcePrNumber: z.number().optional(),
    sourcePrTitle: z.string().optional(),
    sourcePrUrl: z.string().optional(),
    sourcePrState: z.enum(["open", "closed", "merged"]).optional(),
    sourcePrLinkedIssueNumber: z.number().optional(),
    // Omitted until #12138 follow-up: the comment above promised every field of
    // CreateWorktreeOptions was declared, but this one was not — so a caller
    // asking for `all` or `none` had it silently stripped here and the host
    // fell back to `inherit`. A worktree of a submodule repo is born
    // unbuildable when that request is dropped.
    submoduleInit: z.enum(["inherit", "all", "none"]).optional(),
    // How a branch-name collision is resolved. Declared here so the policy
    // reaches WorkspaceService, which owns collision handling atomically — a
    // renderer-side check cannot, because it reserves nothing.
    collisionPolicy: z.enum(["suffix", "error"]).optional(),
  }),
});

// ============================================================================
// Tab Group Validation Schemas
// ============================================================================

/**
 * Schema for TabGroupLocation - grid or dock only (excludes trash).
 */
export const TabGroupLocationSchema = z.enum(["grid", "dock"]);

/**
 * Schema for TabGroup input validation.
 * Uses passthrough() to preserve unknown fields for forward compatibility.
 */
export const TabGroupInputSchema = z
  .object({
    id: z.string().min(1),
    location: TabGroupLocationSchema,
    worktreeId: z.string().optional(),
    activeTabId: z.string().optional(),
    panelIds: z.array(z.string()),
  })
  .passthrough();

export type TabGroupInput = z.infer<typeof TabGroupInputSchema>;

/**
 * Sanitizes an array of tab groups to ensure valid state before persistence.
 * Applies deterministic repairs and filters invalid groups.
 *
 * Sanitization rules (aligned with hydrateTabGroups):
 * 1. Validates id is non-empty string
 * 2. Validates location is "grid" or "dock" (coerces invalid to "grid")
 * 3. Filters panelIds to only strings, removes empty strings
 * 4. Deduplicates panelIds (preserves first occurrence)
 * 5. Drops groups with <= 1 panel (single-panel groups are virtual)
 * 6. Ensures activeTabId is in panelIds (fallback to first if invalid)
 *
 * @param tabGroups - Raw tab groups array to sanitize
 * @param context - Context string for logging (e.g., projectId)
 * @returns Array of sanitized valid tab groups
 */
export function sanitizeTabGroups(
  tabGroups: unknown[] | null | undefined,
  context: string
): TabGroupInput[] {
  if (!Array.isArray(tabGroups)) {
    if (tabGroups !== undefined && tabGroups !== null) {
      console.warn(`[TabGroups:${context}] Expected array but received ${typeof tabGroups}`);
    }
    return [];
  }

  const validGroups: TabGroupInput[] = [];
  let droppedCount = 0;

  for (let i = 0; i < tabGroups.length; i++) {
    const group = tabGroups[i];
    const result = TabGroupInputSchema.safeParse(group);

    if (!result.success) {
      const groupId =
        group &&
        typeof group === "object" &&
        "id" in group &&
        typeof group.id === "string" &&
        group.id.length > 0
          ? group.id
          : `index-${i}`;

      const flattened = z.flattenError(result.error);
      const errorDetails =
        Object.keys(flattened.fieldErrors).length > 0
          ? flattened.fieldErrors
          : flattened.formErrors.length > 0
            ? { _errors: flattened.formErrors }
            : { type: typeof group };

      console.warn(`[TabGroups:${context}] Dropping invalid group ${groupId}:`, errorDetails);
      droppedCount++;
      continue;
    }

    const validatedGroup = result.data;

    // Filter panelIds to only valid strings (non-empty)
    const stringPanelIds = validatedGroup.panelIds.filter(
      (id) => typeof id === "string" && id.length > 0
    );

    // Deduplicate panelIds (preserve first occurrence)
    const uniquePanelIds = Array.from(new Set(stringPanelIds));

    // Drop groups with <= 1 panel (single-panel groups are virtual/unnecessary)
    if (uniquePanelIds.length <= 1) {
      console.log(
        `[TabGroups:${context}] Dropping group ${validatedGroup.id} with ${uniquePanelIds.length} valid unique panel(s)`
      );
      droppedCount++;
      continue;
    }

    // Ensure activeTabId is in panelIds, fallback to first if invalid or missing
    const activeTabId =
      validatedGroup.activeTabId && uniquePanelIds.includes(validatedGroup.activeTabId)
        ? validatedGroup.activeTabId
        : uniquePanelIds[0];

    validGroups.push({
      ...validatedGroup,
      panelIds: uniquePanelIds,
      activeTabId,
    });
  }

  if (droppedCount > 0) {
    console.log(
      `[TabGroups:${context}] Sanitization summary: ${validGroups.length} valid, ${droppedCount} dropped`
    );
  }

  return validGroups;
}

export type TerminalSpawnOptions = z.infer<typeof TerminalSpawnOptionsSchema>;
export type TerminalResizePayload = z.infer<typeof TerminalResizePayloadSchema>;
export type FileSearchPayload = z.infer<typeof FileSearchPayloadSchema>;
export type CopyTreeOptions = z.infer<typeof CopyTreeOptionsSchema>;
export type CopyTreeGeneratePayload = z.infer<typeof CopyTreeGeneratePayloadSchema>;
export type CopyTreeGenerateAndCopyFilePayload = z.infer<
  typeof CopyTreeGenerateAndCopyFilePayloadSchema
>;
export type CopyTreeInjectPayload = z.infer<typeof CopyTreeInjectPayloadSchema>;
export type CopyTreeCancelPayload = z.infer<typeof CopyTreeCancelPayloadSchema>;
export type CopyTreeProgress = z.infer<typeof CopyTreeProgressSchema>;
export type CopyTreeGetFileTreePayload = z.infer<typeof CopyTreeGetFileTreePayloadSchema>;
export type FileReadPayload = z.infer<typeof FileReadPayloadSchema>;
export type VoiceInputCorrectPayload = z.infer<typeof VoiceInputCorrectPayloadSchema>;
export type SystemOpenExternalPayload = z.infer<typeof SystemOpenExternalPayloadSchema>;
export type SystemOpenPathPayload = z.infer<typeof SystemOpenPathPayloadSchema>;
export type SystemShowItemInFolderUnconfinedPayload = z.infer<
  typeof SystemShowItemInFolderUnconfinedPayloadSchema
>;
export type SystemOpenInEditorPayload = z.infer<typeof SystemOpenInEditorPayloadSchema>;
export type TerminalReplayHistoryPayload = z.infer<typeof TerminalReplayHistoryPayloadSchema>;
export type DevPreviewStartPayload = z.infer<typeof DevPreviewStartPayloadSchema>;
export type WorktreeSetActivePayload = z.infer<typeof WorktreeSetActivePayloadSchema>;
export type WorktreeCreatePayload = z.infer<typeof WorktreeCreatePayloadSchema>;

// ============================================================================
// Assistant Native-Host Protocol Schemas (#10649)
// ============================================================================
//
// Validation for the typed boundary between a future `daintree-assistant`
// runtime hosted as a utility process and Daintree's main/renderer surfaces.
// The main process parses every inbound host message before forwarding to the
// pinned renderer — a malformed or unknown-`type` message is rejected, never
// guessed at. Vocabularies mirror the audit-aligned types in
// `shared/types/ipc/mcpServer.ts` so the native timeline and the audit log
// cannot drift. See `shared/types/ipc/assistantHost.ts` for the source types.

const McpAuditResultSchema = z.enum([
  "success",
  "error",
  "confirmation-pending",
  "unauthorized",
  "dedup",
  "collision",
  "rate_limited",
]);

const McpAuditSeveritySchema = z.enum(["info", "notice", "warning", "error", "critical"]);

const McpConfirmationDecisionSchema = z.enum(["approved", "rejected", "timeout"]);

const TurnOutcomeClassSchema = z.enum([
  "answered",
  "hedged",
  "refused",
  "docs-empty",
  "tier-rejected",
  "mcp-not-ready",
  "agent-stuck",
  "tool-error",
  "reasoning-loop",
  "hibernate-resume-stale",
  "cancelled",
  "unknown",
]);

const AssistantTurnRoleSchema = z.enum(["user", "assistant"]);

/** Lifecycle of one announced tool call. "waiting" means blocked on the USER. */
const AssistantToolStateSchema = z.enum([
  "queued",
  "active",
  "waiting",
  "done",
  "failed",
  "cancelled",
  "not-run",
]);

const AssistantHostShutdownReasonSchema = z.enum(["hibernate", "revoke", "error", "exit"]);

// Compile-time parity guard. These Zod enums duplicate the audit-aligned string
// unions from `mcpServer.ts` (Zod has no way to derive an enum from a bare TS
// union). If a member is added or removed there without a matching change here,
// one of these assignments fails to typecheck — turning silent runtime drift
// (valid events rejected, or invalid ones accepted) into a build error.
type ExactlyEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type AssertTrue<T extends true> = T;
/**
 * Exported (so it counts as used under `noUnusedLocals`) purely to host the
 * parity assertions — each tuple member fails to compile if the matching Zod
 * enum drifts from its `mcpServer.ts` union. Never imported at runtime.
 */
export type AssistantHostVocabularyParity = [
  AssertTrue<ExactlyEqual<z.infer<typeof McpAuditResultSchema>, McpAuditResult>>,
  AssertTrue<ExactlyEqual<z.infer<typeof McpAuditSeveritySchema>, McpAuditSeverity>>,
  AssertTrue<ExactlyEqual<z.infer<typeof McpConfirmationDecisionSchema>, McpConfirmationDecision>>,
  AssertTrue<ExactlyEqual<z.infer<typeof TurnOutcomeClassSchema>, TurnOutcomeClass>>,
  AssertTrue<ExactlyEqual<z.infer<typeof AssistantToolStateSchema>, AssistantToolState>>,
];

/**
 * Identifier string carrying at least one non-whitespace character. A blank or
 * whitespace-only id passes a bare `.min(1)` but fails delivery-pinning
 * downstream, so it is rejected at the parse boundary instead.
 */
const IdString = z.string().refine((s) => s.trim().length > 0, { message: "must not be blank" });

/**
 * Wall-clock timestamp / duration in milliseconds. Finite and non-negative so
 * downstream ordering and duration math can never be poisoned by `NaN`,
 * `Infinity`, or a negative value slipping through the contract.
 */
const Timestamp = z.number().finite().nonnegative();

/**
 * A string the engine does not bound, clipped instead of rejected.
 *
 * The difference matters on any surface a user ACTS from. A `.max()` makes the whole
 * frame invalid, and a discriminated union has no way to drop one bad row — so a
 * single over-long field turns a list into an empty list, which reads as "there is
 * nothing here" rather than "something went wrong". Clipping keeps every other row.
 */
const clipped = (max: number) =>
  z.string().transform((v) => (v.length > max ? v.slice(0, max) : v));

/**
 * Non-secret descriptor handed to the host at fork. The bearer token and MCP
 * URL are intentionally absent — they travel via env vars — so the schema
 * rejects any descriptor that smuggles a `token`/`mcpUrl` field. `windowId` is
 * `.nonnegative()` to match the `>= 0` invariant `HelpSessionService` enforces.
 */
export const AssistantHostSessionDescriptorSchema = z
  .object({
    sessionId: IdString,
    windowId: z.number().int().nonnegative(),
    projectId: IdString,
    cwd: IdString,
    tier: IdString,
    protocolVersion: z.number().int().positive(),
    resumeSessionId: IdString.optional(),
  })
  .strict();

/**
 * Every v3 event carries a monotonic `seq`. It is validated as a positive integer
 * because the engine counts from 1, which lets a consumer treat 0 as "nothing seen
 * yet" without ambiguity. Tracking it is how Daintree detects a lost frame: v2 shed
 * frames silently under backpressure with no way to notice, which is unusable once
 * the transcript is the product.
 */
const Seq = z.number().int().positive();

/** Fields shared by every engine event. */
const hostEventBase = { sessionId: IdString, seq: Seq };

/**
 * Scheduled-timer rows, shared by `operations:snapshot` and `timers:snapshot`.
 *
 * ONE schema for both on purpose. The engine encodes both arrays through the same
 * builder, and two schemas here would be two chances to accept a row on one surface
 * and reject the identical row on the other — which presents to a user as a timer
 * manager that is empty while the deck shows three timers.
 *
 * Bounded at every level: the list is drawn from a project store that grows with use,
 * and an unbounded array here becomes an unbounded render.
 */
const AssistantTimerRowsSchema = z
  .array(
    z.object({
      id: IdString,
      // CLIPPED, not bounded. Every string on this row is written by the engine with
      // no length limit of its own — the model chooses a timer's title, and a worktree
      // id is an absolute path, which is 4096 bytes on Linux. A `.max()` here would
      // make one long title reject the WHOLE frame, and this is a control surface: the
      // failure would present as "you have no timers" while a timer counts down to
      // spawning an agent. A clipped label is a bad label; an empty list is a lie.
      label: clipped(500),
      // Non-negative is wrong for a fire time: the engine accepts any RFC3339 `fireAt`,
      // so a pre-1970 date is a real (if silly) row, and rejecting the frame over it
      // would again hide every OTHER timer. Ordering math tolerates a negative.
      dueAt: z.number().int().finite(),
      createdAt: z.number().int().finite(),
      // The one field that must NOT be lenient: the UI branches on it, and an unknown
      // kind should be caught rather than rendered as something it is not.
      payloadKind: z.enum(["reminder", "message", "tool_call", "legacy"]),
      toolName: clipped(256),
      runCount: z.number().int().min(0),
      repeatEveryMs: z.number().int().min(0),
      repeatMaxRuns: z.number().int().min(0),
      repeatUntilAt: z.number().int().min(0),
      targetWorktreeId: clipped(4096),
      targetTerminalId: clipped(512),
      liveGrants: z.number().int().min(0),
      grantsUnknown: z.boolean(),
    })
  )
  // Generous rather than tight: the engine caps nothing, and the transport already
  // bounds the frame, so this exists to stop an absurd render — not to be the number
  // a real project trips over and loses its whole timer list to.
  .max(2000);

export const AssistantHostEventSchema = z.discriminatedUnion("type", [
  z.object({
    ...hostEventBase,
    type: z.literal("host:ready"),
    protocolVersion: z.number().int().positive(),
    resumedSessionId: IdString.optional(),
    version: z.string().optional(),
    autoApprove: z.boolean(),
    // Engine-resolved masthead facts. Bounded rather than bare `z.string()`: they are
    // rendered into the panel chrome, and a pathological value should be refused at
    // the boundary instead of laid out.
    tier: z.string().max(64).optional(),
    tierGloss: z.string().max(200).optional(),
    backend: z.string().max(2048).optional(),
    routing: z.string().max(500).optional(),
    logFile: z.string().max(4096).optional(),
    controlSocket: z.string().max(4096).optional(),
    stateDir: z.string().max(4096).optional(),
    commands: z
      .array(
        z.object({
          name: z.string().max(64),
          syntax: z.string().max(120),
          palette: z.string().max(200),
        })
      )
      .max(200)
      .optional(),
  }),
  z.object({
    ...hostEventBase,
    type: z.literal("turn:start"),
    turnId: IdString,
    role: AssistantTurnRoleSchema,
    startedAt: Timestamp,
    wake: z.boolean().optional(),
  }),
  z.object({
    ...hostEventBase,
    type: z.literal("turn:token"),
    turnId: IdString,
    chunk: z.string(),
  }),
  z.object({
    ...hostEventBase,
    type: z.literal("turn:end"),
    turnId: IdString,
    endedAt: Timestamp,
    outcome: TurnOutcomeClassSchema.optional(),
    // Authoritative final text. Absent (not "") when the turn produced none, so a
    // tool-only round stays distinguishable from an empty answer.
    content: z.string().optional(),
  }),
  z.object({
    ...hostEventBase,
    type: z.literal("turn:phase"),
    wake: z.boolean().optional(),
    turnId: IdString.optional(),
    phase: z.string(),
  }),
  z.object({
    ...hostEventBase,
    type: z.literal("turn:reasoning"),
    turnId: IdString,
    text: z.string(),
  }),
  z.object({
    ...hostEventBase,
    type: z.literal("interject:retracted"),
    retracted: z.boolean(),
    // Bounded to the composer's own limit: it is a prompt coming back.
    text: z.string().max(100_000).optional(),
  }),
  z.object({
    ...hostEventBase,
    type: z.literal("turn:interjection"),
    turnId: IdString.optional(),
    text: z.string(),
  }),
  z.object({
    ...hostEventBase,
    type: z.literal("tool:batch"),
    turnId: IdString.optional(),
    calls: z.array(
      z.object({
        toolCallId: IdString,
        toolId: IdString,
        argsSummary: z.string(),
        danger: z.boolean(),
        // Bounded like every other engine-authored string that reaches the renderer.
        verb: z.string().max(64).optional(),
        activeVerb: z.string().max(64).optional(),
        target: z.string().max(256).optional(),
      })
    ),
  }),
  z.object({
    ...hostEventBase,
    type: z.literal("tool:state"),
    toolCallId: IdString,
    state: AssistantToolStateSchema,
    turnId: IdString.optional(),
  }),
  z.object({
    ...hostEventBase,
    type: z.literal("tool:progress"),
    toolCallId: IdString,
    message: z.string(),
    turnId: IdString.optional(),
  }),
  z.object({
    ...hostEventBase,
    type: z.literal("tool:started"),
    toolCallId: IdString,
    toolId: IdString,
    argsSummary: z.string(),
    startedAt: Timestamp,
    turnId: IdString.optional(),
    danger: z.boolean(),
  }),
  z.object({
    ...hostEventBase,
    type: z.literal("tool:settled"),
    toolCallId: IdString,
    toolId: IdString,
    durationMs: Timestamp,
    result: McpAuditResultSchema,
    severity: McpAuditSeveritySchema,
    errorCode: z.string().optional(),
    turnId: IdString.optional(),
    asyncId: IdString.optional(),
    asyncTitle: z.string().max(500).optional(),
    summary: z.string().max(2000).optional(),
    errorMessage: z.string().max(2000).optional(),
  }),
  z.object({
    ...hostEventBase,
    type: z.literal("usage"),
    turnId: IdString.optional(),
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    // Optional, never zero-filled: absent means the provider reported nothing, and a
    // meter that shows 0% cache-hit is a claim rather than a gap.
    cachedTokens: z.number().int().nonnegative().optional(),
    cacheHitRatio: z.number().finite().optional(),
    contextTokens: z.number().int().nonnegative(),
    contextThreshold: z.number().int().nonnegative(),
    contextWindow: z.number().int().nonnegative(),
  }),
  z.object({
    ...hostEventBase,
    type: z.literal("cost"),
    turnId: IdString.optional(),
    total: z.number().finite().nonnegative(),
    // `false` means `total` is a FLOOR. Render "≥ $x"; never present it as a receipt.
    complete: z.boolean(),
  }),
  z.object({
    ...hostEventBase,
    type: z.literal("notice"),
    level: z.enum(["info", "warning"]),
    message: z.string(),
    turnId: IdString.optional(),
  }),
  z.object({
    ...hostEventBase,
    type: z.literal("model:rate-limited"),
    turnId: IdString.optional(),
  }),
  z.object({
    ...hostEventBase,
    type: z.literal("operations:snapshot"),
    // Bounded at every level: the deck is drawn from a project store that grows with
    // use, and an unbounded array here becomes an unbounded render.
    inbox: z
      .array(
        z.object({
          id: IdString,
          severity: z.string().max(32),
          source: z.string().max(64),
          summary: z.string().max(2000),
          at: Timestamp,
        })
      )
      .max(200),
    workflows: z
      .array(
        z.object({
          id: IdString,
          goal: z.string().max(2000),
          status: z.string().max(64),
          progress: z.string().max(200),
          next: z.string().max(200),
          blocked: z.boolean(),
        })
      )
      .max(200),
    agents: z
      .array(
        z.object({
          id: IdString,
          title: z.string().max(500),
          goal: z.string().max(2000),
          badge: z.string().max(64),
          agentState: z.string().max(64),
          preview: z.string().max(4000),
          startedAt: Timestamp,
          needsAttention: z.boolean(),
        })
      )
      .max(200),
    async: z
      .array(
        z.object({
          id: IdString,
          title: z.string().max(500),
          tool: z.string().max(128),
          startedAt: Timestamp,
        })
      )
      .max(200),
    timers: AssistantTimerRowsSchema,
    audit: z
      .array(
        z.object({
          tool: z.string().max(128),
          outcome: z.string().max(32),
          durationMs: z.number().int().min(0),
          at: Timestamp,
        })
      )
      .max(200),
  }),
  z.object({
    ...hostEventBase,
    type: z.literal("timers:snapshot"),
    timers: AssistantTimerRowsSchema,
    outcomes: z
      .array(
        z.object({
          eventId: IdString,
          timerId: IdString,
          severity: clipped(32),
          // Clipped, not bounded, for the same reason as the row's strings: the
          // summary can carry a tool's own error output, which the engine does not
          // truncate, and rejecting the frame would cost every OTHER outcome.
          title: clipped(500),
          summary: clipped(4000),
          createdAt: z.number().int().finite(),
          updatedAt: z.number().int().finite(),
          count: z.number().int().min(0),
        })
      )
      .max(500),
    takenAt: Timestamp,
    readFailed: z.boolean(),
  }),
  z.object({
    ...hostEventBase,
    type: z.literal("timer:fired"),
    timerId: IdString,
    firedAt: Timestamp,
  }),
  z.object({
    ...hostEventBase,
    type: z.literal("timer:cancelled"),
    timerId: IdString,
    cancelled: z.boolean(),
    alreadyInactive: z.boolean(),
    priorStatus: z.string().max(32),
    revokedGrants: z.number().int().min(0).max(100_000),
    grantRevokeFailed: z.boolean(),
    error: z.string().max(2000),
  }),
  z.object({
    ...hostEventBase,
    type: z.literal("mcp:status"),
    connected: z.boolean(),
    toolCount: z.number().int().min(0).max(10_000).optional(),
    error: z.string().max(2000).optional(),
  }),
  z.object({
    ...hostEventBase,
    type: z.literal("command:result"),
    command: z.string().max(2000),
    text: z.string().max(200_000),
    quit: z.boolean().optional(),
    unknown: z.boolean().optional(),
    // Whether `/clear` ACTUALLY cleared. Optional here and only here because an engine
    // older than this contract omits it; the panel treats absent as false, so a
    // destructive reset never happens on an assumption. See the store's handling.
    conversationCleared: z.boolean().optional(),
    turnId: IdString.optional(),
  }),
  z.object({
    ...hostEventBase,
    type: z.literal("question:requested"),
    questionId: IdString,
    toolCallId: IdString.optional(),
    turnId: IdString.optional(),
    question: z.string().max(4000),
    // 2–26 matches the engine's own bound: labels are single letters A–Z.
    options: z
      .array(z.object({ label: z.string().max(4), text: z.string().max(500) }))
      .min(2)
      .max(26),
    default: z.number().int().min(0).max(25),
    requestedAt: Timestamp,
  }),
  z.object({
    ...hostEventBase,
    type: z.literal("question:answered"),
    questionId: IdString,
    // -1 means dismissed. `cancelled` says the same thing explicitly rather than
    // leaving it encoded in a sentinel index, so "the user closed the sheet" and
    // "the user picked option -1" can never be confused for one another.
    choiceIndex: z.number().int().min(-1).max(25),
    cancelled: z.boolean(),
    answeredAt: Timestamp,
    label: z.string().max(4).optional(),
    text: z.string().max(500).optional(),
  }),
  z.object({
    ...hostEventBase,
    type: z.literal("approval:requested"),
    approvalId: IdString,
    toolId: IdString,
    summary: z.string(),
    requestedAt: Timestamp,
    turnId: IdString.optional(),
    riskClass: z.string().optional(),
    consequence: z.string().optional(),
    argsSummary: z.string().optional(),
    // REQUIRED, never defaulted. The safety layer's own verdict that this action is
    // irreversible; a missing field would silently become "false" and let a click
    // approve a git/system operation that must be typed.
    needsTypedConfirm: z.boolean(),
    rememberable: z.boolean().optional(),
    toolKey: z.string().max(200).optional(),
  }),
  z.object({
    ...hostEventBase,
    type: z.literal("approval:decided"),
    approvalId: IdString,
    decision: McpConfirmationDecisionSchema,
    decidedAt: Timestamp,
  }),
  z.object({
    ...hostEventBase,
    type: z.literal("host:error"),
    code: IdString,
    message: z.string(),
  }),
  z.object({
    ...hostEventBase,
    type: z.literal("host:shutdown"),
    reason: AssistantHostShutdownReasonSchema,
    resumeSessionId: IdString.optional(),
  }),
]);

export const AssistantHostCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("prompt"),
    sessionId: IdString,
    text: z.string(),
    worktree: z
      .object({ id: IdString, path: z.string().min(1), branch: z.string() })
      .nullable()
      .optional(),
  }),
  z.object({
    type: z.literal("approval:decide"),
    sessionId: IdString,
    approvalId: IdString,
    decision: McpConfirmationDecisionSchema,
  }),
  z.object({
    type: z.literal("command"),
    sessionId: IdString,
    line: z.string().min(1).max(2000),
  }),
  z.object({
    type: z.literal("operations"),
    sessionId: IdString,
  }),
  z.object({
    type: z.literal("timers"),
    sessionId: IdString,
  }),
  z.object({
    type: z.literal("timer:cancel"),
    sessionId: IdString,
    // The engine refuses a blank id outright (it would go on to report
    // TIMER_NOT_FOUND for something the host never meant to send), so it is refused
    // at this boundary too rather than spending a round trip to be told.
    timerId: IdString,
  }),
  z.object({
    type: z.literal("interject:retract"),
    sessionId: IdString,
  }),
  z.object({
    type: z.literal("question:answer"),
    sessionId: IdString,
    questionId: IdString,
    // -1 dismisses. Bounded to the engine's option ceiling so a nonsense index is
    // refused at the boundary rather than parked against a live dispatch. REQUIRED:
    // the engine refuses the command outright when it is missing or non-numeric,
    // rather than defaulting to 0 and answering for a user who never chose.
    choiceIndex: z.number().int().min(-1).max(25),
  }),
  z.object({
    type: z.literal("interrupt"),
    sessionId: IdString,
  }),
  z.object({
    type: z.literal("hibernate"),
    sessionId: IdString,
  }),
  z.object({
    type: z.literal("shutdown"),
    sessionId: IdString,
  }),
]);

/**
 * WHOLE-UNION parity: the Zod validator and the declared TypeScript union must agree,
 * member for member and field for field.
 *
 * This is the guard for the failure that actually happened. Daintree's half of this
 * protocol sat at v1 while the engine moved to v2 and then v3, and nothing caught it
 * because the two descriptions lived in different files with no assertion between
 * them. A hand-maintained schema beside a hand-maintained type is not one contract,
 * it is two — and they only look identical until someone edits one of them.
 *
 * If this line fails to compile, do not cast around it: one of the two is wrong, and
 * the engine's `internal/host/events.go` decides which.
 */
export type AssistantHostEventSchemaParity = AssertTrue<
  ExactlyEqual<z.infer<typeof AssistantHostEventSchema>, AssistantHostEvent>
>;

/** Parse an inbound host event, returning `null` for any invalid message. */
export function parseAssistantHostEvent(value: unknown): AssistantHostEvent | null {
  const result = AssistantHostEventSchema.safeParse(value);
  return result.success ? (result.data as AssistantHostEvent) : null;
}

/** Parse an outbound host command, returning `null` for any invalid message. */
export function parseAssistantHostCommand(value: unknown): AssistantHostCommand | null {
  const result = AssistantHostCommandSchema.safeParse(value);
  return result.success ? (result.data as AssistantHostCommand) : null;
}

/** Parse a fork-time descriptor, returning `null` if it is malformed. */
export function parseAssistantHostSessionDescriptor(
  value: unknown
): AssistantHostSessionDescriptor | null {
  const result = AssistantHostSessionDescriptorSchema.safeParse(value);
  return result.success ? (result.data as AssistantHostSessionDescriptor) : null;
}

/** Re-exported so callers validating a handshake don't import two modules. */
export { ASSISTANT_HOST_PROTOCOL_VERSION };

const DimensionSchema = z.object({
  width: z.number().int().min(1).max(20000),
  height: z.number().int().min(1).max(20000),
});

const DeviceEmulationParametersSchema = z.object({
  screenPosition: z.enum(["desktop", "mobile"]),
  screenSize: DimensionSchema,
  viewPosition: z.object({
    x: z.number().int().min(0).max(20000),
    y: z.number().int().min(0).max(20000),
  }),
  deviceScaleFactor: z.number().min(0).max(10),
  viewSize: DimensionSchema,
  scale: z.number().min(0.01).max(10),
});

export const WebviewSetDeviceEmulationPayloadSchema = z.object({
  webContentsId: z.number().int().nonnegative(),
  panelId: z.string().min(1).max(256),
  emulation: z
    .object({
      params: DeviceEmulationParametersSchema,
      // Guest-visible header value; keep it printable ASCII so a malformed
      // override cannot inject header separators.
      userAgent: z
        .string()
        .min(1)
        .max(1024)
        .regex(/^[\x20-\x7e]+$/, "User agent must be printable ASCII"),
      touch: z.boolean(),
    })
    .nullable(),
});
