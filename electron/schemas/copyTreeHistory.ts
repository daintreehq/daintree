import { z } from "zod";
import { CopyTreeOptionsSchema, CopyTreeRunSourceSchema } from "./ipc.js";

export const CopyTreeRunStatsSchema = z.object({
  fileCount: z.number().int().nonnegative(),
  totalSize: z.number().nonnegative().optional(),
  duration: z.number().nonnegative().optional(),
});

/**
 * Validates a persisted record on the way back in. `options` reuses the same
 * schema the IPC boundary applies, so a record can never rehydrate into
 * something the generate handlers would have rejected.
 */
export const CopyTreeHistoryRecordSchema = z.object({
  id: z.string().min(1),
  dedupeKey: z.string().min(1),
  name: z.string().min(1),
  options: CopyTreeOptionsSchema.unwrap(),
  source: CopyTreeRunSourceSchema,
  worktreeId: z.string().min(1),
  stats: CopyTreeRunStatsSchema,
  createdAt: z.number().int().nonnegative(),
  lastUsedAt: z.number().int().nonnegative(),
  runCount: z.number().int().positive(),
});

export const CopyTreeHistoryFileSchema = z.object({
  _schemaVersion: z.number().int().nonnegative(),
  records: z.array(CopyTreeHistoryRecordSchema),
});
