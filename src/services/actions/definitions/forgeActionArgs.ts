// The forge actions' args schemas. forgeActions.ts registers them as metadata;
// forgeActions.impl.ts imports them as types only, to read each body's args as
// its schema's output (#14270).
import { z } from "zod";
import { worktreeLocationShape, withProjectLocation } from "./locationArgs";
import { ForgeMergeMethodSchema } from "./forgeActionResultSchemas";
import { ForgeListViewSchema } from "@shared/utils/forgeListProjection";

/**
 * Paging and ordering shared by both list actions. `.strict()` is deliberate
 * and, as of #11527, the only strict action schema in the codebase: these are
 * `danger: "safe"` queries whose worst failure is silent — Zod's default strip
 * meant `labels: [...]` or `limit: 10` returned a confidently UNFILTERED page,
 * and an agent then acted on the wrong set. A validation error naming the bad
 * key is strictly more useful than a wrong answer.
 */
const ForgeListPagingSchema = z.object({
  ...worktreeLocationShape({ legacy: ["cwd"] }),
  cursor: z
    .string()
    // An empty cursor is not "page one": the provider keys its cache on
    // `cursor ?? ""` but queries on `cursor ?? null`, so `""` would share the
    // first page's cache entry while asking GitHub for an invalid Relay
    // cursor — a cold call errors, the same call after a cache warm quietly
    // returns page one. Reject it here rather than let it alias.
    .min(1, "cursor must be a non-empty value from a previous response's nextCursor")
    .optional()
    .describe("The previous response's `nextCursor`, for the next page."),
  // 100 is the tightest page ceiling across the provider roster, so it is the
  // largest request every provider can serve in one round trip.
  perPage: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("1-100 rows; default varies."),
  sort: z.enum(["created", "updated"]).optional().describe("Sort field (default: created)."),
  direction: z.enum(["asc", "desc"]).optional().describe("Default desc; asc may be refused."),
  // The only escape hatch from a warm list cache. Without it an out-of-band
  // change — the user running a forge CLI in a terminal, another agent closing
  // an issue — stays invisible until the cached page ages out, and the agent
  // has no way to ask for the truth. Mirrors `forge.getRepoStats`.
  bypassCache: z
    .boolean()
    .optional()
    .describe(
      "Skip the provider's list cache (default false). Costs a round trip; use only when the list changed outside Daintree."
    ),
  view: ForgeListViewSchema,
});

export const ForgeListOptionsSchema = ForgeListPagingSchema.extend({
  state: z.enum(["open", "closed", "all"]).optional().describe("State filter (default: open)"),
  search: z
    .string()
    .optional()
    .describe(
      "Provider-native issue search fragment, not plain text; appended to the generated qualifiers and cut to the provider's cap. The search API caps result depth."
    ),
}).strict();

// PR listing adds `merged` to the state filter — pull requests have a merged
// state that issues don't. `search` was absent here until a provider could
// honor it (#11897); the GitHub provider now routes PR listing through the
// same search API the issue path uses, so the key is admitted rather than
// rejected. The dialect differs from the issue one — PR state is expressed
// with `is:` qualifiers, since GitHub's `state:` only accepts open/closed for
// pull requests — but the fragment is passed through unparsed either way.
export const ForgePRListOptionsSchema = ForgeListPagingSchema.extend({
  state: z
    .enum(["open", "closed", "merged", "all"])
    .optional()
    .describe("State filter (default: open)"),
  search: z
    .string()
    .optional()
    .describe(
      "Provider-native PR search fragment, not plain text; appended to the generated qualifiers and cut to the provider's cap. The search API caps result depth."
    ),
}).strict();

/**
 * Smallest and largest batch `forge.getPRs` accepts.
 *
 * The floor is 2 because one number is the singular lookup's job and a plural
 * call for it only adds a shape to unwrap. The ceiling is 20 because that is
 * the GitHub provider's GraphQL chunk size, so a batch at or under it is one
 * request there — but that is a property of the provider, NOT a promise of the
 * tool: a provider without `batchLookups` falls back to a singular read per
 * number. That fallback is the other reason the ceiling is not larger — twenty
 * sequential provider round trips already sit uncomfortably inside the 30s
 * dispatch budget.
 *
 * Both bounds are repeated in the field description on purpose: `toWireSchema`
 * strips `minItems`/`maxItems` from the advertised schema, so prose is the only
 * place a model ever sees them.
 */
export const FORGE_GET_PRS_MIN = 2;
export const FORGE_GET_PRS_MAX = 20;

// Full object id of the head the caller reviewed — forges match the pin exactly.
const HeadShaSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i, "Expected a full commit SHA");

const BaseRefSchema = z.string().min(1).max(255);

export const openIssuesArgsSchema = withProjectLocation({
  query: z.string().optional(),
  state: z.string().optional(),
}).optional();

export const openPRsArgsSchema = withProjectLocation({
  query: z.string().optional(),
  state: z.string().optional(),
}).optional();

export const openCommitsArgsSchema = withProjectLocation({
  branch: z.string().optional(),
}).optional();

export const openRepoArgsSchema = withProjectLocation({}).optional();

export const openIssueArgsSchema = z.object({
  ...worktreeLocationShape({ legacy: ["cwd"] }),
  issueNumber: z.number().int().positive(),
});

export const openPRArgsSchema = z.object({
  ...worktreeLocationShape({ legacy: ["cwd"] }),
  prNumber: z.number().int().positive(),
});

export const assignIssueArgsSchema = z.object({
  ...worktreeLocationShape({ legacy: ["cwd"] }),
  issueNumber: z.number().int().positive(),
  username: z.string().min(1).describe("Account to assign the issue to"),
});

export const unassignIssueArgsSchema = z.object({
  ...worktreeLocationShape({ legacy: ["cwd"] }),
  issueNumber: z.number().int().positive(),
  username: z.string().min(1).describe("Account whose assignment should be removed"),
});

export const approvePRArgsSchema = z.object({
  ...worktreeLocationShape({ legacy: ["cwd"] }),
  prNumber: z.number().int().positive().describe("Pull request number to approve"),
  body: z.string().optional().describe("Optional approval comment"),
});

export const requestChangesArgsSchema = z.object({
  ...worktreeLocationShape({ legacy: ["cwd"] }),
  prNumber: z.number().int().positive().describe("Pull request number to review"),
  body: z.string().trim().min(1).describe("Explanation of the changes being requested"),
});

export const dismissReviewArgsSchema = z.object({
  ...worktreeLocationShape({ legacy: ["cwd"] }),
  prNumber: z.number().int().positive().describe("Pull request number"),
  reviewId: z
    .number()
    .int()
    .positive()
    .describe(
      "Review id to dismiss, as assigned by the forge. Nothing on this surface lists reviews, so read it from the forge itself."
    ),
  message: z.string().trim().min(1).describe("Reason for dismissing the review"),
});

export const requestReviewersArgsSchema = z
  .object({
    ...worktreeLocationShape({ legacy: ["cwd"] }),
    prNumber: z.number().int().positive().describe("Pull request number"),
    users: z
      .array(z.string().min(1))
      .optional()
      .describe("Account logins to request a review from"),
    teams: z
      .array(z.string().min(1))
      .optional()
      .describe("Team identifiers (e.g. GitHub team slugs) to request a review from"),
  })
  .refine((args) => (args.users?.length ?? 0) + (args.teams?.length ?? 0) > 0, {
    message: "Provide at least one user or team to request a review from",
  });

export const validateTokenArgsSchema = z.object({
  // `providerId` carries the canonical `{pluginId}.{contributionId}`
  // id of the forge to validate against, so the Test button in a
  // provider-specific settings tab can never silently route to the
  // wrong forge (#9985).
  providerId: z.string().min(1).describe("Canonical forge provider id"),
  token: z.string(),
});

export const getRepoStatsArgsSchema = z.object({
  ...worktreeLocationShape({ legacy: ["cwd"] }),
  bypassCache: z.boolean().optional(),
});

export const getIssueArgsSchema = z.object({
  ...worktreeLocationShape({ legacy: ["cwd"] }),
  issueNumber: z.number().int().positive().describe("Issue number to fetch"),
});

export const listIssueCommentsArgsSchema = z.object({
  ...worktreeLocationShape({ legacy: ["cwd"] }),
  issueNumber: z.number().int().positive().describe("Issue number whose comments to read"),
  cursor: z
    .string()
    .optional()
    .describe("The previous response's `nextCursor`, for the next page."),
  perPage: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Comments per page (1-100, default 20)"),
});

export const getPRArgsSchema = z.object({
  ...worktreeLocationShape({ legacy: ["cwd"] }),
  prNumber: z.number().int().positive().describe("Pull request number"),
});

export const getPRsArgsSchema = z.object({
  ...worktreeLocationShape({ legacy: ["cwd"] }),
  prNumbers: z
    .array(z.number().int().positive())
    .min(FORGE_GET_PRS_MIN)
    .max(FORGE_GET_PRS_MAX)
    // Uniqueness is enforced rather than tolerated, and it is enforced on
    // BOTH surfaces. Without it the floor was not really a floor:
    // `[9, 9, 9]` satisfied a minimum of 2 and then collapsed to a single
    // lookup, so a caller could reach the plural tool with less work than
    // the singular one does and get a one-entry answer back. `.refine`
    // rejects it at dispatch; `.meta` puts `uniqueItems` in the generated
    // JSON Schema, which `toWireSchema` does not strip, so a strict
    // client refuses it before the call is ever made.
    .refine((numbers) => new Set(numbers).size === numbers.length, {
      message: "prNumbers must not contain duplicates",
    })
    .meta({ uniqueItems: true })
    .describe(
      `The pull request numbers to fetch: at least ${FORGE_GET_PRS_MIN} DISTINCT numbers, at most ${FORGE_GET_PRS_MAX}. Use the singular lookup for one number.`
    ),
});

export const getCIStatusArgsSchema = z.object({
  ...worktreeLocationShape({ legacy: ["cwd"] }),
  prNumber: z.number().int().positive().describe("Pull request number"),
});

export const getChecksArgsSchema = z.object({
  ...worktreeLocationShape({ legacy: ["cwd"] }),
  prNumber: z.number().int().positive().describe("Pull request number whose checks to list"),
});

export const createPRArgsSchema = z.object({
  ...worktreeLocationShape({ legacy: ["cwd"] }),
  head: z.string().min(1).describe("Source branch the changes come from"),
  base: z.string().min(1).describe("Target branch the PR merges into"),
  title: z.string().min(1).describe("Pull request title"),
  body: z.string().optional().describe("Pull request body (Markdown)"),
  draft: z.boolean().optional().describe("Open as a draft pull request"),
});

export const closePRArgsSchema = z.object({
  ...worktreeLocationShape({ legacy: ["cwd"] }),
  prNumber: z.number().int().positive().describe("Pull request number to close"),
});

export const reopenPRArgsSchema = z.object({
  ...worktreeLocationShape({ legacy: ["cwd"] }),
  prNumber: z.number().int().positive().describe("Pull request number to reopen"),
});

export const mergePRArgsSchema = z.object({
  ...worktreeLocationShape({ legacy: ["cwd"] }),
  prNumber: z.number().int().positive().describe("Pull request number to merge"),
  mergeMethod: z
    .enum(["merge", "squash", "rebase"])
    .optional()
    .describe("Merge strategy (provider default when omitted)"),
  commitTitle: z.string().optional().describe("Override the merge commit title"),
  commitMessage: z.string().optional().describe("Override the merge commit message"),
  expectedHeadSha: HeadShaSchema.optional().describe(
    "Head commit you reviewed; the forge refuses the merge if the PR has moved past it"
  ),
  expectedBaseRef: BaseRefSchema.optional().describe(
    "Base branch you reviewed; the merge is refused if the PR has been retargeted"
  ),
});

export const enableAutoMergeArgsSchema = z.object({
  ...worktreeLocationShape(),
  prNumber: z.number().int().positive().describe("Pull request number to arm"),
  mergeMethod: ForgeMergeMethodSchema.optional().describe(
    "Merge strategy (provider default when omitted; ignored on merge-queue branches)"
  ),
  expectedHeadSha: HeadShaSchema.describe("Head commit you reviewed"),
  expectedBaseRef: BaseRefSchema.optional().describe(
    "Base branch you reviewed; arming is refused if the PR has been retargeted"
  ),
});

export const disableAutoMergeArgsSchema = z.object({
  ...worktreeLocationShape(),
  prNumber: z.number().int().positive().describe("Pull request number"),
});

export const createIssueArgsSchema = z.object({
  ...worktreeLocationShape({ legacy: ["cwd"] }),
  title: z.string().min(1).describe("Issue title"),
  body: z.string().optional().describe("Issue body (markdown)"),
  labels: z.array(z.string()).optional().describe("Label names to apply on creation"),
});

export const convertPRToDraftArgsSchema = z.object({
  ...worktreeLocationShape({ legacy: ["cwd"] }),
  prNumber: z.number().int().positive().describe("Pull request number to convert to draft"),
});

export const closeIssueArgsSchema = z.object({
  ...worktreeLocationShape({ legacy: ["cwd"] }),
  issueNumber: z.number().int().positive().describe("Issue number to close"),
  stateReason: z
    .enum(["completed", "not_planned", "duplicate"])
    .optional()
    .describe("Why the issue is being closed (default: completed)"),
});

export const markPRReadyForReviewArgsSchema = z.object({
  ...worktreeLocationShape({ legacy: ["cwd"] }),
  prNumber: z.number().int().positive().describe("Pull request number to mark ready"),
});

export const reopenIssueArgsSchema = z.object({
  ...worktreeLocationShape({ legacy: ["cwd"] }),
  issueNumber: z.number().int().positive().describe("Issue number to reopen"),
});

export const commentOnPRArgsSchema = z.object({
  ...worktreeLocationShape({ legacy: ["cwd"] }),
  prNumber: z.number().int().positive().describe("Pull request number to comment on"),
  body: z.string().min(1).describe("Comment body (Markdown)"),
});

export const editPRArgsSchema = z
  .object({
    ...worktreeLocationShape({ legacy: ["cwd"] }),
    prNumber: z.number().int().positive().describe("Pull request number to edit"),
    title: z.string().min(1).optional().describe("New pull request title"),
    body: z.string().optional().describe("New pull request body (Markdown)"),
  })
  .refine((v) => v.title !== undefined || v.body !== undefined, {
    message: "Provide a title or body to edit",
  });

export const editIssueArgsSchema = z
  .object({
    ...worktreeLocationShape({ legacy: ["cwd"] }),
    issueNumber: z.number().int().positive().describe("Issue number to edit"),
    title: z.string().optional().describe("New issue title"),
    body: z.string().optional().describe("New issue body (markdown)"),
  })
  .refine((v) => v.title !== undefined || v.body !== undefined, {
    message: "Provide at least one of title or body to edit",
  });

export const addIssueCommentArgsSchema = z.object({
  ...worktreeLocationShape({ legacy: ["cwd"] }),
  issueNumber: z.number().int().positive().describe("Issue number to comment on"),
  body: z.string().min(1).describe("Comment body (markdown)"),
});

export const addIssueLabelArgsSchema = z.object({
  ...worktreeLocationShape({ legacy: ["cwd"] }),
  issueNumber: z.number().int().positive().describe("Issue number to label"),
  label: z.string().min(1).describe("Label name to add"),
});

export const removeIssueLabelArgsSchema = z.object({
  ...worktreeLocationShape({ legacy: ["cwd"] }),
  issueNumber: z.number().int().positive().describe("Issue number to unlabel"),
  label: z.string().min(1).describe("Label name to remove"),
});
