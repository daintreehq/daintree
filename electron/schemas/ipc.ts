/**
 * Zod schemas for IPC payload validation between main and renderer processes.
 */

import { z } from "zod";
import { TerminalTypeSchema } from "./agent.js";

// Row limits: 500 for standard terminals, up to 1000 for agent tall canvas mode
// Runtime clamping in getSafeTallCanvasRows() ensures we stay under canvas limits
const MAX_ROWS_TALL_CANVAS = 1000;

export const TerminalSpawnOptionsSchema = z.object({
  id: z.string().optional(),
  kind: z.enum(["terminal", "agent"]).optional(),
  agentId: z.string().optional(),
  cwd: z.string().optional(),
  shell: z.string().optional(),
  cols: z.number().int().positive().max(500),
  rows: z.number().int().positive().max(MAX_ROWS_TALL_CANVAS),
  command: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  type: TerminalTypeSchema.optional(),
  title: z.string().optional(),
  worktreeId: z.string().optional(),
});

export const TerminalResizePayloadSchema = z.object({
  id: z.string().min(1),
  cols: z.number().int().positive().max(500),
  rows: z.number().int().positive().max(MAX_ROWS_TALL_CANVAS),
});

export const DevServerStatusSchema = z.enum(["stopped", "starting", "running", "error"]);

export const DevServerStartPayloadSchema = z.object({
  worktreeId: z.string().min(1),
  worktreePath: z.string().min(1),
  command: z.string().optional(),
});

export const DevServerStopPayloadSchema = z.object({
  worktreeId: z.string().min(1),
});

export const DevServerTogglePayloadSchema = z.object({
  worktreeId: z.string().min(1),
  worktreePath: z.string().min(1),
  command: z.string().optional(),
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
  path: z.string().min(1),
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

export type TerminalSpawnOptions = z.infer<typeof TerminalSpawnOptionsSchema>;
export type TerminalResizePayload = z.infer<typeof TerminalResizePayloadSchema>;
export type DevServerStartPayload = z.infer<typeof DevServerStartPayloadSchema>;
export type DevServerStopPayload = z.infer<typeof DevServerStopPayloadSchema>;
export type DevServerTogglePayload = z.infer<typeof DevServerTogglePayloadSchema>;
export type CopyTreeOptions = z.infer<typeof CopyTreeOptionsSchema>;
export type CopyTreeGeneratePayload = z.infer<typeof CopyTreeGeneratePayloadSchema>;
export type CopyTreeGenerateAndCopyFilePayload = z.infer<
  typeof CopyTreeGenerateAndCopyFilePayloadSchema
>;
export type CopyTreeInjectPayload = z.infer<typeof CopyTreeInjectPayloadSchema>;
export type CopyTreeProgress = z.infer<typeof CopyTreeProgressSchema>;
export type CopyTreeGetFileTreePayload = z.infer<typeof CopyTreeGetFileTreePayloadSchema>;
export type SystemOpenExternalPayload = z.infer<typeof SystemOpenExternalPayloadSchema>;
export type SystemOpenPathPayload = z.infer<typeof SystemOpenPathPayloadSchema>;
export type WorktreeSetActivePayload = z.infer<typeof WorktreeSetActivePayloadSchema>;
export type WorktreeCreatePayload = z.infer<typeof WorktreeCreatePayloadSchema>;
