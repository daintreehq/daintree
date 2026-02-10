/**
 * Zod schemas for IPC payload validation between main and renderer processes.
 */

import { z } from "zod";
import { TerminalTypeSchema } from "./agent.js";
import { panelKindHasPty } from "../../shared/config/panelKindRegistry.js";

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
export const TerminalLocationSchema = z.enum(["grid", "dock", "trash"]);

/**
 * Schema for panel/terminal kind - distinguishes built-in panel types.
 */
export const PanelKindSchema = z.union([
  z.enum(["terminal", "agent", "browser", "notes", "dev-preview"]),
  z.string(), // Allow extension-provided kinds
]);

/**
 * Schema for terminal entries in appState.terminals (persisted globally).
 * This is the minimal schema for ordering/metadata preservation.
 * Note: Uses AppStateTerminalLocationSchema which excludes "trash" to match StoreSchema.
 * Uses passthrough() to preserve unknown fields for forward compatibility with extensions.
 *
 * PTY-backed panels (terminal, agent, dev-preview) require `type` and `cwd`.
 * Non-PTY panels (browser, notes) have these fields optional since they don't spawn processes.
 */
export const AppStateTerminalEntrySchema = z
  .object({
    id: z.string().min(1),
    kind: PanelKindSchema.optional(),
    type: TerminalTypeSchema.optional(),
    title: z.string(),
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
    notePath: z.string().optional(),
    noteId: z.string().optional(),
    scope: z.enum(["worktree", "project"]).optional(),
    createdAt: z.number().optional(),
    devCommand: z.string().optional(),
    devServerStatus: z.enum(["stopped", "starting", "installing", "running", "error"]).optional(),
    devServerUrl: z.string().optional(),
    devServerError: z
      .object({
        type: z.string(),
        message: z.string(),
      })
      .optional(),
    devServerTerminalId: z.string().optional(),
    devPreviewConsoleOpen: z.boolean().optional(),
  })
  .passthrough()
  .refine(
    (data) => {
      // PTY-backed panels require type and cwd
      // Non-PTY panels (browser, notes) don't need them

      // Infer kind from content fields if missing (backwards compatibility)
      let kind = data.kind;
      if (!kind) {
        if (data.browserUrl !== undefined) {
          kind = "browser";
        } else if (data.notePath !== undefined || data.noteId !== undefined) {
          kind = "notes";
        } else if (data.devCommand !== undefined) {
          kind = "dev-preview";
        } else {
          kind = "terminal"; // default to terminal
        }
      }

      if (panelKindHasPty(kind)) {
        return data.type !== undefined && data.cwd !== undefined;
      }
      return true;
    },
    {
      message: "PTY-backed panels require 'type' and 'cwd' fields",
    }
  );

/**
 * Schema for terminal snapshots in ProjectState.terminals (per-project state).
 * Matches the TerminalSnapshot interface from shared/types/domain.ts.
 * Uses passthrough() to preserve unknown fields for forward compatibility with extensions.
 *
 * PTY-backed panels (terminal, agent, dev-preview) require `type` and `cwd`.
 * Non-PTY panels (browser, notes) have these fields optional since they don't spawn processes.
 */
export const TerminalSnapshotSchema = z
  .object({
    id: z.string().min(1),
    kind: PanelKindSchema.optional(),
    type: TerminalTypeSchema.optional(),
    agentId: z.string().optional(),
    title: z.string(),
    cwd: z.string().optional(),
    worktreeId: z.string().optional(),
    location: TerminalLocationSchema,
    command: z.string().optional(),
    browserUrl: z.string().optional(),
    notePath: z.string().optional(),
    noteId: z.string().optional(),
    scope: z.enum(["worktree", "project"]).optional(),
    createdAt: z.number().optional(),
    devCommand: z.string().optional(),
    devServerStatus: z.enum(["stopped", "starting", "installing", "running", "error"]).optional(),
    devServerUrl: z.string().optional(),
    devServerError: z
      .object({
        type: z.string(),
        message: z.string(),
      })
      .optional(),
    devServerTerminalId: z.string().optional(),
    devPreviewConsoleOpen: z.boolean().optional(),
  })
  .passthrough()
  .refine(
    (data) => {
      // PTY-backed panels require type and cwd
      // Non-PTY panels (browser, notes) don't need them

      // Infer kind from content fields if missing (backwards compatibility)
      let kind = data.kind;
      if (!kind) {
        if (data.browserUrl !== undefined) {
          kind = "browser";
        } else if (data.notePath !== undefined || data.noteId !== undefined) {
          kind = "notes";
        } else if (data.devCommand !== undefined) {
          kind = "dev-preview";
        } else {
          kind = "terminal"; // default to terminal
        }
      }

      if (panelKindHasPty(kind)) {
        return data.type !== undefined && data.cwd !== undefined;
      }
      return true;
    },
    {
      message: "PTY-backed panels require 'type' and 'cwd' fields",
    }
  );

export type AppStateTerminalEntry = z.infer<typeof AppStateTerminalEntrySchema>;
export type TerminalSnapshotEntry = z.infer<typeof TerminalSnapshotSchema>;

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

      const flattened = result.error.flatten();
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

export const TerminalSpawnOptionsSchema = z.object({
  id: z.string().optional(),
  kind: PanelKindSchema.optional(),
  agentId: z.string().optional(),
  cwd: z.string().optional(),
  shell: z.string().optional(),
  cols: z.number().int().positive().max(500),
  rows: z.number().int().positive(),
  command: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  type: TerminalTypeSchema.optional(),
  title: z.string().optional(),
  worktreeId: z.string().optional(),
  restore: z.boolean().optional(),
  isEphemeral: z.boolean().optional(),
});

export const TerminalResizePayloadSchema = z.object({
  id: z.string().min(1),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

export const FileSearchPayloadSchema = z.object({
  cwd: z.string().min(1),
  query: z.string(),
  limit: z.number().int().positive().max(100).optional(),
});

export const SlashCommandListRequestSchema = z.object({
  agentId: z.enum(["claude", "gemini", "codex", "opencode"]),
  projectPath: z.string().optional(),
});

export const CopyTreeFormatSchema = z.enum(["xml", "json", "markdown", "tree", "ndjson"]);

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

export const CopyTreeTestConfigPayloadSchema = z.object({
  worktreeId: z.string().min(1),
  options: CopyTreeOptionsSchema,
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

export const SystemOpenExternalPayloadSchema = z.object({
  url: z.string().url(),
});

export const SystemOpenPathPayloadSchema = z.object({
  path: z.string().min(1).max(4096),
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
  rootPath: z.string().min(1),
  options: z.object({
    baseBranch: z.string().min(1),
    newBranch: z.string().min(1),
    path: z.string().min(1),
    fromRemote: z.boolean().optional(),
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

      const flattened = result.error.flatten();
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
export type SystemOpenExternalPayload = z.infer<typeof SystemOpenExternalPayloadSchema>;
export type SystemOpenPathPayload = z.infer<typeof SystemOpenPathPayloadSchema>;
export type TerminalReplayHistoryPayload = z.infer<typeof TerminalReplayHistoryPayloadSchema>;
export type DevPreviewStartPayload = z.infer<typeof DevPreviewStartPayloadSchema>;
export type WorktreeSetActivePayload = z.infer<typeof WorktreeSetActivePayloadSchema>;
export type WorktreeCreatePayload = z.infer<typeof WorktreeCreatePayloadSchema>;
