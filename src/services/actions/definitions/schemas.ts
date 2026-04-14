import { z } from "zod";
import { BUILT_IN_AGENT_IDS, BUILT_IN_TERMINAL_TYPES } from "@shared/config/agentIds";

export const AgentIdSchema = z.enum([...BUILT_IN_AGENT_IDS, "terminal", "browser", "dev-preview"]);

export const LaunchLocationSchema = z.enum(["grid", "dock"]);

export const SettingsTabSchema = z.enum([
  "general",
  "keyboard",
  "terminal",
  "terminalAppearance",
  "worktree",
  "agents",
  "github",
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
  "project:github",
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

export const PulseRangeDaysSchema = z.union([z.literal(60), z.literal(120), z.literal(180)]);

export const FileSearchPayloadSchema = z.object({
  cwd: z.string().describe("Working directory to search in (project root path)"),
  query: z.string().describe("File name search query"),
  limit: z.number().int().positive().optional().describe("Max results to return"),
});

export const CopyTreeOptionsSchema = z.object({
  format: z.enum(["xml", "json", "markdown", "tree", "ndjson"]).optional(),
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

export const AgentFlavorSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  args: z.array(z.string()).optional(),
});

export const AgentSettingsEntrySchema = z
  .object({
    selected: z.boolean().optional(),
    enabled: z.boolean().optional(),
    customFlags: z.string().optional(),
    dangerousArgs: z.string().optional(),
    dangerousEnabled: z.boolean().optional(),
    flavorId: z.string().optional(),
    customFlavors: z.array(AgentFlavorSchema).optional(),
  })
  .catchall(z.unknown());
