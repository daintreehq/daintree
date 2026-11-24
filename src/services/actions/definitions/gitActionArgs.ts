import { z } from "zod";
import { withWorktreeLocation } from "./locationArgs";

/** Shared by `git.stageHunk` and `git.unstageHunk`'s metadata and their runs. */
export const hunkStagingArgsSchema = withWorktreeLocation({
  filePath: z.string().min(1).describe("Path of the file, relative to the worktree root."),
  hunks: z
    .array(z.string().min(1))
    .min(1)
    .describe("Git's hunks as read from that side's diff, each its @@ header line and body."),
});

export const hunkStagingResultSchema = z.object({
  status: z.enum(["applied", "stale", "unsupported"]),
});

/** Shared by `git.discardFileChanges`'s metadata and its run. */
export const fileMutationArgsSchema = withWorktreeLocation({
  filePath: z.string().min(1).describe("Path of the file, relative to the worktree root."),
});
