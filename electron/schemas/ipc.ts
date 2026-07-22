/**
 * Zod schemas for IPC payload validation between main and renderer processes.
 */

import { z } from "zod";
import { BUILT_IN_PANEL_KINDS, panelKindHasPty } from "../../shared/config/panelKindRegistry.js";
import { BUILT_IN_AGENT_IDS } from "../../shared/config/agentIds.js";
import {
  ASSISTANT_HOST_PROTOCOL_VERSION,
  type AssistantHostEvent,
  type AssistantHostCommand,
  type AssistantHostSessionDescriptor,
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
  cols: z.number().int().positive().max(500),
  rows: z.number().int().positive().max(500),
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

export const CopyTreeOptionsSchema = z
  .object({
    format: CopyTreeFormatSchema.optional(),
    filter: z.union([z.string(), z.array(z.string())]).optional(),
    exclude: z.union([z.string(), z.array(z.string())]).optional(),
    always: z.array(z.string()).optional(),
    includePaths: z.array(z.string()).optional(),
    modified: z.boolean().optional(),
    changed: z.string().optional(),
    maxFileSize: z.number().int().positive().optional(),
    maxTotalSize: z.number().int().positive().optional(),
    maxFileCount: z.number().int().positive().optional(),
    withLineNumbers: z.boolean().optional(),
    charLimit: z.number().int().positive().optional(),
    sort: z.enum(["path", "size", "modified", "name", "extension", "depth"]).optional(),
  })
  .optional();

export const CopyTreeGeneratePayloadSchema = z.object({
  worktreeId: z.string().min(1),
  options: CopyTreeOptionsSchema,
});

export const CopyTreeGenerateAndCopyFilePayloadSchema = z.object({
  worktreeId: z.string().min(1),
  options: CopyTreeOptionsSchema,
});

export const CopyTreeInjectPayloadSchema = z.object({
  terminalId: z.string().min(1),
  worktreeId: z.string().min(1),
  options: CopyTreeOptionsSchema,
  injectionId: z.string().min(1).optional(),
});

export const CopyTreeCancelPayloadSchema = z.object({
  injectionId: z.string().min(1).optional(),
});

// Test-config dry runs send `null` for fields the user explicitly cleared in the
// unsaved settings form (Electron's structured clone drops `undefined` keys, so
// `null` is the only sentinel that survives IPC). `null` blocks the saved-settings
// back-fill in mergeCopyTreeOptions; absent/undefined still falls back.
export const CopyTreeTestConfigOptionsSchema = CopyTreeOptionsSchema.unwrap()
  .extend({
    exclude: z.union([z.string(), z.array(z.string())]).nullish(),
    always: z.array(z.string()).nullish(),
    maxFileSize: z.number().int().positive().nullish(),
    maxTotalSize: z.number().int().positive().nullish(),
    charLimit: z.number().int().positive().nullish(),
    sort: z.enum(["path", "size", "modified", "name", "extension", "depth"]).nullish(),
  })
  .optional();

export const CopyTreeTestConfigPayloadSchema = z.object({
  worktreeId: z.string().min(1),
  options: CopyTreeTestConfigOptionsSchema,
});

export const CopyTreeProgressSchema = z.object({
  stage: z.string(),
  progress: z.number().min(0).max(1),
  message: z.string(),
  filesProcessed: z.number().int().nonnegative().optional(),
  totalFiles: z.number().int().nonnegative().optional(),
  currentFile: z.string().optional(),
  traceId: z.string().optional(),
});

export const CopyTreeGetFileTreePayloadSchema = z.object({
  worktreeId: z.string().min(1),
  dirPath: z.string().optional(),
});

// Both strings are capped: they cross the boundary as untrusted input and end
// up in path joins and a `git check-ignore` argv, neither of which should ever
// see a megabyte-long value.
export const FileBrowserListDirectoryPayloadSchema = z.object({
  worktreeId: z.string().min(1).max(4096),
  dirPath: z.string().max(4096).optional(),
  includeIgnored: z.boolean().optional(),
});

// Batch-capped: one call validates the directory candidates of a single
// hovered terminal line, which is a handful of tokens, never hundreds.
export const FileBrowserStatPathsPayloadSchema = z.object({
  worktreeId: z.string().min(1).max(4096),
  paths: z.array(z.string().min(1).max(4096)).max(32),
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
  "unknown",
]);

const AssistantTurnRoleSchema = z.enum(["user", "assistant"]);

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

export const AssistantHostEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("host:ready"),
    sessionId: IdString,
    protocolVersion: z.number().int().positive(),
    resumedSessionId: IdString.optional(),
  }),
  z.object({
    type: z.literal("turn:start"),
    sessionId: IdString,
    turnId: IdString,
    role: AssistantTurnRoleSchema,
    startedAt: Timestamp,
  }),
  z.object({
    type: z.literal("turn:token"),
    sessionId: IdString,
    turnId: IdString,
    chunk: z.string(),
  }),
  z.object({
    type: z.literal("turn:end"),
    sessionId: IdString,
    turnId: IdString,
    endedAt: Timestamp,
    outcome: TurnOutcomeClassSchema.optional(),
  }),
  z.object({
    type: z.literal("tool:started"),
    sessionId: IdString,
    toolCallId: IdString,
    toolId: IdString,
    argsSummary: z.string(),
    startedAt: Timestamp,
    turnId: IdString.optional(),
    danger: z.boolean(),
  }),
  z.object({
    type: z.literal("tool:settled"),
    sessionId: IdString,
    toolCallId: IdString,
    toolId: IdString,
    durationMs: Timestamp,
    result: McpAuditResultSchema,
    severity: McpAuditSeveritySchema,
    errorCode: z.string().optional(),
    turnId: IdString.optional(),
  }),
  z.object({
    type: z.literal("approval:requested"),
    sessionId: IdString,
    approvalId: IdString,
    toolId: IdString,
    summary: z.string(),
    requestedAt: Timestamp,
    turnId: IdString.optional(),
  }),
  z.object({
    type: z.literal("approval:decided"),
    sessionId: IdString,
    approvalId: IdString,
    decision: McpConfirmationDecisionSchema,
    decidedAt: Timestamp,
  }),
  z.object({
    type: z.literal("host:error"),
    sessionId: IdString,
    code: IdString,
    message: z.string(),
  }),
  z.object({
    type: z.literal("host:shutdown"),
    sessionId: IdString,
    reason: AssistantHostShutdownReasonSchema,
    resumeSessionId: IdString.optional(),
  }),
]);

export const AssistantHostCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("prompt"),
    sessionId: IdString,
    text: z.string(),
  }),
  z.object({
    type: z.literal("approval:decide"),
    sessionId: IdString,
    approvalId: IdString,
    decision: McpConfirmationDecisionSchema,
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
