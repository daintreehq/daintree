import { z } from "zod";
import { withWorktreeLocation } from "./locationArgs";

/** Shared by `git.discardFileChanges`'s metadata and its run. */
export const fileMutationArgsSchema = withWorktreeLocation({
  filePath: z.string().min(1).describe("Path of the file, relative to the worktree root."),
});
