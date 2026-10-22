import { z } from "zod";
import type {
  PluginRunRecipeRefusalReason,
  PluginRunRecipeResult,
} from "../../../shared/types/plugin.js";

/** Longest recipe or worktree id `host.runRecipe` accepts. */
export const RUN_RECIPE_MAX_ID_LENGTH = 512;

// A record keyed by the union so a reason added to the type without an entry
// here fails typecheck rather than being read back as a dismissal.
const REFUSAL_REASON_KEYS = {
  "unknown-worktree": true,
  "recipe-unavailable": true,
  "agent-tools-off": true,
  "project-unavailable": true,
  "prompt-open": true,
  "launch-failed": true,
} satisfies Record<PluginRunRecipeRefusalReason, true>;

/** Every refusal a recipe run can report, for validating an answer. */
export const RUN_RECIPE_REFUSAL_REASONS = Object.keys(REFUSAL_REASON_KEYS) as [
  PluginRunRecipeRefusalReason,
  ...PluginRunRecipeRefusalReason[],
];

const RunRecipeAnswerSchema = z.union([
  z.object({
    status: z.literal("ran"),
    spawnedCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(),
  }),
  z.object({ status: z.literal("cancelled") }),
  z.object({ status: z.literal("refused"), reason: z.enum(RUN_RECIPE_REFUSAL_REASONS) }),
]);

/**
 * A renderer's answer to a recipe run, re-checked before it reaches the
 * plugin. Anything malformed reads as a dismissal, never as a run.
 */
export function toRunRecipeResult(value: unknown): PluginRunRecipeResult {
  const parsed = RunRecipeAnswerSchema.safeParse(value);
  return parsed.success ? parsed.data : { status: "cancelled" };
}
