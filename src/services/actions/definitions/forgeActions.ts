import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import { defineAction } from "../defineAction";
import { z } from "zod";
import {
  ForgeCIStatusActionResultSchema,
  ForgeIssueResultSchema,
  ForgeLabelResultSchema,
  ForgePRActionResultSchema,
  ForgePRResultSchema,
  ForgeUserResultSchema,
} from "@shared/types/forgeActionResults";
import {
  ForgeIssuePageResultSchema,
  ForgePRPageResultSchema,
} from "@shared/utils/forgeListProjection";
import {
  FORGE_GET_PRS_MAX,
  FORGE_GET_PRS_MIN,
  ForgeAssigneesResultSchema,
  ForgeCommentResultSchema,
  ForgeDisableAutoMergeResultSchema,
  ForgeEnableAutoMergeResultSchema,
  ForgeMergePRResultSchema,
  ForgePRDraftStateResultSchema,
  ForgeRequestedReviewersResultSchema,
  ForgeReviewResultSchema,
  ForgeListOptionsSchema,
  ForgePRListOptionsSchema,
  addIssueCommentArgsSchema,
  addIssueLabelArgsSchema,
  approvePRArgsSchema,
  assignIssueArgsSchema,
  closeIssueArgsSchema,
  closePRArgsSchema,
  commentOnPRArgsSchema,
  convertPRToDraftArgsSchema,
  createIssueArgsSchema,
  createPRArgsSchema,
  disableAutoMergeArgsSchema,
  dismissReviewArgsSchema,
  editIssueArgsSchema,
  editPRArgsSchema,
  enableAutoMergeArgsSchema,
  getCIStatusArgsSchema,
  getChecksArgsSchema,
  getIssueArgsSchema,
  getPRArgsSchema,
  getPRsArgsSchema,
  getRepoStatsArgsSchema,
  listIssueCommentsArgsSchema,
  markPRReadyForReviewArgsSchema,
  mergePRArgsSchema,
  openCommitsArgsSchema,
  openIssueArgsSchema,
  openIssuesArgsSchema,
  openPRArgsSchema,
  openPRsArgsSchema,
  openRepoArgsSchema,
  removeIssueLabelArgsSchema,
  reopenIssueArgsSchema,
  reopenPRArgsSchema,
  requestChangesArgsSchema,
  requestReviewersArgsSchema,
  unassignIssueArgsSchema,
  validateTokenArgsSchema,
} from "./forgeActionArgs";
import type { ForgeActionRunId } from "./forgeActions.impl";

/**
 * One requested number's outcome, discriminated by `status`.
 *
 * A union rather than one object with three independently optional fields,
 * because an advertised output schema is enforced: the SDK compiles it and
 * validates `structuredContent` against it with AJV. Flat optionals advertised
 * `{status:"found"}` with no `pr`, and `{status:"not_found", pr}`, as valid —
 * contradictions a strict client would have accepted and a model could have
 * expected. Discriminating makes `pr` required exactly where it exists and
 * `reason` required exactly where it means something.
 */
const ForgePRLookupResultSchema = z.discriminatedUnion("status", [
  z.object({
    number: z.number().int().positive(),
    status: z.literal("found").describe("The forge returned this pull request."),
    pr: ForgePRResultSchema,
  }),
  z.object({
    number: z.number().int().positive(),
    status: z
      .literal("not_found")
      .describe("The forge was asked and has no such pull request. This is an answer."),
  }),
  z.object({
    number: z.number().int().positive(),
    status: z
      .literal("unresolved")
      .describe(
        "Nothing was learned about this number — the request failed or was rate-limited. Retriable, and NOT evidence the pull request is missing."
      ),
    reason: z
      .enum(["provider_unsupported", "provider_error"])
      .describe(
        "Why nothing was learned. `provider_error` is a failed or rate-limited request; `provider_unsupported` adds that the provider has no batch lookup at all. Both are retriable."
      ),
  }),
]);

const ForgePRsActionResultSchema = z.object({
  results: z
    .array(ForgePRLookupResultSchema)
    .describe(
      "One entry per requested number, in the order requested. Duplicate numbers collapse to their first occurrence, so this can be shorter than the input."
    ),
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

// Label set returned by the add/remove-label write actions.
const ForgeLabelArrayResultSchema = z.array(ForgeLabelResultSchema);

// One page of an issue's comment thread, from the read action. Reuses the
// single-comment shape so the read and write halves describe a comment
// identically, plus the author the write action doesn't echo back.
const ForgeCommentPageResultSchema = z.object({
  items: z.array(ForgeCommentResultSchema.extend({ author: ForgeUserResultSchema.optional() })),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  totalCount: z.number().optional(),
});

/**
 * Run bodies load on first dispatch (#14270). Every view registers the forge
 * actions at boot for menus, keybindings and the MCP manifest, but an empty
 * view runs none of them. A failed chunk load rejects inside `run`, which
 * ActionService turns into an error result like any other failure.
 */
async function runForgeAction(
  id: ForgeActionRunId,
  args: unknown,
  ctx: ActionContext
): Promise<unknown> {
  const { forgeActionRuns } = await import("./forgeActions.impl");
  return forgeActionRuns[id](args, ctx);
}

export function registerForgeActions(actions: ActionRegistry, _callbacks: ActionCallbacks): void {
  actions.set("forge.openIssues", () =>
    defineAction({
      id: "forge.openIssues",
      title: "Open issues",
      description:
        "Open the forge's issue list for this project in the system browser, for a human to read. This hands off to another application rather than returning data — use the issue-listing capability to actually retrieve issues.",
      category: "forge",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: openIssuesArgsSchema,
      run: (args, ctx) => runForgeAction("forge.openIssues", args, ctx),
    })
  );

  actions.set("forge.openPRs", () =>
    defineAction({
      id: "forge.openPRs",
      title: "Open pull requests",
      description:
        "Open the forge's pull-request list for this project in the system browser, for a human to read. This hands off to another application rather than returning data — use the pull-request listing capability to actually retrieve PRs.",
      category: "forge",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: openPRsArgsSchema,
      run: (args, ctx) => runForgeAction("forge.openPRs", args, ctx),
    })
  );

  actions.set("forge.openCommits", () =>
    defineAction({
      id: "forge.openCommits",
      title: "Open commits",
      description:
        "Open the forge's commit history for this project in the system browser, for a human to read. This hands off to another application rather than returning data — use a git history capability to actually retrieve commits.",
      category: "forge",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: openCommitsArgsSchema,
      run: (args, ctx) => runForgeAction("forge.openCommits", args, ctx),
    })
  );

  actions.set("forge.openRepo", () =>
    defineAction({
      id: "forge.openRepo",
      title: "Open repository",
      description:
        "Open this project's repository home page on the forge in the system browser, for a human to read; it returns no data. Fails when the forge provider doesn't link to one.",
      category: "forge",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: openRepoArgsSchema,
      run: (args, ctx) => runForgeAction("forge.openRepo", args, ctx),
    })
  );

  actions.set("forge.openIssue", () =>
    defineAction({
      id: "forge.openIssue",
      title: "Open issue",
      description:
        "Open one issue on the forge in the system browser, for a human to read. This hands off to another application rather than returning data — use the single-issue lookup to retrieve its title, body or state.",
      category: "forge",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: openIssueArgsSchema,
      run: (args, ctx) => runForgeAction("forge.openIssue", args, ctx),
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
      argsSchema: openPRArgsSchema,
      run: (args, ctx) => runForgeAction("forge.openPR", args, ctx),
    })
  );

  actions.set("forge.assignIssue", () =>
    defineAction({
      id: "forge.assignIssue",
      title: "Assign issue",
      description:
        "Assign an issue to a user on the active forge. Read back the resulting assignee list rather than assuming the request applied in full: forges silently drop accounts that lack access to the repository, so the returned list is what actually landed. Assigning someone already assigned is harmless.",
      category: "forge",
      kind: "command",
      // Deliberately unattended at system tier (#12118): assigning is an
      // idempotent state-set whose exact inverse is `forge.unassignIssue`. It
      // authors no content and creates no new record, which is also why it was
      // dropped from MCP_DEDUP_ALLOWLIST (#11534) — a repeat call is a no-op.
      danger: "safe",
      scope: "renderer",
      argsSchema: assignIssueArgsSchema,
      resultSchema: ForgeAssigneesResultSchema,
      mcpOutputSchema: true,
      run: (args, ctx) => runForgeAction("forge.assignIssue", args, ctx),
    })
  );

  actions.set("forge.unassignIssue", () =>
    defineAction({
      id: "forge.unassignIssue",
      title: "Unassign issue",
      description:
        "Remove one user's assignment from an issue on the active forge. Read back the resulting assignee list to confirm what remains. Removing someone who was not assigned is harmless rather than an error, so this is safe to call without checking first.",
      category: "forge",
      kind: "command",
      // Deliberately unattended at system tier (#12118), on the same reasoning
      // as `forge.assignIssue`: idempotent, exactly reversible, authors nothing.
      danger: "safe",
      scope: "renderer",
      argsSchema: unassignIssueArgsSchema,
      resultSchema: ForgeAssigneesResultSchema,
      mcpOutputSchema: true,
      run: (args, ctx) => runForgeAction("forge.unassignIssue", args, ctx),
    })
  );

  actions.set("forge.approvePR", () =>
    defineAction({
      id: "forge.approvePR",
      title: "Approve pull request",
      description:
        "Submit an approving review on a pull request, visible to everyone watching it on the forge. This is a public act of sign-off, so read the PR first. The forge rejects approvals it does not permit — approving your own pull request, most commonly — and a provider with no review support fails outright rather than silently doing nothing.",
      category: "forge",
      kind: "command",
      danger: "confirm",
      dangerRationale:
        "Submits an approving review to the remote forge. Retracting it requires dismissing the review.",
      scope: "renderer",
      argsSchema: approvePRArgsSchema,
      resultSchema: ForgeReviewResultSchema,
      mcpOutputSchema: true,
      run: (args, ctx) => runForgeAction("forge.approvePR", args, ctx),
    })
  );

  actions.set("forge.requestChanges", () =>
    defineAction({
      id: "forge.requestChanges",
      title: "Request changes on pull request",
      description:
        "Submit a request-changes review on a pull request, which blocks merging on most forges until it is resolved. This is publicly visible and requires an explanatory body, so write the reasoning for the author. A provider without review support fails rather than silently doing nothing.",
      category: "forge",
      kind: "command",
      danger: "confirm",
      dangerRationale:
        "Submits a request-changes review to the remote forge. Blocks the PR until addressed or dismissed.",
      scope: "renderer",
      argsSchema: requestChangesArgsSchema,
      resultSchema: ForgeReviewResultSchema,
      mcpOutputSchema: true,
      run: (args, ctx) => runForgeAction("forge.requestChanges", args, ctx),
    })
  );

  actions.set("forge.dismissReview", () =>
    defineAction({
      id: "forge.dismissReview",
      title: "Dismiss pull request review",
      description:
        "Dismiss a submitted review on a pull request, clearing the block it placed on merging. This is publicly visible, usually needs elevated permissions, and requires a message explaining why. Identify the review by the forge's own review id, which nothing on this surface can list — dismissing the wrong one silently unblocks a merge someone intended to gate.",
      category: "forge",
      kind: "command",
      danger: "confirm",
      dangerRationale: "Dismisses a submitted review on the remote forge. Cannot be undone.",
      scope: "renderer",
      argsSchema: dismissReviewArgsSchema,
      resultSchema: ForgeReviewResultSchema,
      mcpOutputSchema: true,
      run: (args, ctx) => runForgeAction("forge.dismissReview", args, ctx),
    })
  );

  actions.set("forge.requestReviewers", () =>
    defineAction({
      id: "forge.requestReviewers",
      title: "Request pull request reviewers",
      description:
        "Request reviewers on a pull request, notifying each of them on the forge. Supply at least one account or team. Read back the resulting request list rather than assuming it applied: it includes reviewers requested earlier and omits any the forge refused, typically for lacking repository access.",
      category: "forge",
      kind: "command",
      danger: "confirm",
      dangerRationale:
        "Requests reviewers on the remote forge and notifies them. Undone by removing the request.",
      scope: "renderer",
      argsSchema: requestReviewersArgsSchema,
      resultSchema: ForgeRequestedReviewersResultSchema,
      mcpOutputSchema: true,
      run: (args, ctx) => runForgeAction("forge.requestReviewers", args, ctx),
    })
  );

  actions.set("forge.validateToken", () =>
    defineAction({
      id: "forge.validateToken",
      title: "Validate forge token",
      description:
        "Ask the selected provider to validate a forge access token without saving it to Daintree. Use this to verify credentials before storing them. Providers validate however they choose — a live authentication round trip for most, locally for offline ones — so a rejection may mean an expired or insufficiently scoped token rather than a malformed one.",
      category: "forge",
      kind: "query",
      danger: "safe",
      // Never advertised to a model, and on no tier allowlist. The argument IS
      // the credential, so admitting this tool would require a token to be
      // composed in the model/tool-call channel before any redaction downstream
      // could apply. Renderer dispatch from the provider settings tab is the
      // only intended caller and is unaffected — tiers gate MCP, not
      // `source: "user"`. See the note in `helpAssistantTierAllowlists.ts`.
      mcpVisibility: "hidden",
      scope: "renderer",
      argsSchema: validateTokenArgsSchema,
      resultSchema: z.object({
        valid: z.boolean(),
        scopes: z.array(z.string()).optional(),
        expiresAt: z.number().nullable().optional(),
        error: z.string().optional(),
      }),
      run: (args, ctx) => runForgeAction("forge.validateToken", args, ctx),
    })
  );

  actions.set("forge.getRepoStats", () =>
    defineAction({
      id: "forge.getRepoStats",
      title: "Get repo stats",
      description:
        "Get headline repository counts, commits, issues and pull requests, from the active forge provider. Use this for a cheap overview rather than paging a list to count it. Results are cached and may be stale; bypassing the cache costs a live round trip against your rate limit. A provider failure comes back as an error field on an otherwise valid result, so check it before trusting the counts.",
      category: "forge",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: getRepoStatsArgsSchema,
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
      run: (args, ctx) => runForgeAction("forge.getRepoStats", args, ctx),
    })
  );

  actions.set("forge.listIssues", () =>
    defineAction({
      id: "forge.listIssues",
      title: "List issues",
      description:
        "List repository issues a page at a time, to discover or filter them; fetch a known number directly. Search takes a provider-native query fragment, not plain text, and goes through the search API rather than the list cache.",
      category: "forge",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: ForgeListOptionsSchema,
      resultSchema: ForgeIssuePageResultSchema,
      run: (args, ctx) => runForgeAction("forge.listIssues", args, ctx),
    })
  );

  actions.set("forge.listPRs", () =>
    defineAction({
      id: "forge.listPRs",
      title: "List pull requests",
      description:
        "List repository pull requests a page at a time, to discover or filter them; fetch known numbers directly instead of paging. Search takes a provider-native query fragment, not plain text, and goes through the search API rather than the list cache.",
      category: "forge",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: ForgePRListOptionsSchema,
      resultSchema: ForgePRPageResultSchema,
      run: (args, ctx) => runForgeAction("forge.listPRs", args, ctx),
    })
  );

  actions.set("forge.getIssue", () =>
    defineAction({
      id: "forge.getIssue",
      title: "Get issue",
      description:
        "Fetch one issue by number, with its body; use it instead of paging the listing for a known number. A missing issue comes back empty rather than failing. Reports the comment count, not comment text.",
      category: "forge",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: getIssueArgsSchema,
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
      run: (args, ctx) => runForgeAction("forge.getIssue", args, ctx),
    })
  );

  actions.set("forge.listIssueComments", () =>
    defineAction({
      id: "forge.listIssueComments",
      title: "List issue comments",
      description:
        "Read one page of an issue's comment thread from the active forge provider. Use it when comment text matters: the single-issue lookup reports only how many exist. Comments arrive oldest first, so reaching the newest reply means paging to the end. An empty page genuinely means nobody has commented; a missing issue or a provider that cannot read threads fails instead, so silence is never ambiguous.",
      category: "forge",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: listIssueCommentsArgsSchema,
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
      run: (args, ctx) => runForgeAction("forge.listIssueComments", args, ctx),
    })
  );

  actions.set("forge.getPR", () =>
    defineAction({
      id: "forge.getPR",
      title: "Get pull request",
      description:
        "Fetch one known pull request number with its body, draft state and branches; page the PR listing to find numbers. Read it before editing or merging. A missing PR comes back as `pr: null` rather than failing.",
      category: "forge",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: getPRArgsSchema,
      resultSchema: ForgePRActionResultSchema,
      mcpOutputSchema: true,
      run: (args, ctx) => runForgeAction("forge.getPR", args, ctx),
    })
  );

  actions.set("forge.getPRs", () =>
    defineAction({
      id: "forge.getPRs",
      title: "Get pull requests",
      description: `Fetch ${FORGE_GET_PRS_MIN}-${FORGE_GET_PRS_MAX} KNOWN pull request numbers in one call — reach for this instead of calling the single-PR lookup once per number. Results come back in the order asked, each with its own status: found, not_found, or unresolved. Treat unresolved as "could not find out", never as "does not exist". Use the PR listing instead when the numbers are not already known.`,
      category: "forge",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: getPRsArgsSchema,
      examples: [
        {
          args: { prNumbers: [12142, 12137, 12147] },
          description: "Fetch three known PRs from the active worktree's repo in one call",
        },
      ],
      resultSchema: ForgePRsActionResultSchema,
      mcpOutputSchema: true,
      run: (args, ctx) => runForgeAction("forge.getPRs", args, ctx),
    })
  );

  actions.set("forge.getCIStatus", () =>
    defineAction({
      id: "forge.getCIStatus",
      title: "Get CI status",
      description:
        "Fetch the roll-up CI verdict for one pull request. Read the overall state: counts cover required checks only, and a zero total also appears when that list could not be read, so it never proves nothing gates the merge. Provider-cached; can lag a minute.",
      category: "forge",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: getCIStatusArgsSchema,
      examples: [
        {
          args: { prNumber: 42 },
          description: "Check whether PR #42 is green in the active worktree's repo",
        },
      ],
      resultSchema: ForgeCIStatusActionResultSchema,
      mcpOutputSchema: true,
      run: (args, ctx) => runForgeAction("forge.getCIStatus", args, ctx),
    })
  );

  actions.set("forge.getChecks", () =>
    defineAction({
      id: "forge.getChecks",
      title: "Get CI checks",
      description:
        "List every CI check on one pull request: name, run state, conclusion, and a log link where the forge reports one. Reach for it once the roll-up shows trouble. A check with no conclusion has not passed; the roll-up stays the authority on whether a PR is green. An empty list means no checks, a null one no such PR, and a provider that cannot read checks fails instead.",
      category: "forge",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: getChecksArgsSchema,
      examples: [
        {
          args: { prNumber: 42 },
          description: "List the checks on PR #42 to find which one failed",
        },
      ],
      resultSchema: ForgeChecksActionResultSchema,
      mcpOutputSchema: true,
      run: (args, ctx) => runForgeAction("forge.getChecks", args, ctx),
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
      argsSchema: createPRArgsSchema,
      resultSchema: ForgePRResultSchema,
      run: (args, ctx) => runForgeAction("forge.createPR", args, ctx),
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
      argsSchema: closePRArgsSchema,
      resultSchema: ForgePRResultSchema,
      mcpOutputSchema: true,
      run: (args, ctx) => runForgeAction("forge.closePR", args, ctx),
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
      argsSchema: reopenPRArgsSchema,
      resultSchema: ForgePRResultSchema,
      mcpOutputSchema: true,
      run: (args, ctx) => runForgeAction("forge.reopenPR", args, ctx),
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
      argsSchema: mergePRArgsSchema,
      resultSchema: ForgeMergePRResultSchema,
      mcpOutputSchema: true,
      run: (args, ctx) => runForgeAction("forge.mergePR", args, ctx),
    })
  );

  // The two "merge when ready" writes are on no MCP tier and hidden from
  // discovery: their caller is the Review Hub's confirm, and an agent that
  // wants this already has `gh pr merge --auto` in its own shell (#13747).
  actions.set("forge.enableAutoMerge", () =>
    defineAction({
      id: "forge.enableAutoMerge",
      title: "Merge pull request when ready",
      description:
        "Ask the forge to merge a pull request once its required checks and reviews pass, pinned to the head commit you reviewed. The forge decides if and when it merges; on a merge-queue branch this adds the pull request to the queue. Never merges immediately: a pull request that can already merge comes back already-mergeable, and nothing is armed.",
      category: "forge",
      kind: "command",
      danger: "confirm",
      dangerRationale:
        "Arming auto-merge lets the forge write this pull request into the shared base branch later, without another prompt.",
      mcpVisibility: "hidden",
      scope: "renderer",
      argsSchema: enableAutoMergeArgsSchema,
      resultSchema: ForgeEnableAutoMergeResultSchema,
      run: (args, ctx) => runForgeAction("forge.enableAutoMerge", args, ctx),
    })
  );

  actions.set("forge.disableAutoMerge", () =>
    defineAction({
      id: "forge.disableAutoMerge",
      title: "Cancel merge when ready",
      description:
        "Cancel a pull request's pending auto-merge, or take it out of the merge queue if it is already queued. Reads the pull request when it runs, so it cancels whichever form the request is in by then.",
      category: "forge",
      kind: "command",
      danger: "confirm",
      dangerRationale:
        "Cancelling stops a merge someone else may have armed, and a queued pull request loses its place in the queue.",
      mcpVisibility: "hidden",
      scope: "renderer",
      argsSchema: disableAutoMergeArgsSchema,
      resultSchema: ForgeDisableAutoMergeResultSchema,
      run: (args, ctx) => runForgeAction("forge.disableAutoMerge", args, ctx),
    })
  );

  actions.set("forge.createIssue", () =>
    defineAction({
      id: "forge.createIssue",
      title: "Create issue",
      description:
        "File a new issue on the active forge. This is publicly visible and notifies watchers. Labels must already exist on the repository — the forge rejects the request rather than creating them, so confirm the names first.",
      category: "forge",
      kind: "command",
      danger: "confirm",
      dangerRationale:
        "Files a publicly visible issue and notifies every watcher of the repository. Closing it afterwards removes neither the record nor the notifications it already sent.",
      scope: "renderer",
      argsSchema: createIssueArgsSchema,
      examples: [
        {
          args: { title: "Crash on startup", body: "Steps to reproduce: ..." },
          description: "Create an issue in the active worktree's repo",
        },
      ],
      resultSchema: ForgeIssueResultSchema,
      run: (args, ctx) => runForgeAction("forge.createIssue", args, ctx),
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
      argsSchema: convertPRToDraftArgsSchema,
      resultSchema: ForgePRDraftStateResultSchema,
      mcpOutputSchema: true,
      run: (args, ctx) => runForgeAction("forge.convertPRToDraft", args, ctx),
    })
  );

  actions.set("forge.closeIssue", () =>
    defineAction({
      id: "forge.closeIssue",
      title: "Close issue",
      description:
        "Close an issue on the active forge, optionally recording why it was closed. This is publicly visible and reversible by reopening. Prefer stating a reason, since it distinguishes finished work from something declined or duplicated.",
      category: "forge",
      kind: "command",
      danger: "confirm",
      dangerRationale:
        "Closes an issue on the shared forge — a state change other collaborators see; undoing it requires a deliberate reopen.",
      scope: "renderer",
      argsSchema: closeIssueArgsSchema,
      resultSchema: ForgeIssueResultSchema,
      run: (args, ctx) => runForgeAction("forge.closeIssue", args, ctx),
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
      argsSchema: markPRReadyForReviewArgsSchema,
      resultSchema: ForgePRDraftStateResultSchema,
      mcpOutputSchema: true,
      run: (args, ctx) => runForgeAction("forge.markPRReadyForReview", args, ctx),
    })
  );

  actions.set("forge.reopenIssue", () =>
    defineAction({
      id: "forge.reopenIssue",
      title: "Reopen issue",
      description:
        "Reopen a closed issue, putting it back in the active queue and notifying watchers. This is publicly visible and reversible by closing it again.",
      category: "forge",
      kind: "command",
      danger: "confirm",
      dangerRationale:
        "Reopens an issue on the shared forge and notifies its watchers. Closing it again does not restore the reason it was closed for, and the notification cannot be withdrawn.",
      scope: "renderer",
      argsSchema: reopenIssueArgsSchema,
      resultSchema: ForgeIssueResultSchema,
      run: (args, ctx) => runForgeAction("forge.reopenIssue", args, ctx),
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
      argsSchema: commentOnPRArgsSchema,
      resultSchema: ForgeCommentResultSchema,
      mcpOutputSchema: true,
      run: (args, ctx) => runForgeAction("forge.commentOnPR", args, ctx),
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
      argsSchema: editPRArgsSchema,
      resultSchema: ForgePRResultSchema,
      run: (args, ctx) => runForgeAction("forge.editPR", args, ctx),
    })
  );

  actions.set("forge.editIssue", () =>
    defineAction({
      id: "forge.editIssue",
      title: "Edit issue",
      description:
        "Change an issue's title or body on the active forge. Supply at least one of them; whichever is omitted is left as it is, so this cannot accidentally blank a field. The new text replaces the old wholesale rather than appending, and the edit is publicly visible.",
      category: "forge",
      kind: "command",
      danger: "confirm",
      dangerRationale:
        "Overwrites an issue's title/body on the shared forge — the previous text is not recoverable from git or reflog, so it needs a deliberate confirm.",
      scope: "renderer",
      argsSchema: editIssueArgsSchema,
      resultSchema: ForgeIssueResultSchema,
      run: (args, ctx) => runForgeAction("forge.editIssue", args, ctx),
    })
  );

  actions.set("forge.addIssueComment", () =>
    defineAction({
      id: "forge.addIssueComment",
      title: "Add issue comment",
      description:
        "Post a comment on an issue, visible to everyone watching it and delivered as a notification. Comments cannot be edited or withdrawn through this capability, so treat posting as final.",
      category: "forge",
      kind: "command",
      danger: "confirm",
      dangerRationale:
        "Posts a public comment that participants are notified about. This capability cannot edit or withdraw it afterwards, so posting is final.",
      scope: "renderer",
      argsSchema: addIssueCommentArgsSchema,
      resultSchema: ForgeCommentResultSchema,
      run: (args, ctx) => runForgeAction("forge.addIssueComment", args, ctx),
    })
  );

  actions.set("forge.addIssueLabel", () =>
    defineAction({
      id: "forge.addIssueLabel",
      title: "Add issue label",
      description:
        "Add one existing label to an issue. This is additive — labels already on the issue are kept — so read back the returned label set to see the result. The label must already exist on the repository; the forge rejects an unknown name rather than creating it.",
      category: "forge",
      kind: "command",
      // Deliberately unattended at system tier (#12118): the label must already
      // exist on the repository, so nothing is authored or created, and
      // `forge.removeIssueLabel` is the exact inverse.
      danger: "safe",
      scope: "renderer",
      argsSchema: addIssueLabelArgsSchema,
      resultSchema: ForgeLabelArrayResultSchema,
      run: (args, ctx) => runForgeAction("forge.addIssueLabel", args, ctx),
    })
  );

  actions.set("forge.removeIssueLabel", () =>
    defineAction({
      id: "forge.removeIssueLabel",
      title: "Remove issue label",
      description:
        "Remove one label from an issue. Unlike adding, this fails when the label is not currently on the issue, so check the issue's labels first rather than calling speculatively. Read back the remaining label set to confirm the result.",
      category: "forge",
      kind: "command",
      // Deliberately unattended at system tier (#12118): reversible by
      // `forge.addIssueLabel`, and it destroys nothing — the label itself stays
      // on the repository.
      danger: "safe",
      scope: "renderer",
      argsSchema: removeIssueLabelArgsSchema,
      resultSchema: ForgeLabelArrayResultSchema,
      run: (args, ctx) => runForgeAction("forge.removeIssueLabel", args, ctx),
    })
  );
}
