import { z } from "zod";

// Schemas shared by the project actions' metadata (projectActions.ts) and their
// run bodies (projectActions.impl.ts).

// `workspaceId` is optional so the executing view's own workspace can stand in
// for it. `terminal.revealOwned` supplies it from the ownership ledger, but the
// ledger records it best-effort, and a reveal whose destination is unknown is
// still better answered by "the workspace you are in" than refused outright —
// that is where a panel is if the client never left. The click payload always
// sends it: a row in the overview names a run in another workspace more often
// than not.
export const openRunArgs = z.object({ runId: z.string(), workspaceId: z.string().optional() });

export const setGroupArgs = z.object({
  projectId: z.string().min(1),
  groupId: z.string().min(1).nullable(),
});

export const createGroupArgs = z.object({
  name: z.string(),
  projectId: z.string().min(1).optional(),
});

export const neverAutoSleepArgs = z.object({
  projectId: z.string().optional(),
  enabled: z.boolean().optional(),
});
