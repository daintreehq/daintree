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
 * matches no cache slot. So when the caller named no location at all, the
 * mutation went to the active worktree's repo, which is the active project:
 * patch that root. An explicitly named location is honored as resolved, since
 * it may point at another repo entirely; if it isn't a project root the patch
 * simply finds nothing.
 */
function assigneeCachePath(location: WorktreeLocationArgs, resolvedCwd: string): string | null {
  // Only an explicit PATH can name a repo outside this project, so only a path
  // is honored as given. A `worktreeId` necessarily resolves inside the current
  // project, and resolving it yields a linked-worktree path that matches no
  // cache slot — treat it like the no-location case and patch the project root,
  // or the optimistic assign/unassign update is silently dropped.
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
// state that issues don't. `search` is absent on purpose: no provider on the
// roster routes PR listing through a search API, so accepting the key would
// silently return an unfiltered page. Strict mode turns that into an error
// instead; re-admitting the key once a provider can honor it only widens the
// schema, which is non-breaking.
const ForgePRListOptionsSchema = ForgeListPagingSchema.extend({
  state: z
    .enum(["open", "closed", "merged", "all"])
    .optional()
    .describe("State filter (default: open)"),
}).strict();

// Normalized PR shape returned by getPR/createPR/editPR. Kept loose (provider
// payload passes through `rawData`) — only the cross-provider fields are typed.
const ForgePRResultSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string(),
  state: z.string(),
  isDraft: z.boolean(),
  merged: z.boolean(),
  url: z.string(),
  baseRef: z.string(),
  headRef: z.string(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
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

// Normalized issue returned by the create/close/reopen/edit write actions.
const ForgeIssueResultSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string(),
  state: z.string(),
  url: z.string(),
  labels: z.array(z.unknown()).optional(),
  assignees: z.array(z.unknown()).optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
});

// Label set returned by the add/remove-label write actions.
const ForgeLabelArrayResultSchema = z.array(
  z.object({ name: z.string(), color: z.string().optional() })
);

// Comment returned by the add-comment write action.
const ForgeCommentResultSchema = z.object({
  id: z.string(),
  body: z.string(),
  url: z.string(),
  createdAt: z.number(),
});

// Account reference published in write-action results. Narrower than the
// contract ForgeUser, which also carries the provider's raw payload.
const ForgeUserResultSchema = z.object({
  login: z.string(),
  avatarUrl: z.string().optional(),
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
  items: z.array(ForgeCommentResultSchema.extend({ author: z.unknown().optional() })),
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
      description: "Open the forge issues list for the current project",
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
      description: "Open the forge pull requests list for the current project",
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
      description: "Open the forge commits page for the current project",
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
      description: "Open a forge issue in the system browser",
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
      description: "Open a forge pull request in the system browser",
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
        "Assign a forge issue to a user via the active provider. Returns the issue's resulting assignee list — forges silently drop assignees the account can't take, so the list is what actually landed.",
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
        syncAssigneeCache(assigneeCachePath(location, resolvedCwd), issueNumber, username, result.assignees);
        return result;
      },
    })
  );

  actions.set("forge.unassignIssue", () =>
    defineAction({
      id: "forge.unassignIssue",
      title: "Unassign Issue",
      description:
        "Remove a user's assignment from a forge issue via the active provider. Returns the issue's resulting assignee list.",
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
        syncAssigneeCache(assigneeCachePath(location, resolvedCwd), issueNumber, username, result.assignees);
        return result;
      },
    })
  );

  actions.set("forge.approvePR", () =>
    defineAction({
      id: "forge.approvePR",
      title: "Approve Pull Request",
      description:
        "Submit an approving review on a pull request via the active forge provider. Args: `worktreeId` or `worktreePath` (optional) — target worktree, defaults to the active one (`cwd` is accepted as a legacy alias); `prNumber` (required, positive int); `body` (optional) — an approval comment. Errors when no worktree is given and none is active, when the provider can't approve PRs, or when the forge rejects the review (e.g. approving your own PR). Returns the created review { id, state, rawState, body, url, author, submittedAt, commitId }.",
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
        "Submit a request-changes review on a pull request via the active forge provider. Args: `worktreeId` or `worktreePath` (optional) — target worktree, defaults to the active one (`cwd` is accepted as a legacy alias); `prNumber` (required, positive int); `body` (required) — explains what needs to change. Errors when no worktree is given and none is active, when the provider can't review PRs, or when the forge rejects the review. Returns the created review.",
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
        "Dismiss a submitted review on a pull request via the active forge provider. Args: `worktreeId` or `worktreePath` (optional) — target worktree, defaults to the active one (`cwd` is accepted as a legacy alias); `prNumber` (required, positive int); `reviewId` (required, positive int) — the review to dismiss, obtained from a prior review-thread lookup; `message` (required) — explains the dismissal. Errors when no worktree is given and none is active, or when the provider can't dismiss reviews. Returns the dismissed review.",
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
          .describe("Review id to dismiss, from a prior review-thread lookup"),
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
        "Request reviewers on a pull request via the active forge provider. Args: `worktreeId` or `worktreePath` (optional) — target worktree, defaults to the active one (`cwd` is accepted as a legacy alias); `prNumber` (required, positive int); `users` (optional) — account logins; `teams` (optional) — team identifiers (GitHub team slugs). Provide at least one user or team. Errors when no worktree is given and none is active, or when the provider can't request reviewers. Returns the PR's resulting reviewer requests { prNumber, requestedUsers, requestedTeams } — these include reviewers requested earlier and omit any the forge refused.",
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
      description: "Validate a forge access token without saving it",
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
        "Get repository statistics (commit/issue/PR counts) via the active forge provider. Args: `worktreeId` or `worktreePath` (optional) — target worktree, defaults to the active one (`cwd` is accepted as a legacy alias); `bypassCache` (optional) to force a fresh fetch. Returns commitCount, issueCount, prCount, loading, plus optional error/stale/lastUpdated/rate-limit fields. Errors when no worktree is given and none is active; forge failures surface in `error` rather than throwing.",
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
        "List repository issues via the active forge provider (paginated). Args (all optional): `worktreeId` or `worktreePath` (defaults to the active worktree; `cwd` is a legacy alias); `state` ('open'|'closed'|'all', default 'open'); `perPage` (1-100, default 20); `sort` ('created'|'updated'); `direction` ('asc'|'desc'); `cursor` from a previous response's `nextCursor`; `view` ('summary' default — drops body and raw provider payload — or 'full'); `bypassCache` to force a fresh fetch when the list may have changed outside this app; `search`, a query fragment in the active provider's issue-search dialect passed through verbatim (e.g. 'no:assignee -label:human-review'). Unknown args are rejected, not ignored. Returns { items, nextCursor, hasMore }; summary rows carry number, title, state, url, author, assignees, labels, commentCount, linkedPR and timestamps. Errors when no worktree is given and none is active. Do NOT use this for pull requests — call `forge.listPRs`.",
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
        "List repository pull requests via the active forge provider (paginated). Args (all optional): `worktreeId` or `worktreePath` (defaults to the active worktree; `cwd` is a legacy alias); `state` ('open'|'closed'|'merged'|'all', default 'open'); `perPage` (1-100, default 20); `sort` ('created'|'updated'); `direction` ('asc'|'desc'); `cursor` from a previous response's `nextCursor`; `view` ('summary' default — drops body and raw provider payload — or 'full'); `bypassCache` to force a fresh fetch when the list may have changed outside this app. There is no `search` here: the active provider has no PR query path, so passing it is rejected rather than silently returning an unfiltered page. Unknown args are rejected too. Returns { items, nextCursor, hasMore }. Errors when no worktree is given and none is active. Do NOT use this for issues — call `forge.listIssues`.",
      category: "forge",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: ForgePRListOptionsSchema,
      resultSchema: ForgePRPageResultSchema,
      run: async (
        { state, cursor, perPage, sort, direction, bypassCache, view, ...location },
        ctx: ActionContext
      ) => {
        const resolvedCwd = requireWorktreePath(location, ctx);
        const page = await forgeClient.listPRs(resolvedCwd, {
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
        "Fetch a single issue by its number via the active forge provider. Args: `worktreeId` or `worktreePath` (optional) — target worktree, defaults to the active one (`cwd` is accepted as a legacy alias); `issueNumber` (required, positive int). Returns the normalized forge issue { number, title, body, state ('open'|'closed'), url, author, assignees, labels, createdAt, updatedAt, ... } or null when not found. Errors when no worktree is given and none is active. Do NOT use `forge.listIssues` to fetch one known number — this is the direct lookup.",
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
      resultSchema: z
        .object({
          number: z.number(),
          title: z.string(),
          body: z.string(),
          state: z.string(),
          url: z.string(),
          labels: z.array(z.unknown()).optional(),
          assignees: z.array(z.unknown()).optional(),
          createdAt: z.number().optional(),
          updatedAt: z.number().optional(),
        })
        .nullable(),
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
        "Read one page of an issue's comment thread via the active forge provider — the read counterpart to `forge.addIssueComment`. Args: `worktreeId` or `worktreePath` (optional) — target worktree, defaults to the active one (`cwd` is accepted as a legacy alias); `issueNumber` (required, positive int); `cursor` (optional) from a previous response's `nextCursor`; `perPage` (optional, 1-100, default 20). Comments come back OLDEST-FIRST — to read the latest reply, page until `hasMore` is false and take the last item. Returns { items: [{ id, body, url, author, createdAt }], nextCursor, hasMore, totalCount }. An empty `items` means nobody has commented — a missing issue or a provider that can't read comments errors instead, so you never mistake one for silence. Errors when no worktree is given and none is active. Use `forge.getIssue` for the issue itself — it reports `commentCount` but no comment bodies.",
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
        "Fetch a single pull request by its number via the active forge provider. Args: `worktreeId` or `worktreePath` (optional) — target worktree, defaults to the active one (`cwd` is accepted as a legacy alias); `prNumber` (required, positive int). Returns the normalized forge PR { number, title, body, state ('open'|'closed'|'merged'), isDraft, merged, url, baseRef, headRef, createdAt, updatedAt, ... } or null when not found. Errors when no worktree is given and none is active. Use this before editing or merging a known PR; do NOT page `forge.listPRs` to find one known number.",
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
        "Fetch the roll-up CI status for a single pull request via the active forge provider. Args: `worktreeId` or `worktreePath` (optional) — target worktree, defaults to the active one (`cwd` is accepted as a legacy alias); `prNumber` (required, positive int). Returns `{ ciStatus }`: null when the PR doesn't exist, otherwise { state ('success'|'failure'|'pending'|'neutral'|'unknown'), total, passed, failed, pending, requiredChecksPassing? }. Read `state` for the verdict. The counts describe REQUIRED checks only, so a repo with no required checks reports total 0 while `state` still reflects overall CI health — never infer 'no checks ran' from total 0; only state 'neutral' means that. `requiredChecksPassing` is omitted when the provider reported no gating information, and false means gating is configured but not yet satisfied. Values may be up to ~60s stale (provider-cached), so poll rather than treating one success as final. Errors when no worktree is given and none is active.",
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

  actions.set("forge.createPR", () =>
    defineAction({
      id: "forge.createPR",
      title: "Create pull request",
      description:
        "Open a new pull request from `head` into `base` via the active forge provider. Args: `worktreeId` or `worktreePath` (optional, defaults to the active worktree; `cwd` is a legacy alias); `head` (source branch, required); `base` (target branch, required); `title` (required); `body` (optional); `draft` (optional). Returns the created normalized PR. Errors when no worktree is given and none is active.",
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
        "Close an open pull request without merging, via the active forge provider. Args: `worktreeId` or `worktreePath` (optional, defaults to the active worktree; `cwd` is a legacy alias); `prNumber` (required, positive int). Returns the updated pull request. Errors when no worktree is given and none is active.",
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
        "Reopen a previously closed pull request via the active forge provider. Args: `worktreeId` or `worktreePath` (optional, defaults to the active worktree; `cwd` is a legacy alias); `prNumber` (required, positive int). Returns the updated pull request. Errors when no worktree is given and none is active.",
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
        "Merge a pull request via the active forge provider. Args: `worktreeId` or `worktreePath` (optional, defaults to the active worktree; `cwd` is a legacy alias); `prNumber` (required, positive int); `mergeMethod` (optional 'merge'|'squash'|'rebase'); `commitTitle`/`commitMessage` (optional overrides). Irreversible — writes to the shared base branch. Returns the merge acknowledgement { prNumber, sha, merged, message }; `sha` is the merge commit. Errors when no worktree is given and none is active, or when the PR is not mergeable.",
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
        "Create a new issue via the active forge provider. Args: `worktreeId` or `worktreePath` (optional) — target worktree, defaults to the active one (`cwd` is accepted as a legacy alias); `title` (required); `body` (optional markdown); `labels` (optional array of label names). Returns the created issue { number, title, body, state, url, ... }. Errors when no worktree is given and none is active.",
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
        "Convert an open pull request to a draft via the active forge provider. Args: `worktreeId` or `worktreePath` (optional, defaults to the active worktree; `cwd` is a legacy alias); `prNumber` (required, positive int). Returns the resulting draft state { prNumber, isDraft }. Errors when no worktree is given and none is active.",
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
        "Close an open issue via the active forge provider. Args: `worktreeId` or `worktreePath` (optional) — target worktree, defaults to the active one (`cwd` is accepted as a legacy alias); `issueNumber` (required, positive int); `stateReason` (optional, 'completed', 'not_planned', or 'duplicate'). Returns the updated issue. Errors when no worktree is given and none is active.",
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
        "Mark a draft pull request ready for review via the active forge provider. Args: `worktreeId` or `worktreePath` (optional, defaults to the active worktree; `cwd` is a legacy alias); `prNumber` (required, positive int). Returns the resulting draft state { prNumber, isDraft }. Errors when no worktree is given and none is active.",
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
        "Reopen a closed issue via the active forge provider. Args: `worktreeId` or `worktreePath` (optional) — target worktree, defaults to the active one (`cwd` is accepted as a legacy alias); `issueNumber` (required, positive int). Returns the updated issue. Errors when no worktree is given and none is active.",
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
        "Post a comment on a pull request via the active forge provider. Args: `worktreeId` or `worktreePath` (optional, defaults to the active worktree; `cwd` is a legacy alias); `prNumber` (required, positive int); `body` (required comment text). Returns the created comment { id, body, url, createdAt }. Errors when no worktree is given and none is active.",
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
        "Edit a pull request's title and/or body via the active forge provider. Args: `worktreeId` or `worktreePath` (optional, defaults to the active worktree; `cwd` is a legacy alias); `prNumber` (required, positive int); `title` (optional); `body` (optional). Provide at least one of title/body. Returns the updated normalized PR. Errors when no worktree is given and none is active.",
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
        "Edit an issue's title and/or body via the active forge provider. Args: `worktreeId` or `worktreePath` (optional) — target worktree, defaults to the active one (`cwd` is accepted as a legacy alias); `issueNumber` (required, positive int); `title` (optional); `body` (optional). Provide at least one of title or body. Only the supplied fields change. Returns the updated issue. Errors when no worktree is given and none is active.",
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
        "Add a comment to an issue via the active forge provider. Args: `worktreeId` or `worktreePath` (optional) — target worktree, defaults to the active one (`cwd` is accepted as a legacy alias); `issueNumber` (required, positive int); `body` (required markdown). Returns the created comment { id, body, url, createdAt }. Errors when no worktree is given and none is active.",
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
        "Add a label (by name) to an issue via the active forge provider. Args: `worktreeId` or `worktreePath` (optional) — target worktree, defaults to the active one (`cwd` is accepted as a legacy alias); `issueNumber` (required, positive int); `label` (required label name). Additive — existing labels are kept. Returns the issue's full label set. Errors when no worktree is given and none is active.",
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
        "Remove a label (by name) from an issue via the active forge provider. Args: `worktreeId` or `worktreePath` (optional) — target worktree, defaults to the active one (`cwd` is accepted as a legacy alias); `issueNumber` (required, positive int); `label` (required label name). Errors if the label isn't on the issue. Returns the issue's remaining label set. Errors when no worktree is given and none is active.",
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
