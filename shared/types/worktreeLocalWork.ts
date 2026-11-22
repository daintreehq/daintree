import { z } from "zod";

/**
 * What git showed, on the host that owns it, of the worktree a panel about to
 * be closed sits in (#18151): whether anything in it exists only on that
 * machine. Observations only; what to do about them is the person's.
 *
 * - `not-applicable`: the panel isn't in a linked worktree (no worktree, or the
 *   project's main checkout), so nothing was read.
 * - `unreadable`: git couldn't say, or didn't answer in time. Never read as clean.
 * - `observed`: what git reported, counted against every remote-tracking ref as
 *   of the last fetch; nothing is fetched to ask.
 */
export const WorktreeLocalWorkSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("not-applicable") }),
  z.object({ kind: z.literal("unreadable") }),
  z.object({
    kind: z.literal("observed"),
    unpushedCommits: z
      .number()
      .nullable()
      .describe("Commits on no remote-tracking ref as of the last fetch; null: no commit yet."),
    changedEntries: z
      .number()
      .describe("Changed, staged, conflicted or untracked entries, each path once."),
    hiddenFromStatus: z
      .number()
      .describe("Tracked files git takes on trust (assume-unchanged or skip-worktree)."),
  }),
]);

export type WorktreeLocalWork = z.infer<typeof WorktreeLocalWorkSchema>;
