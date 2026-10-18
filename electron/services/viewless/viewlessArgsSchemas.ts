import { z } from "zod";
import { ForgeListViewSchema } from "../../../shared/utils/forgeListProjection.js";

/**
 * The arguments of the actions the host parses itself rather than handing to
 * a handler that validates them (#13501), as their renderer actions take
 * them. Kept apart from the actions so `viewlessActionParity.test.ts` can hold
 * each to its renderer action's keys without pulling the host's services in.
 */

const selector = z.string().min(1).optional();

/** The worktree a read targets, with `cwd` kept as the legacy spelling these tools accept. */
const location = { worktreeId: selector, worktreePath: selector, cwd: selector };

const listPaging = {
  ...location,
  cursor: z.string().min(1).optional(),
  perPage: z.number().int().min(1).max(100).optional(),
  sort: z.enum(["created", "updated"]).optional(),
  direction: z.enum(["asc", "desc"]).optional(),
  bypassCache: z.boolean().optional(),
  view: ForgeListViewSchema,
};

export const VIEWLESS_FORGE_ARGS_SCHEMAS = {
  "forge.listIssues": z
    .object({
      ...listPaging,
      state: z.enum(["open", "closed", "all"]).optional(),
      search: z.string().optional(),
    })
    .strict(),
  "forge.listPRs": z
    .object({
      ...listPaging,
      state: z.enum(["open", "closed", "merged", "all"]).optional(),
      search: z.string().optional(),
    })
    .strict(),
  "forge.getIssue": z.object({ ...location, issueNumber: z.number().int().positive() }),
  "forge.getPR": z.object({ ...location, prNumber: z.number().int().positive() }),
  "forge.getCIStatus": z.object({ ...location, prNumber: z.number().int().positive() }),
} as const;

const branchName = z.string().trim().min(1);
const issueNumber = z.number().int().positive().optional();

/** `worktree.createWithRecipe`'s arguments, arm for arm as its renderer action takes them. */
export const WorktreeCreateWithRecipeArgsSchema = z.object({
  source: z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("newBranch"),
        branchName,
        baseBranch: branchName.optional(),
        fromRemote: z.boolean().optional(),
        collisionPolicy: z.enum(["suffix", "error"]).optional(),
        issueNumber,
        assignToSelf: z.boolean().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("existingBranch"),
        branchName,
        issueNumber,
        assignToSelf: z.boolean().optional(),
      })
      .strict(),
    z
      .object({ kind: z.literal("pullRequest"), pullRequestNumber: z.number().int().positive() })
      .strict(),
  ]),
  recipeId: z.string().optional(),
  spawnedBy: z.unknown().optional(),
  focusPolicy: z.unknown().optional(),
});
