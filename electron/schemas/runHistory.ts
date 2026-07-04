/**
 * Zod schemas validating run-history append payloads at the IPC boundary
 * (#9949). The renderer is the producer, so the payload crosses a trust
 * boundary — structural validation here is defense-in-depth on top of the
 * field-capping the {@link RunHistoryLog} service applies before persisting.
 */

import { z } from "zod";
import type { RunHistoryAppendInput } from "../../shared/types/ipc/runHistory.js";

const TargetOutcomeSchema = z.object({
  terminalId: z.string(),
  title: z.string().optional(),
  status: z.enum(["fulfilled", "rejected"]),
  reason: z.string().optional(),
  failureKind: z.enum(["permanent", "transient"]).optional(),
  finalAgentState: z.string().optional(),
});

const RecipeAppendSchema = z.object({
  kind: z.literal("recipe"),
  durationMs: z.number().optional(),
  recipeId: z.string().optional(),
  recipeName: z.string(),
  worktreeId: z.string().optional(),
  worktreeName: z.string().optional(),
  totalTerminals: z.number(),
  spawned: z.array(
    z.object({
      index: z.number(),
      terminalId: z.string(),
      title: z.string().optional(),
    })
  ),
  failed: z.array(
    z.object({
      index: z.number(),
      error: z.string(),
    })
  ),
});

const FleetAppendSchema = z.object({
  kind: z.literal("fleet"),
  durationMs: z.number().optional(),
  draftPreview: z.string().optional(),
  targetCount: z.number(),
  successCount: z.number(),
  failureCount: z.number(),
  cancelled: z.boolean(),
  perTarget: z.array(TargetOutcomeSchema),
  runId: z.string().optional(),
  status: z.enum(["completed", "cancelled", "failed", "superseded"]).optional(),
  isRetry: z.boolean().optional(),
});

export const RunHistoryAppendInputSchema = z.discriminatedUnion("kind", [
  RecipeAppendSchema,
  FleetAppendSchema,
]);

// Compile-time guard: the schema output must remain assignable to the shared
// input type so the IPC handler and renderer stay in lockstep.
const _typecheck: RunHistoryAppendInput = {} as z.infer<typeof RunHistoryAppendInputSchema>;
void _typecheck;
