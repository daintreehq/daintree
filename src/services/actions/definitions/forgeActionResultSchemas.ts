// Result schemas both halves of the forge actions need at runtime:
// forgeActions.ts registers them as `resultSchema`, and forgeActions.impl.ts
// parses its results against them. Kept apart from forgeActionArgs.ts because
// a module both halves import at runtime is split out of the App chunk into
// its own eager chunk, and the args schemas don't need to pay for that (#14270).
import { z } from "zod";
import { ForgeUserResultSchema } from "@shared/types/forgeActionResults";

// Comment returned by the add-comment write action.
export const ForgeCommentResultSchema = z.object({
  id: z.string(),
  body: z.string(),
  url: z.string(),
  createdAt: z.number(),
});

// Resulting assignee list after an assign/unassign. The list is authoritative:
// forges silently drop assignees the account can't take, so it can omit the
// username that was just requested.
export const ForgeAssigneesResultSchema = z.object({
  issueNumber: z.number(),
  assignees: z.array(ForgeUserResultSchema),
});

// Review created (or dismissed) by the review-write actions.
export const ForgeReviewResultSchema = z.object({
  id: z.string(),
  state: z.string().describe("Normalized verdict: approved, changes_requested, dismissed, …"),
  rawState: z.string().describe("The forge's own spelling of the verdict"),
  body: z.string(),
  url: z.string(),
  author: ForgeUserResultSchema.optional(),
  submittedAt: z.number().nullable(),
  commitId: z.string().nullable(),
});

// Reviewer requests a PR carries after a request-reviewers call.
export const ForgeRequestedReviewersResultSchema = z.object({
  prNumber: z.number(),
  requestedUsers: z.array(z.string()),
  requestedTeams: z.array(z.string()),
});

// Merge acknowledgement. Deliberately narrow — a merge endpoint reports whether
// the merge landed and under which commit, not the resulting pull request.
export const ForgeMergePRResultSchema = z.object({
  prNumber: z.number(),
  sha: z.string().nullable().describe("Merge commit SHA, or null when the forge reports none"),
  merged: z.boolean(),
  message: z.string(),
});

export const ForgeMergeMethodSchema = z.enum(["merge", "squash", "rebase"]);

const ForgeMergeIntentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("auto-merge"),
    method: ForgeMergeMethodSchema.nullable().describe("null when a merge queue picks the method"),
    enabledAt: z.number().nullable(),
    enabledBy: z.string().optional(),
  }),
  z.object({ kind: z.literal("queued"), position: z.number().nullable() }),
]);

export const ForgeEnableAutoMergeResultSchema = z.object({
  prNumber: z.number(),
  outcome: z
    .enum(["armed", "already-mergeable"])
    .describe(
      "armed: the forge will merge once requirements pass; already-mergeable: nothing was armed because the PR can merge now"
    ),
  mergeIntent: ForgeMergeIntentSchema.nullable().optional(),
  message: z.string().optional(),
});

export const ForgeDisableAutoMergeResultSchema = z.object({
  prNumber: z.number(),
  outcome: z.enum(["disarmed", "dequeued", "not-pending"]),
});

// Draft state a PR ended in after a draft-toggle action.
export const ForgePRDraftStateResultSchema = z.object({
  prNumber: z.number(),
  isDraft: z.boolean(),
});
