import { z } from "zod";

/** Shared by the saved-fleet actions' metadata and their runs. */
export const saveNamedFleetSchema = z.object({ name: z.string().min(1) }).and(
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("snapshot"),
      terminalIds: z.array(z.string()).optional(),
    }),
    z.object({
      kind: z.literal("predicate"),
      scope: z.enum(["current", "all"]),
      stateFilter: z.enum(["all", "working", "waiting", "finished"]),
    }),
  ])
);

export const idArgSchema = z.object({ id: z.string().min(1) });

export type SaveNamedFleetArgs = z.infer<typeof saveNamedFleetSchema>;
