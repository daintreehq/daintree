import type { z } from "zod";
import type { ActionDefinition } from "@shared/types/actions";

/**
 * Identity factory that preserves the schema generic so `run`'s args
 * are inferred from `argsSchema` without manual casts.
 */
export function defineAction<S extends z.ZodTypeAny | undefined = undefined, Result = unknown>(
  definition: ActionDefinition<S, Result>
): ActionDefinition<S, Result> {
  return definition;
}
