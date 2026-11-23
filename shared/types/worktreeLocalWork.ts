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
export type WorktreeLocalWork =
  | { kind: "not-applicable" }
  | { kind: "unreadable" }
  | {
      kind: "observed";
      /** Commits on no remote-tracking ref; null on a branch with no commit yet. */
      unpushedCommits: number | null;
      /** Status entries: changed, staged, conflicted or untracked, each path once. */
      changedEntries: number;
      /** Tracked files git takes on trust (assume-unchanged, or a present skip-worktree file). */
      hiddenFromStatus: number;
    };

/**
 * {@link WorktreeLocalWork} as an MCP output schema: one flat object rather
 * than a union of three, since every byte of it is in every client's tool
 * list. Every value of the type satisfies it.
 */
export const WorktreeLocalWorkWireSchema = z.object({
  kind: z.enum(["not-applicable", "unreadable", "observed"]),
  unpushedCommits: z.number().nullable().optional(),
  changedEntries: z.number().optional(),
  hiddenFromStatus: z.number().optional(),
});
