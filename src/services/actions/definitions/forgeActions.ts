import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import type { ForgeUser } from "@shared/types/forge";
import { defineAction } from "../defineAction";
import { z } from "zod";
import { forgeClient } from "@/clients";
import {
  worktreeLocationShape,
  withProjectLocation,
  requireWorktreePath,
  resolveProjectLocation,
  type WorktreeLocationArgs,
} from "./locationArgs";
import { useProjectStore } from "@/store/projectStore";
import { patchIssueAssigneeCache } from "@/lib/forgeResourceCache";
import { logError } from "@/utils/logger";
import {
  ForgeIssuePageResultSchema,
  ForgeListViewSchema,
  ForgePRPageResultSchema,
  projectForgePage,
  projectIssueSummary,
  projectPRSummary,
} from "./forgeListProjection";

/**
 * The cache keys on the PROJECT ROOT, but these actions resolve their forge
 * target from the caller's location argument — and a linked worktree path
 * matches no cache slot.
 *
 * So only an explicit PATH is honored as given, because only a path can name a
 * repo outside this project. Everything else — no location at all, or a
 * `worktreeId`, which necessarily resolves inside the current project and yields
 * a linked-worktree path — patches the current project root instead; otherwise
 * the optimistic assign/unassign update is silently dropped. If an explicit path
 * isn't a project root the patch simply finds nothing.
 */
function assigneeCachePath(location: WorktreeLocationArgs, resolvedCwd: string): string | null {
  if (location.worktreePath || location.cwd) return resolvedCwd;
  return useProjectStore.getState().currentProject?.path ?? null;
}

/**
 * Reflect an assign/unassign in the cached issue lists so the toolbar dropdown
 * updates immediately (#11087). Driven by the forge's own resulting assignee
 * list rather than the requested username: a forge silently drops an assignee
 * the account can't take, so trusting the request would show a membership that
 * never landed. The list also carries the account's avatar, which the request
 * alone never had.
 *
 * Best-effort by design: the forge mutation has already succeeded by the time
 * this runs, so a cache-layer throw must never surface as a failed action.
 */
function syncAssigneeCache(
  projectPath: string | null,
  issueNumber: number,
  username: string,
  assignees: readonly Pick<ForgeUser, "login" | "avatarUrl">[]
): void {
  if (!projectPath) return;
  const match = username.trim().toLowerCase();
  const landed = assignees.find((a) => a.login.trim().toLowerCase() === match);
  try {
    patchIssueAssigneeCache(
      projectPath,
      issueNumber,
      { login: landed?.login ?? username, avatarUrl: landed?.avatarUrl },
      landed !== undefined
    );
  } catch (err) {
    logError("Failed to patch issue cache after assignment change", err);
  }
}

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
    .describe(
      "Opaque pagination cursor — pass the previous response's `nextCursor` to fetch the next page."
    ),
  // 100 is the tightest page ceiling across the provider roster, so it is the
  // largest request every provider can serve in one round trip.
  perPage: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Rows per page, 1-100 (default: 20)."),
  sort: z.enum(["created", "updated"]).optional().describe("Sort field (default: created)."),
  direction: z.enum(["asc", "desc"]).optional().describe("Sort direction (default: desc)."),
  // The only escape hatch from a warm list cache. Without it an out-of-band
  // change — the user running a forge CLI in a terminal, another agent closing
  // an issue — stays invisible until the cached page ages out, and the agent
  // has no way to ask for the truth. Mirrors `forge.getRepoStats`.
  bypassCache: z
    .boolean()
    .optional()
    .describe(
      "Skip the provider's list cache and fetch fresh (default: false). Use after the list may have changed outside this app; costs a provider round trip, so leave it off for ordinary paging."
    ),
  view: ForgeListViewSchema,
});

const ForgeListOptionsSchema = ForgeListPagingSchema.extend({
  state: z.enum(["open", "closed", "all"]).optional().describe("State filter (default: open)"),
  search: z
    .string()
    .optional()
    .describe(
      "Provider-native query fragment — NOT a plain-text filter. The dialect is the active provider's own issue search, which typically supports negation: 'no:assignee -label:human-review'. It is trimmed and appended after the generated repo/type/state/sort qualifiers, and truncated to the provider's query-length cap. Routes via the provider's search API, which caps result depth."
    ),
}).strict();

// PR listing adds `merged` to the state filter — pull requests have a merged
// state that issues don't. `search` was absent here until a provider could
// honor it (#11897); the GitHub provider now routes PR listing through the
// same search API the issue path uses, so the key is admitted rather than
// rejected. The dialect differs from the issue one — PR state is expressed
// with `is:` qualifiers, since GitHub's `state:` only accepts open/closed for
// pull requests — but the fragment is passed through unparsed either way.
const ForgePRListOptionsSchema = ForgeListPagingSchema.extend({
  state: z
    .enum(["open", "closed", "merged", "all"])
    .optional()
    .describe("State filter (default: open)"),
  search: z
    .string()
    .optional()
    .describe(
      "Provider-native query fragment — NOT a plain-text filter. The dialect is the active provider's own pull-request search, which typically supports negation and PR-specific qualifiers: 'is:draft -label:wip'. It is trimmed and appended after the generated repo/type/state/sort qualifiers, and truncated to the provider's query-length cap. Routes via the provider's search API, which caps result depth."
    ),
}).strict();

// A forge label, as both the write actions and the issue result describe it.
const ForgeLabelResultSchema = z.object({ name: z.string(), color: z.string().optional() });

/**
 * A forge user, minus `rawData`. `ForgeUser` carries the provider's entire
 * unnormalized node on that field, so an `z.array(z.unknown())` assignee arm
 * shipped every GitHub/GitLab user attribute to agents unannounced (#11539).
 * Naming the two portable fields is what drops it — dispatch strips the rest.
 */
const ForgeUserResultSchema = z.object({
  login: z.string(),
  avatarUrl: z.string().optional(),
});

// Compact projection of the PR an issue links to, mirroring `LinkedPRSummary`.
const ForgeLinkedPRResultSchema = z.object({
  number: z.number(),
  state: z.string(),
  url: z.string(),
  ciStatus: z.string().optional(),
});

// Normalized PR shape returned by getPR/createPR/editPR. Every cross-provider
// field of `PR` is named except `rawData`, the verbatim provider node — dispatch
// parses results now (#11539), so an omission here is a field an agent stops
// receiving, not just one the manifest fails to mention. `reviewDecision` and
// `ciStatus` in particular are what a caller reads to judge a PR.
//
// Fields the `PR` interface marks required (`rawState`, `createdAt`, `updatedAt`)
// are declared optional anyway: providers are plugins, and a value the host never
// verifies should degrade to an absent key rather than reject the whole result.
const ForgePRResultSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string(),
  state: z.string(),
  rawState: z.string().optional().describe("The forge's own spelling of the state"),
  isDraft: z.boolean(),
  merged: z.boolean(),
  url: z.string(),
  author: ForgeUserResultSchema.optional(),
  baseRef: z.string(),
  headRef: z.string(),
  mergeable: z
    .boolean()
    .nullable()
    .optional()
    .describe("null when the provider has not computed mergeability yet"),
  // `null` is a real answer — "this provider gates on no review" — and readers
  // treat it as equivalent to approved. Only `undefined` ("not reported") drops.
  reviewDecision: z
    .string()
    .nullable()
    .optional()
    .describe("APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or null when reviews aren't gated"),
  ciStatus: z
    .string()
    .optional()
    .describe("Roll-up head-commit CI state: success, failure, pending, neutral or unknown"),
  commentCount: z.number().optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
  closedAt: z.number().nullable().optional(),
  mergedAt: z.number().nullable().optional(),
});

// Roll-up CI state vocabulary, mirroring `CIStatusState`. `neutral` means the
// PR has no required checks configured; `unknown` means the provider reported
// checks whose state doesn't map onto the other four.
const ForgeCIStatusStateSchema = z.enum(["success", "failure", "pending", "neutral", "unknown"]);

const ForgeCIStatusSchema = z.object({
  state: ForgeCIStatusStateSchema,
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  requiredChecksPassing: z.boolean().optional(),
});

// Wrapped rather than a bare `.nullable()` so the MCP output schema stays
// object-typed: `buildToolOutputSchema` drops any schema whose top-level `type`
// isn't "object", and Zod emits `anyOf` for a nullable object — which would
// silently advertise no schema at all.
const ForgeCIStatusActionResultSchema = z.object({
  ciStatus: ForgeCIStatusSchema.nullable(),
});

// One CI check, mirroring `CheckRun` minus `rawData` — which dispatch strips,
// and which the IPC layer already dropped. `conclusion` is absent while a check
// is unfinished AND when the provider reported an outcome this vocabulary
// doesn't model, so its absence never means "passed".
const ForgeCheckRunSchema = z.object({
  name: z.string().describe("Check name as the forge reports it; matrix jobs repeat names"),
  status: z.enum(["queued", "in_progress", "completed"]),
  conclusion: z
    .enum(["success", "failure", "neutral", "cancelled", "timed_out", "action_required", "skipped"])
    .optional()
    .describe("Outcome once completed; absent while running or when the forge reported no verdict"),
  required: z
    .boolean()
    .optional()
    .describe("Whether this check gates merging, when the provider reports required checks"),
  detailsUrl: z.string().optional().describe("Link to this check's output or job log"),
});

// Wrapped for the same reason as `ForgeCIStatusActionResultSchema` — a bare
// nullable array would emit a top-level `anyOf` that `buildToolOutputSchema`
// drops, advertising no schema at all.
const ForgeChecksActionResultSchema = z.object({
  checks: z.array(ForgeCheckRunSchema).nullable(),
});

// Normalized issue returned by `forge.getIssue` and by the
// create/close/reopen/edit write actions. Same reasoning as
// `ForgePRResultSchema`: every cross-provider field of `Issue` bar `rawData` is
// named, because dispatch strips whatever isn't. `author` and `commentCount` are
// both promised by action descriptions, so omitting them made those false.
const ForgeIssueResultSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string(),
  state: z.string(),
  rawState: z.string().optional().describe("The forge's own spelling of the state"),
  url: z.string(),
  author: ForgeUserResultSchema.optional(),
  labels: z.array(ForgeLabelResultSchema).optional(),
  assignees: z.array(ForgeUserResultSchema).optional(),
  commentCount: z.number().optional(),
  linkedPR: ForgeLinkedPRResultSchema.optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
  closedAt: z.number().nullable().optional(),
});

// Label set returned by the add/remove-label write actions.
const ForgeLabelArrayResultSchema = z.array(ForgeLabelResultSchema);

// Comment returned by the add-comment write action.
const ForgeCommentResultSchema = z.object({
  id: z.string(),
  body: z.string(),
  url: z.string(),
  createdAt: z.number(),
});

// Resulting assignee list after an assign/unassign. The list is authoritative:
// forges silently drop assignees the account can't take, so it can omit the
// username that was just requested.
const ForgeAssigneesResultSchema = z.object({
  issueNumber: z.number(),
  assignees: z.array(ForgeUserResultSchema),
});

// Review created (or dismissed) by the review-write actions.
const ForgeReviewResultSchema = z.object({
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
const ForgeRequestedReviewersResultSchema = z.object({
  prNumber: z.number(),
  requestedUsers: z.array(z.string()),
  requestedTeams: z.array(z.string()),
});

// Merge acknowledgement. Deliberately narrow — a merge endpoint reports whether
// the merge landed and under which commit, not the resulting pull request.
const ForgeMergePRResultSchema = z.object({
  prNumber: z.number(),
  sha: z.string().nullable().describe("Merge commit SHA, or null when the forge reports none"),
  merged: z.boolean(),
  message: z.string(),
});

// Draft state a PR ended in after a draft-toggle action.
const ForgePRDraftStateResultSchema = z.object({
  prNumber: z.number(),
  isDraft: z.boolean(),
});

// One page of an issue's comment thread, from the read action. Reuses the
// single-comment shape so the read and write halves describe a comment
// identically, plus the author the write action doesn't echo back.
const ForgeCommentPageResultSchema = z.object({
  items: z.array(ForgeCommentResultSchema.extend({ author: ForgeUserResultSchema.optional() })),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  totalCount: z.number().optional(),
});

// Provider-agnostic forge action surface. Each action calls forgeClient (the
// provider-agnostic IPC wrapper); provider routing is resolved at the IPC
// layer in electron/ipc/handlers/forge.ts, so these run() bodies stay
// provider-agnostic.
export function registerForgeActions(actions: ActionRegistry, _callbacks: ActionCallbacks): void {
  actions.set("forge.openIssues", () =>
    defineAction({
      id: "forge.openIssues",
      title: "Open Issues",
      description:
        "Open the forge's issue list for this project in the system browser, for a human to read. This hands off to another application rather than returning data — use the issue-listing capability to actually retrieve issues.",
      category: "forge",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: withProjectLocation({
        query: z.string().optional(),
        state: z.string().optional(),
      }).optional(),
      run: async (args, ctx) => {
        // An explicit selector is resolved (or rejected) by the resolver, so this
        // fallback only applies when the caller named no project at all.
        const path =
          resolveProjectLocation(args, ctx).projectPath ??
          useProjectStore.getState().currentProject?.path;
        if (!path) {
          throw new Error("No project path available to open issues");
        }
        await forgeClient.openIssues(path, args?.query, args?.state);
      },
    })
  );

  actions.set("forge.openPRs", () =>
    defineAction({
      id: "forge.openPRs",
      title: "Open Pull Requests",
      description:
        "Open the forge's pull-request list for this project in the system browser, for a human to read. This hands off to another application rather than returning data — use the pull-request listing capability to actually retrieve PRs.",
      category: "forge",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: withProjectLocation({
        query: z.string().optional(),
        state: z.string().optional(),
      }).optional(),
      run: async (args, ctx) => {
        // An explicit selector is resolved (or rejected) by the resolver, so this
        // fallback only applies when the caller named no project at all.
        const path =
          resolveProjectLocation(args, ctx).projectPath ??
          useProjectStore.getState().currentProject?.path;
        if (!path) {
          throw new Error("No project path available to open pull requests");
        }
        await forgeClient.openPRs(path, args?.query, args?.state);
      },
    })
  );

  actions.set("forge.openCommits", () =>
    defineAction({
      id: "forge.openCommits",
      title: "Open Commits",
      description:
        "Open the forge's commit history for this project in the system browser, for a human to read. This hands off to another application rather than returning data — use a git history capability to actually retrieve commits.",
      category: "forge",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: withProjectLocation({ branch: z.string().optional() }).optional(),
      run: async (args, ctx) => {
        // An explicit selector is resolved (or rejected) by the resolver, so this
        // fallback only applies when the caller named no project at all.
        const path =
          resolveProjectLocation(args, ctx).projectPath ??
          useProjectStore.getState().currentProject?.path;
        if (!path) {
          throw new Error("No project path available to open commits");
        }
        await forgeClient.openCommits(path, args?.branch);
      },
    })
  );

  actions.set("forge.openIssue", () =>
    defineAction({
      id: "forge.openIssue",
      title: "Open Issue",
      description:
        "Open one issue on the forge in the system browser, for a human to read. This hands off to another application rather than returning data — use the single-issue lookup to retrieve its title, body or state.",
      category: "forge",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({
        ...worktreeLocationShape({ legacy: ["cwd"] }),
        issueNumber: z.number().int().positive(),
      }),
      run: async ({ issueNumber, ...location }, ctx: ActionContext) => {
        const resolvedCwd = requireWorktreePath(location, ctx);
        await forgeClient.openIssue(resolvedCwd, issueNumber);
      },
    })
  );

  actions.set("forge.openPR", () =>
    defineAction({
      id: "forge.openPR",
      title: "Open pull request",
      description:
        "Open one pull request on the forge in the system browser, for a human to read. This hands off to another application rather than returning data — use the single-PR lookup to retrieve its title, body or state.",
      category: "forge",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({
        ...worktreeLocationShape({ legacy: ["cwd"] }),
        prNumber: z.number().int().positive(),
      }),
      run: async ({ prNumber, ...location }, ctx: ActionContext) => {
        const resolvedCwd = requireWorktreePath(location, ctx);
        await forgeClient.openPR(resolvedCwd, prNumber);
      },
    })
  );

  actions.set("forge.assignIssue", () =>
    defineAction({
      id: "forge.assignIssue",
      title: "Assign Issue",
      description:
        "Assign an issue to a user on the active forge. Read back the resulting assignee list rather than assuming the request applied in full: forges silently drop accounts that lack access to the repository, so the returned list is what actually landed. Assigning someone already assigned is harmless.",
      category: "forge",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({
        ...worktreeLocationShape({ legacy: ["cwd"] }),
        issueNumber: z.number().int().positive(),
        username: z.string().min(1).describe("Account to assign the issue to"),
      }),
      resultSchema: ForgeAssigneesResultSchema,
      mcpOutputSchema: true,
      run: async ({ issueNumber, username, ...location }, ctx: ActionContext) => {
        const resolvedCwd = requireWorktreePath(location, ctx);
        const assignees = await forgeClient.assignIssue(resolvedCwd, issueNumber, username);
        const result = ForgeAssigneesResultSchema.parse({ issueNumber, assignees });
        syncAssigneeCache(
          assigneeCachePath(location, resolvedCwd),
          issueNumber,
          username,
          result.assignees
        );
        return result;
      },
    })
  );

  actions.set("forge.unassignIssue", () =>
    defineAction({
      id: "forge.unassignIssue",
      title: "Unassign Issue",
      description:
        "Remove one user's assignment from an issue on the active forge. Read back the resulting assignee list to confirm what remains. Removing someone who was not assigned is harmless rather than an error, so this is safe to call without checking first.",
      category: "forge",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({
        ...worktreeLocationShape({ legacy: ["cwd"] }),
        issueNumber: z.number().int().positive(),
        username: z.string().min(1).describe("Account whose assignment should be removed"),
      }),
      resultSchema: ForgeAssigneesResultSchema,
      mcpOutputSchema: true,
      run: async ({ issueNumber, username, ...location }, ctx: ActionContext) => {
        const resolvedCwd = requireWorktreePath(location, ctx);
        const assignees = await forgeClient.unassignIssue(resolvedCwd, issueNumber, username);
        const result = ForgeAssigneesResultSchema.parse({ issueNumber, assignees });
        syncAssigneeCache(
          assigneeCachePath(location, resolvedCwd),
          issueNumber,
          username,
          result.assignees
        );
        return result;
      },
    })
  );

  actions.set("forge.approvePR", () =>
    defineAction({
      id: "forge.approvePR",
      title: "Approve Pull Request",
      description:
        "Submit an approving review on a pull request, visible to everyone watching it on the forge. This is a public act of sign-off, so read the PR first. The forge rejects approvals it does not permit — approving your own pull request, most commonly — and a provider with no review support fails outright rather than silently doing nothing.",
      category: "forge",
      kind: "command",
      danger: "confirm",
      dangerRationale:
        "Submits an approving review to the remote forge. Retracting it requires dismissing the review.",
      scope: "renderer",
      argsSchema: z.object({
        ...worktreeLocationShape({ legacy: ["cwd"] }),
        prNumber: z.number().int().positive().describe("Pull request number to approve"),
        body: z.string().optional().describe("Optional approval comment"),
      }),
      resultSchema: ForgeReviewResultSchema,
      mcpOutputSchema: true,
      run: async ({ prNumber, body, ...location }, ctx: ActionContext) => {
        const resolvedCwd = requireWorktreePath(location, ctx);
        return ForgeReviewResultSchema.parse(
          await forgeClient.approvePR(resolvedCwd, prNumber, body)
        );
      },
    })
  );

  actions.set("forge.requestChanges", () =>
    defineAction({
      id: "forge.requestChanges",
      title: "Request Changes on Pull Request",
      description:
        "Submit a request-changes review on a pull request, which blocks merging on most forges until it is resolved. This is publicly visible and requires an explanatory body, so write the reasoning for the author. A provider without review support fails rather than silently doing nothing.",
      category: "forge",
      kind: "command",
      danger: "confirm",
      dangerRationale:
        "Submits a request-changes review to the remote forge. Blocks the PR until addressed or dismissed.",
      scope: "renderer",
      argsSchema: z.object({
        ...worktreeLocationShape({ legacy: ["cwd"] }),
        prNumber: z.number().int().positive().describe("Pull request number to review"),
        body: z.string().trim().min(1).describe("Explanation of the changes being requested"),
      }),
      resultSchema: ForgeReviewResultSchema,
      mcpOutputSchema: true,
      run: async ({ prNumber, body, ...location }, ctx: ActionContext) => {
        const resolvedCwd = requireWorktreePath(location, ctx);
        return ForgeReviewResultSchema.parse(
          await forgeClient.requestChanges(resolvedCwd, prNumber, body)
        );
      },
    })
  );

  actions.set("forge.dismissReview", () =>
    defineAction({
      id: "forge.dismissReview",
      title: "Dismiss Pull Request Review",
      description:
        "Dismiss a submitted review on a pull request, clearing the block it placed on merging. This is publicly visible, usually needs elevated permissions, and requires a message explaining why. Identify the review by the forge's own review id, which nothing on this surface can list — dismissing the wrong one silently unblocks a merge someone intended to gate.",
      category: "forge",
      kind: "command",
      danger: "confirm",
      dangerRationale: "Dismisses a submitted review on the remote forge. Cannot be undone.",
      scope: "renderer",
      argsSchema: z.object({
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
      }),
      resultSchema: ForgeReviewResultSchema,
      mcpOutputSchema: true,
      run: async ({ prNumber, reviewId, message, ...location }, ctx: ActionContext) => {
        const resolvedCwd = requireWorktreePath(location, ctx);
        return ForgeReviewResultSchema.parse(
          await forgeClient.dismissReview(resolvedCwd, prNumber, reviewId, message)
        );
      },
    })
  );

  actions.set("forge.requestReviewers", () =>
    defineAction({
      id: "forge.requestReviewers",
      title: "Request Pull Request Reviewers",
      description:
        "Request reviewers on a pull request, notifying each of them on the forge. Supply at least one account or team. Read back the resulting request list rather than assuming it applied: it includes reviewers requested earlier and omits any the forge refused, typically for lacking repository access.",
      category: "forge",
      kind: "command",
      danger: "confirm",
      dangerRationale:
        "Requests reviewers on the remote forge and notifies them. Undone by removing the request.",
      scope: "renderer",
      argsSchema: z
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
        }),
      resultSchema: ForgeRequestedReviewersResultSchema,
      mcpOutputSchema: true,
      run: async ({ prNumber, users, teams, ...location }, ctx: ActionContext) => {
        const resolvedCwd = requireWorktreePath(location, ctx);
        return ForgeRequestedReviewersResultSchema.parse(
          await forgeClient.requestReviewers(resolvedCwd, prNumber, { users, teams })
        );
      },
    })
  );

  actions.set("forge.validateToken", () =>
    defineAction({
      id: "forge.validateToken",
      title: "Validate Forge Token",
      description:
        "Check whether a forge access token is accepted by the provider, without storing it anywhere. Use this to verify credentials before saving them. It performs a live authentication round trip, so a rejection may mean an expired or insufficiently scoped token rather than a malformed one.",
      category: "forge",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({
        // `providerId` carries the canonical `{pluginId}.{contributionId}`
        // id of the forge to validate against, so the Test button in a
        // provider-specific settings tab can never silently route to the
        // wrong forge (#9985).
        providerId: z.string().min(1).describe("Canonical forge provider id"),
        token: z.string(),
      }),
      resultSchema: z.object({
        valid: z.boolean(),
        scopes: z.array(z.string()).optional(),
        expiresAt: z.number().nullable().optional(),
        error: z.string().optional(),
      }),
      run: async ({ providerId, token }) => {
        return await forgeClient.validateToken(providerId, token);
      },
    })
  );

  actions.set("forge.getRepoStats", () =>
    defineAction({
      id: "forge.getRepoStats",
      title: "Get Repo Stats",
      description:
        "Get headline repository counts — commits, issues and pull requests — from the active forge provider. Use this for a cheap overview rather than paging a list to count it. Results are cached and may be stale; bypassing the cache costs a live provider round trip against your rate limit. A provider failure comes back as an error field on an otherwise valid result rather than failing the call, so check it before trusting the counts.",
      category: "forge",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({
        ...worktreeLocationShape({ legacy: ["cwd"] }),
        bypassCache: z.boolean().optional(),
      }),
      resultSchema: z.object({
        commitCount: z.number(),
        issueCount: z.number().nullable(),
        prCount: z.number().nullable(),
        loading: z.boolean(),
        error: z.string().optional(),
        stale: z.boolean().optional(),
        lastUpdated: z.number().optional(),
        rateLimitResetAt: z.number().optional(),
        rateLimitKind: z.string().optional(),
      }),
      run: async ({ bypassCache, ...location }, ctx: ActionContext) => {
        const resolvedCwd = requireWorktreePath(location, ctx);
        return await forgeClient.getRepoStats(resolvedCwd, bypassCache);
      },
    })
  );

  actions.set("forge.listIssues", () =>
    defineAction({
      id: "forge.listIssues",
      title: "List Issues",
      description:
        "List repository issues from the active forge provider, one page at a time. Use this to discover or filter issues; use the pull-request listing for PRs, and the single-issue lookup when the number is already known. Summary results keep responses small by dropping bodies and raw provider payloads — ask for full results only when the body is needed. Results are cached, and bypassing the cache spends a live provider round trip against your rate limit.",
      category: "forge",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: ForgeListOptionsSchema,
      resultSchema: ForgeIssuePageResultSchema,
      run: async (
        { search, state, cursor, perPage, sort, direction, bypassCache, view, ...location },
        ctx: ActionContext
      ) => {
        const resolvedCwd = requireWorktreePath(location, ctx);
        const page = await forgeClient.listIssues(resolvedCwd, {
          search,
          state,
          cursor,
          perPage,
          sort,
          direction,
          bypassCache,
        });
        // `view` is action-local presentation: it never reaches the provider,
        // so it must not participate in provider cache identity either.
        return projectForgePage(page, view ?? "summary", projectIssueSummary);
      },
    })
  );

  actions.set("forge.listPRs", () =>
    defineAction({
      id: "forge.listPRs",
      title: "List Pull Requests",
      description:
        "List repository pull requests from the active forge provider, one page at a time. Use this to discover or filter PRs; use the issue listing for issues, and the single-PR lookup when the number is already known. Search takes a provider-native query fragment rather than plain text and routes through the provider's search API, which isn't served from the list cache that pagination uses. Summary results keep responses small, and bypassing the cache spends a live provider round trip.",
      category: "forge",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: ForgePRListOptionsSchema,
      resultSchema: ForgePRPageResultSchema,
      run: async (
        { search, state, cursor, perPage, sort, direction, bypassCache, view, ...location },
        ctx: ActionContext
      ) => {
        const resolvedCwd = requireWorktreePath(location, ctx);
        const page = await forgeClient.listPRs(resolvedCwd, {
          search,
          state,
          cursor,
          perPage,
          sort,
          direction,
          bypassCache,
        });
        return projectForgePage(page, view ?? "summary", projectPRSummary);
      },
    })
  );

  actions.set("forge.getIssue", () =>
    defineAction({
      id: "forge.getIssue",
      title: "Get Issue",
      description:
        "Fetch one issue by number from the active forge provider, including its body. This is the direct lookup — reach for it instead of paging the issue listing to find a number you already have. An issue that does not exist comes back empty rather than failing, so treat an empty result as absence rather than an error. It reports how many comments exist but not their text; read the comment thread for that.",
      category: "forge",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({
        ...worktreeLocationShape({ legacy: ["cwd"] }),
        issueNumber: z.number().int().positive().describe("Issue number to fetch"),
      }),
      examples: [
        {
          args: { issueNumber: 42 },
          description: "Fetch issue #42 from the active worktree's repo",
        },
        {
          args: { issueNumber: 100, cwd: "/path/to/repo" },
          description: "Fetch issue #100 from a specific repo",
        },
      ],
      // The same normalized issue the write actions return — one shape for one
      // provider object, so the read and write halves cannot drift.
      resultSchema: ForgeIssueResultSchema.nullable(),
      run: async ({ issueNumber, ...location }, ctx: ActionContext) => {
        const resolvedCwd = requireWorktreePath(location, ctx);
        return await forgeClient.getIssue(resolvedCwd, issueNumber);
      },
    })
  );

  actions.set("forge.listIssueComments", () =>
    defineAction({
      id: "forge.listIssueComments",
      title: "List Issue Comments",
      description:
        "Read one page of an issue's comment thread from the active forge provider. Use this when comment text matters — the single-issue lookup reports only how many comments exist. Comments arrive oldest first, so reaching the newest reply means paging to the end rather than reading the first page. An empty page genuinely means nobody has commented: a missing issue or a provider that cannot read threads fails instead, so silence is never ambiguous.",
      category: "forge",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({
        ...worktreeLocationShape({ legacy: ["cwd"] }),
        issueNumber: z.number().int().positive().describe("Issue number whose comments to read"),
        cursor: z
          .string()
          .optional()
          .describe(
            "Opaque pagination cursor — pass the previous response's `nextCursor` to fetch the next page."
          ),
        perPage: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Comments per page (1-100, default 20)"),
      }),
      examples: [
        {
          args: { issueNumber: 42 },
          description: "Read the first page of comments on issue #42",
        },
        {
          args: { issueNumber: 42, cursor: "Y3Vyc29yOnYyOpHOAAAAAQ==", perPage: 50 },
          description: "Read the next 50 comments after a previous page's `nextCursor`",
        },
      ],
      resultSchema: ForgeCommentPageResultSchema,
      run: async ({ issueNumber, cursor, perPage, ...location }, ctx: ActionContext) => {
        const resolvedCwd = requireWorktreePath(location, ctx);
        return await forgeClient.listIssueComments(resolvedCwd, issueNumber, { cursor, perPage });
      },
    })
  );

  actions.set("forge.getPR", () =>
    defineAction({
      id: "forge.getPR",
      title: "Get Pull Request",
      description:
        "Fetch one pull request by number from the active forge provider, including its body, draft state and branches. This is the direct lookup — reach for it instead of paging the PR listing for a number you already have, and read it before editing or merging so the current state is known. A pull request that does not exist comes back empty rather than failing, so treat an empty result as absence rather than an error.",
      category: "forge",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({
        ...worktreeLocationShape({ legacy: ["cwd"] }),
        prNumber: z.number().int().positive().describe("Pull request number to fetch"),
      }),
      resultSchema: ForgePRResultSchema.nullable(),
      run: async ({ prNumber, ...location }, ctx: ActionContext) => {
        const resolvedCwd = requireWorktreePath(location, ctx);
        return await forgeClient.getPR(resolvedCwd, prNumber);
      },
    })
  );

  actions.set("forge.getCIStatus", () =>
    defineAction({
      id: "forge.getCIStatus",
      title: "Get CI Status",
      description:
        "Fetch the roll-up CI verdict for one pull request from the active forge provider. Read the overall state for the answer: the accompanying counts cover required checks only, and a zero total also appears when the required-check list could not be read in full, so it is never evidence that nothing gates the merge. Values are provider-cached and can lag by around a minute, so poll for a settled verdict rather than treating a single success as final.",
      category: "forge",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({
        ...worktreeLocationShape({ legacy: ["cwd"] }),
        prNumber: z
          .number()
          .int()
          .positive()
          .describe("Pull request number whose CI status to fetch"),
      }),
      examples: [
        {
          args: { prNumber: 42 },
          description: "Check whether PR #42 is green in the active worktree's repo",
        },
      ],
      resultSchema: ForgeCIStatusActionResultSchema,
      mcpOutputSchema: true,
      run: async ({ prNumber, ...location }, ctx: ActionContext) => {
        const resolvedCwd = requireWorktreePath(location, ctx);
        return { ciStatus: await forgeClient.getCIStatus(resolvedCwd, prNumber) };
      },
    })
  );

  actions.set("forge.getChecks", () =>
    defineAction({
      id: "forge.getChecks",
      title: "Get CI Checks",
      description:
        "List every CI check on one pull request — each check's name, whether it is still running, how it finished, and a link to its log where the forge reports one. Reach for it once the roll-up shows trouble and the question becomes which check broke and where to read its output. A check with no conclusion reported has not passed; the roll-up stays the authority on whether a PR is green. An empty list means no checks, a null one no such PR, and a provider that cannot read checks fails instead.",
      category: "forge",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({
        ...worktreeLocationShape({ legacy: ["cwd"] }),
        prNumber: z.number().int().positive().describe("Pull request number whose checks to list"),
      }),
      examples: [
        {
          args: { prNumber: 42 },
          description: "List the checks on PR #42 to find which one failed",
        },
      ],
      resultSchema: ForgeChecksActionResultSchema,
      mcpOutputSchema: true,
      run: async ({ prNumber, ...location }, ctx: ActionContext) => {
        const resolvedCwd = requireWorktreePath(location, ctx);
        const result = await forgeClient.getChecks(resolvedCwd, prNumber);
        return { checks: result === null ? null : result.checks };
      },
    })
  );

  actions.set("forge.createPR", () =>
    defineAction({
      id: "forge.createPR",
      title: "Create pull request",
      description:
        "Open a new pull request between two branches on the active forge. This is publicly visible and notifies watchers, so confirm the branches are pushed and the target is right before calling. The forge rejects the request when the branches do not exist or a pull request already links them.",
      category: "forge",
      kind: "command",
      danger: "confirm",
      dangerRationale:
        "Opens a pull request on the remote forge — a shared-state mutation reviewers and automation react to.",
      scope: "renderer",
      argsSchema: z.object({
        ...worktreeLocationShape({ legacy: ["cwd"] }),
        head: z.string().min(1).describe("Source branch the changes come from"),
        base: z.string().min(1).describe("Target branch the PR merges into"),
        title: z.string().min(1).describe("Pull request title"),
        body: z.string().optional().describe("Pull request body (Markdown)"),
        draft: z.boolean().optional().describe("Open as a draft pull request"),
      }),
      resultSchema: ForgePRResultSchema,
      run: async ({ head, base, title, body, draft, ...location }, ctx: ActionContext) => {
        const resolvedCwd = requireWorktreePath(location, ctx);
        return await forgeClient.createPR(resolvedCwd, { head, base, title, body, draft });
      },
    })
  );

  actions.set("forge.closePR", () =>
    defineAction({
      id: "forge.closePR",
      title: "Close pull request",
      description:
        "Close a pull request without merging it, discarding it as a proposal while leaving its branch intact. This is publicly visible and can be undone by reopening. Use the merge capability when the intent is to land the change instead.",
      category: "forge",
      kind: "command",
      danger: "confirm",
      dangerRationale:
        "Closes a pull request on the remote forge — a shared-state change reviewers and automation react to.",
      scope: "renderer",
      argsSchema: z.object({
        ...worktreeLocationShape({ legacy: ["cwd"] }),
        prNumber: z.number().int().positive().describe("Pull request number to close"),
      }),
      resultSchema: ForgePRResultSchema,
      mcpOutputSchema: true,
      run: async ({ prNumber, ...location }, ctx: ActionContext) => {
        const resolvedCwd = requireWorktreePath(location, ctx);
        return ForgePRResultSchema.parse(await forgeClient.closePR(resolvedCwd, prNumber));
      },
    })
  );

  actions.set("forge.reopenPR", () =>
    defineAction({
      id: "forge.reopenPR",
      title: "Reopen pull request",
      description:
        "Reopen a previously closed pull request, putting it back in the review queue. This is publicly visible. A pull request that was merged, or whose branch has since been deleted, cannot be reopened and the forge rejects the request.",
      category: "forge",
      kind: "command",
      danger: "confirm",
      dangerRationale:
        "Reopens a pull request on the remote forge — a shared-state change reviewers and automation react to.",
      scope: "renderer",
      argsSchema: z.object({
        ...worktreeLocationShape({ legacy: ["cwd"] }),
        prNumber: z.number().int().positive().describe("Pull request number to reopen"),
      }),
      resultSchema: ForgePRResultSchema,
      mcpOutputSchema: true,
      run: async ({ prNumber, ...location }, ctx: ActionContext) => {
        const resolvedCwd = requireWorktreePath(location, ctx);
        return ForgePRResultSchema.parse(await forgeClient.reopenPR(resolvedCwd, prNumber));
      },
    })
  );

  actions.set("forge.mergePR", () =>
    defineAction({
      id: "forge.mergePR",
      title: "Merge pull request",
      description:
        "Merge a pull request, writing its commits onto the shared base branch. This is irreversible and affects everyone working from that branch — confirm the CI verdict and the review state first. The forge rejects the merge when the pull request is not mergeable, so a failure here usually means conflicts or unsatisfied checks rather than a bad request.",
      category: "forge",
      kind: "command",
      danger: "confirm",
      dangerRationale:
        "Merging a pull request is irreversible and writes the change into the shared base branch.",
      scope: "renderer",
      argsSchema: z.object({
        ...worktreeLocationShape({ legacy: ["cwd"] }),
        prNumber: z.number().int().positive().describe("Pull request number to merge"),
        mergeMethod: z
          .enum(["merge", "squash", "rebase"])
          .optional()
          .describe("Merge strategy (provider default when omitted)"),
        commitTitle: z.string().optional().describe("Override the merge commit title"),
        commitMessage: z.string().optional().describe("Override the merge commit message"),
      }),
      resultSchema: ForgeMergePRResultSchema,
      mcpOutputSchema: true,
      run: async (
        { prNumber, mergeMethod, commitTitle, commitMessage, ...location },
        ctx: ActionContext
      ) => {
        const resolvedCwd = requireWorktreePath(location, ctx);
        return ForgeMergePRResultSchema.parse(
          await forgeClient.mergePR(resolvedCwd, prNumber, {
            mergeMethod,
            commitTitle,
            commitMessage,
          })
        );
      },
    })
  );

  actions.set("forge.createIssue", () =>
    defineAction({
      id: "forge.createIssue",
      title: "Create Issue",
      description:
        "File a new issue on the active forge. This is publicly visible and notifies watchers. Labels must already exist on the repository — the forge rejects the request rather than creating them, so confirm the names first.",
      category: "forge",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({
        ...worktreeLocationShape({ legacy: ["cwd"] }),
        title: z.string().min(1).describe("Issue title"),
        body: z.string().optional().describe("Issue body (markdown)"),
        labels: z.array(z.string()).optional().describe("Label names to apply on creation"),
      }),
      examples: [
        {
          args: { title: "Crash on startup", body: "Steps to reproduce: ..." },
          description: "Create an issue in the active worktree's repo",
        },
      ],
      resultSchema: ForgeIssueResultSchema,
      run: async ({ title, body, labels, ...location }, ctx: ActionContext) => {
        const resolvedCwd = requireWorktreePath(location, ctx);
        return await forgeClient.createIssue(resolvedCwd, { title, body, labels });
      },
    })
  );

  actions.set("forge.convertPRToDraft", () =>
    defineAction({
      id: "forge.convertPRToDraft",
      title: "Convert pull request to draft",
      description:
        "Mark an open pull request as a draft, signalling it is not ready and removing it from most review queues. This is publicly visible and reversible by marking it ready again. A provider without draft support fails rather than silently doing nothing.",
      category: "forge",
      kind: "command",
      danger: "confirm",
      dangerRationale:
        "Changes a pull request's review state on the remote forge — reviewers and automation react to it.",
      scope: "renderer",
      argsSchema: z.object({
        ...worktreeLocationShape({ legacy: ["cwd"] }),
        prNumber: z.number().int().positive().describe("Pull request number to convert to draft"),
      }),
      resultSchema: ForgePRDraftStateResultSchema,
      mcpOutputSchema: true,
      run: async ({ prNumber, ...location }, ctx: ActionContext) => {
        const resolvedCwd = requireWorktreePath(location, ctx);
        return ForgePRDraftStateResultSchema.parse(
          await forgeClient.convertPRToDraft(resolvedCwd, prNumber)
        );
      },
    })
  );

  actions.set("forge.closeIssue", () =>
    defineAction({
      id: "forge.closeIssue",
      title: "Close Issue",
      description:
        "Close an issue on the active forge, optionally recording why it was closed. This is publicly visible and reversible by reopening. Prefer stating a reason, since it distinguishes finished work from something declined or duplicated.",
      category: "forge",
      kind: "command",
      danger: "confirm",
      dangerRationale:
        "Closes an issue on the shared forge — a state change other collaborators see; undoing it requires a deliberate reopen.",
      scope: "renderer",
      argsSchema: z.object({
        ...worktreeLocationShape({ legacy: ["cwd"] }),
        issueNumber: z.number().int().positive().describe("Issue number to close"),
        stateReason: z
          .enum(["completed", "not_planned", "duplicate"])
          .optional()
          .describe("Why the issue is being closed (default: completed)"),
      }),
      resultSchema: ForgeIssueResultSchema,
      run: async ({ issueNumber, stateReason, ...location }, ctx: ActionContext) => {
        const resolvedCwd = requireWorktreePath(location, ctx);
        return await forgeClient.closeIssue(resolvedCwd, issueNumber, stateReason);
      },
    })
  );

  actions.set("forge.markPRReadyForReview", () =>
    defineAction({
      id: "forge.markPRReadyForReview",
      title: "Mark pull request ready for review",
      description:
        "Mark a draft pull request as ready for review, which notifies reviewers and re-enters it in review queues. This is publicly visible and reversible by converting it back to a draft.",
      category: "forge",
      kind: "command",
      danger: "confirm",
      dangerRationale:
        "Changes a pull request's review state on the remote forge, notifying reviewers.",
      scope: "renderer",
      argsSchema: z.object({
        ...worktreeLocationShape({ legacy: ["cwd"] }),
        prNumber: z.number().int().positive().describe("Pull request number to mark ready"),
      }),
      resultSchema: ForgePRDraftStateResultSchema,
      mcpOutputSchema: true,
      run: async ({ prNumber, ...location }, ctx: ActionContext) => {
        const resolvedCwd = requireWorktreePath(location, ctx);
        return ForgePRDraftStateResultSchema.parse(
          await forgeClient.markPRReadyForReview(resolvedCwd, prNumber)
        );
      },
    })
  );

  actions.set("forge.reopenIssue", () =>
    defineAction({
      id: "forge.reopenIssue",
      title: "Reopen Issue",
      description:
        "Reopen a closed issue, putting it back in the active queue and notifying watchers. This is publicly visible and reversible by closing it again.",
      category: "forge",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({
        ...worktreeLocationShape({ legacy: ["cwd"] }),
        issueNumber: z.number().int().positive().describe("Issue number to reopen"),
      }),
      resultSchema: ForgeIssueResultSchema,
      run: async ({ issueNumber, ...location }, ctx: ActionContext) => {
        const resolvedCwd = requireWorktreePath(location, ctx);
        return await forgeClient.reopenIssue(resolvedCwd, issueNumber);
      },
    })
  );

  actions.set("forge.commentOnPR", () =>
    defineAction({
      id: "forge.commentOnPR",
      title: "Comment on pull request",
      description:
        "Post a comment on a pull request, visible to everyone watching it and delivered as a notification. Comments cannot be edited or withdrawn through this capability, so treat posting as final.",
      category: "forge",
      kind: "command",
      danger: "confirm",
      dangerRationale:
        "Posts a public comment on a pull request that participants are notified about.",
      scope: "renderer",
      argsSchema: z.object({
        ...worktreeLocationShape({ legacy: ["cwd"] }),
        prNumber: z.number().int().positive().describe("Pull request number to comment on"),
        body: z.string().min(1).describe("Comment body (Markdown)"),
      }),
      resultSchema: ForgeCommentResultSchema,
      mcpOutputSchema: true,
      run: async ({ prNumber, body, ...location }, ctx: ActionContext) => {
        const resolvedCwd = requireWorktreePath(location, ctx);
        return ForgeCommentResultSchema.parse(
          await forgeClient.commentOnPR(resolvedCwd, prNumber, body)
        );
      },
    })
  );

  actions.set("forge.editPR", () =>
    defineAction({
      id: "forge.editPR",
      title: "Edit pull request",
      description:
        "Change a pull request's title or body on the active forge. Supply at least one of them; whichever is omitted is left as it is, so this cannot accidentally blank a field. The new text replaces the old wholesale rather than appending, and the edit is publicly visible.",
      category: "forge",
      kind: "command",
      danger: "confirm",
      dangerRationale:
        "Edits a pull request's title/body on the remote forge — a shared-state mutation others see.",
      scope: "renderer",
      argsSchema: z
        .object({
          ...worktreeLocationShape({ legacy: ["cwd"] }),
          prNumber: z.number().int().positive().describe("Pull request number to edit"),
          title: z.string().min(1).optional().describe("New pull request title"),
          body: z.string().optional().describe("New pull request body (Markdown)"),
        })
        .refine((v) => v.title !== undefined || v.body !== undefined, {
          message: "Provide a title or body to edit",
        }),
      resultSchema: ForgePRResultSchema,
      run: async ({ prNumber, title, body, ...location }, ctx: ActionContext) => {
        const resolvedCwd = requireWorktreePath(location, ctx);
        return await forgeClient.editPR(resolvedCwd, prNumber, { title, body });
      },
    })
  );

  actions.set("forge.editIssue", () =>
    defineAction({
      id: "forge.editIssue",
      title: "Edit Issue",
      description:
        "Change an issue's title or body on the active forge. Supply at least one of them; whichever is omitted is left as it is, so this cannot accidentally blank a field. The new text replaces the old wholesale rather than appending, and the edit is publicly visible.",
      category: "forge",
      kind: "command",
      danger: "confirm",
      dangerRationale:
        "Overwrites an issue's title/body on the shared forge — the previous text is not recoverable from git or reflog, so it needs a deliberate confirm.",
      scope: "renderer",
      argsSchema: z
        .object({
          ...worktreeLocationShape({ legacy: ["cwd"] }),
          issueNumber: z.number().int().positive().describe("Issue number to edit"),
          title: z.string().optional().describe("New issue title"),
          body: z.string().optional().describe("New issue body (markdown)"),
        })
        .refine((v) => v.title !== undefined || v.body !== undefined, {
          message: "Provide at least one of title or body to edit",
        }),
      resultSchema: ForgeIssueResultSchema,
      run: async ({ issueNumber, title, body, ...location }, ctx: ActionContext) => {
        const resolvedCwd = requireWorktreePath(location, ctx);
        return await forgeClient.editIssue(resolvedCwd, issueNumber, { title, body });
      },
    })
  );

  actions.set("forge.addIssueComment", () =>
    defineAction({
      id: "forge.addIssueComment",
      title: "Add Issue Comment",
      description:
        "Post a comment on an issue, visible to everyone watching it and delivered as a notification. Comments cannot be edited or withdrawn through this capability, so treat posting as final.",
      category: "forge",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({
        ...worktreeLocationShape({ legacy: ["cwd"] }),
        issueNumber: z.number().int().positive().describe("Issue number to comment on"),
        body: z.string().min(1).describe("Comment body (markdown)"),
      }),
      resultSchema: ForgeCommentResultSchema,
      run: async ({ issueNumber, body, ...location }, ctx: ActionContext) => {
        const resolvedCwd = requireWorktreePath(location, ctx);
        return await forgeClient.addIssueComment(resolvedCwd, issueNumber, body);
      },
    })
  );

  actions.set("forge.addIssueLabel", () =>
    defineAction({
      id: "forge.addIssueLabel",
      title: "Add Issue Label",
      description:
        "Add one existing label to an issue. This is additive — labels already on the issue are kept — so read back the returned label set to see the result. The label must already exist on the repository; the forge rejects an unknown name rather than creating it.",
      category: "forge",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({
        ...worktreeLocationShape({ legacy: ["cwd"] }),
        issueNumber: z.number().int().positive().describe("Issue number to label"),
        label: z.string().min(1).describe("Label name to add"),
      }),
      resultSchema: ForgeLabelArrayResultSchema,
      run: async ({ issueNumber, label, ...location }, ctx: ActionContext) => {
        const resolvedCwd = requireWorktreePath(location, ctx);
        return await forgeClient.addIssueLabel(resolvedCwd, issueNumber, label);
      },
    })
  );

  actions.set("forge.removeIssueLabel", () =>
    defineAction({
      id: "forge.removeIssueLabel",
      title: "Remove Issue Label",
      description:
        "Remove one label from an issue. Unlike adding, this fails when the label is not currently on the issue, so check the issue's labels first rather than calling speculatively. Read back the remaining label set to confirm the result.",
      category: "forge",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({
        ...worktreeLocationShape({ legacy: ["cwd"] }),
        issueNumber: z.number().int().positive().describe("Issue number to unlabel"),
        label: z.string().min(1).describe("Label name to remove"),
      }),
      resultSchema: ForgeLabelArrayResultSchema,
      run: async ({ issueNumber, label, ...location }, ctx: ActionContext) => {
        const resolvedCwd = requireWorktreePath(location, ctx);
        return await forgeClient.removeIssueLabel(resolvedCwd, issueNumber, label);
      },
    })
  );
}
