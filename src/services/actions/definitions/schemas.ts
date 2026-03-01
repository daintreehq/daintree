import { z } from "zod";

export const AgentIdSchema = z.enum([
  "claude",
  "gemini",
  "codex",
  "opencode",
  "terminal",
  "browser",
]);

export const LaunchLocationSchema = z.enum(["grid", "dock"]);

export const SettingsTabSchema = z.enum([
  "general",
  "keyboard",
  "terminal",
  "terminalAppearance",
  "worktree",
  "assistant",
  "agents",
  "github",
  "sidecar",
  "toolbar",
  "troubleshooting",
]);

export const TerminalTypeSchema = z.enum(["terminal", "claude", "gemini", "codex", "opencode"]);

export const LegacyAgentTypeSchema = z.enum(["claude", "gemini", "codex", "opencode"]);

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
  cwd: z.string(),
  query: z.string(),
  limit: z.number().int().positive().optional(),
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

export const AgentSettingsEntrySchema = z
  .object({
    enabled: z.boolean().optional(),
    customFlags: z.string().optional(),
    dangerousArgs: z.string().optional(),
    dangerousEnabled: z.boolean().optional(),
  })
  .catchall(z.unknown());
