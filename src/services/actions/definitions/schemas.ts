import { z } from "zod";
import { BUILT_IN_AGENT_IDS, BUILT_IN_TERMINAL_TYPES } from "@shared/config/agentIds";

export const AgentIdSchema = z.enum([...BUILT_IN_AGENT_IDS, "terminal", "browser", "dev-preview"]);

export const LaunchLocationSchema = z
  .enum(["grid", "dock"])
  .describe(
    'Where to place the panel. "grid" places it in the main panel grid (default). "dock" places it in the sidebar dock.'
  );

/**
 * Mirror of `TerminalSpawnSource` from `shared/types/panel.ts`. Kept in lockstep
 * with that union so action argsSchemas can validate the field. The MCP bridge
 * stamps `"mcp"` on spawn-producing dispatches; user surfaces stamp their own
 * origin (`"quickrun"`, `"recipe"`, `"agent"`, `"palette"`).
 */
export const TerminalSpawnSourceSchema = z.enum(["quickrun", "recipe", "agent", "palette", "mcp"]);

export const SettingsTabSchema = z.enum([
  "general",
  "keyboard",
  "terminal",
  "terminalAppearance",
  "worktree",
  "agents",
  "assistant",
  "code-forge",
  "portal",
  "toolbar",
  "integrations",
  "notifications",
  "voice",
  "mcp",
  "environment",
  "privacy",
  "troubleshooting",
  "project:general",
  "project:context",
  "project:variables",
  "project:automation",
  "project:recipes",
  "project:commands",
  "project:notifications",
  "project:code-forge",
]);

export const SettingsNavTargetSchema = z.object({
  tab: SettingsTabSchema,
  subtab: z.string().optional(),
  sectionId: z.string().optional(),
});

export const TerminalTypeSchema = z.enum(BUILT_IN_TERMINAL_TYPES);

export const BuiltInAgentIdSchema = z.enum(BUILT_IN_AGENT_IDS);

export const GitStatusSchema = z.enum([
  "modified",
  "added",
  "deleted",
  "untracked",
  "ignored",
  "renamed",
  "copied",
]);

export const PulseRangeDaysSchema = z
  .union([z.literal(60), z.literal(120), z.literal(180)])
  .optional()
  .default(60);

export const FileSearchPayloadSchema = z.object({
  cwd: z
    .string()
    .optional()
    .describe(
      "Working directory to search in (project root path). Defaults to the active worktree path."
    ),
  query: z.string().describe("File name search query"),
  limit: z.number().int().positive().optional().describe("Max results to return"),
});

export const CopyTreeOptionsSchema = z.object({
  format: z.enum(["xml", "json", "markdown", "tree", "ndjson", "sarif"]).optional(),
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
});

export const AgentPresetSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  args: z.array(z.string()).optional(),
  dangerousEnabled: z.boolean().optional(),
  customFlags: z.string().optional(),
  inlineMode: z.boolean().optional(),
  color: z.string().optional(),
  fallbacks: z.array(z.string()).optional(),
});

export const AgentSettingsEntrySchema = z
  .object({
    selected: z.boolean().optional(),
    enabled: z.boolean().optional(),
    customFlags: z.string().optional(),
    dangerousArgs: z.string().optional(),
    dangerousEnabled: z.boolean().optional(),
    presetId: z.string().optional(),
    customPresets: z.array(AgentPresetSchema).optional(),
  })
  .catchall(z.unknown());

export const WorktreeSummarySchema = z.object({
  id: z.string(),
  path: z.string(),
  branch: z.string().nullable(),
  isActive: z.boolean(),
  isMain: z.boolean(),
  issueNumber: z.number().nullable(),
  issueTitle: z.string().nullable(),
  prNumber: z.number().nullable(),
  prTitle: z.string().nullable(),
  prUrl: z.string().nullable(),
  status: z.string().nullable(),
  lastCommit: z.string().nullable(),
});

export const TerminalSummarySchema = z.object({
  id: z.string(),
  kind: z.string(),
  type: z.unknown().nullable(),
  worktreeId: z.string().nullable(),
  title: z.string().nullable(),
  location: z.enum(["grid", "dock", "trash", "background"]),
  agentId: z.string().nullable(),
  agentState: z.string().nullable(),
  isInputLocked: z.boolean(),
  isFocused: z.boolean(),
});

export const TerminalStatusEntrySchema = z.object({
  terminalId: z.string(),
  agentId: z.string().nullable(),
  agentState: z.string().nullable(),
  waitingReason: z.string().optional(),
  lastTransitionAt: z.number().optional(),
  recentOutput: z.string().nullable().optional(),
  error: z.string().optional(),
});

export const PersistedStoreInfoSchema = z.object({
  storeId: z.string(),
  storageKey: z.string(),
  declaredVersion: z.number().nullable(),
  persistedBlobVersion: z.number().nullable(),
  hasMigrate: z.boolean(),
  hasMerge: z.boolean(),
  hasPartialize: z.boolean(),
  persistedStateType: z.string(),
  hasPersistedValue: z.boolean(),
  sizeBytes: z.number(),
  parseStatus: z.enum(["ok", "missing", "corrupt"]),
});

export const PortalTabSummarySchema = z.object({
  id: z.string(),
  url: z.string().nullable(),
  title: z.string(),
});

export const RecipeSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  worktreeId: z.string().nullable(),
  terminalCount: z.number(),
  showInEmptyState: z.boolean(),
});
