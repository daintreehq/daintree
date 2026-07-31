import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import { defineAction } from "../defineAction";
import { z } from "zod";
import { forgeClient } from "@/clients";
import { useProjectStore } from "@/store/projectStore";
import { patchIssueAssigneeCache } from "@/lib/forgeResourceCache";
import { logError } from "@/utils/logger";

/**
 * The cache keys on the PROJECT ROOT, but these actions resolve their forge
 * target to `cwd ?? ctx.activeWorktreePath` — and a linked worktree path
 * matches no cache slot. So when the caller named no `cwd`, the mutation went
 * to the active worktree's repo, which is the active project: patch that root.
 * An explicit `cwd` is honored as given, since it may name another repo
 * entirely; if it isn't a project root the patch simply finds nothing.
 */
function assigneeCachePath(cwd: string | undefined): string | null {
  if (cwd) return cwd;
  return useProjectStore.getState().currentProject?.path ?? null;
}

/**
 * Optimistically reflect an assign/unassign in the cached issue lists so the
 * toolbar dropdown updates immediately (#11087). Best-effort by design: the
 * forge mutation has already succeeded by the time this runs, so a cache-layer
 * throw must never surface as a failed action.
 *
 * No avatar is available: these actions take an arbitrary username, not the
 * viewer. A login-only assignee is valid — the next forge refresh fills it in.
 */
function patchAssigneeCache(
  projectPath: string | null,
  issueNumber: number,
  username: string,
  assigned: boolean
): void {
  if (!projectPath) return;
  try {
    patchIssueAssigneeCache(projectPath, issueNumber, { login: username }, assigned);
  } catch (err) {
    logError("Failed to patch issue cache after assignment change", err);
  }
}

const ForgeListOptionsSchema = z.object({
  cwd: z
    .string()
    .optional()
    .describe("Working directory of the git repo. Defaults to the active worktree path."),
  search: z.string().optional().describe("Search query"),
  state: z.enum(["open", "closed", "all"]).optional().describe("State filter (default: open)"),
  cursor: z
    .string()
    .optional()
    .describe(
      "Opaque pagination cursor — pass the previous response's `nextCursor` to fetch the next page."
    ),
});

// PR listing adds `merged` to the state filter — pull requests have a merged
// state that issues don't.
const ForgePRListOptionsSchema = ForgeListOptionsSchema.extend({
  state: z
    .enum(["open", "closed", "merged", "all"])
    .optional()
    .describe("State filter (default: open)"),
});

const ForgePageResultSchema = z.object({
  items: z.array(z.unknown()),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  totalCount: z.number().optional(),
});

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

const cwdArg = z
  .string()
  .optional()
  .describe("Working directory of the git repo. Defaults to the active worktree path.");

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
      argsSchema: z
        .object({
          projectPath: z.string().optional(),
          query: z.string().optional(),
          state: z.string().optional(),
        })
        .optional(),
      run: async (args) => {
        const projectPath = args?.projectPath;
        const query = args?.query;
        const state = args?.state;
        const path = projectPath ?? useProjectStore.getState().currentProject?.path;
        if (!path) {
          throw new Error("No project path available to open issues");
        }
        await forgeClient.openIssues(path, query, state);
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
      argsSchema: z
        .object({
          projectPath: z.string().optional(),
          query: z.string().optional(),
          state: z.string().optional(),
        })
        .optional(),
      run: async (args) => {
        const projectPath = args?.projectPath;
        const query = args?.query;
        const state = args?.state;
        const path = projectPath ?? useProjectStore.getState().currentProject?.path;
        if (!path) {
          throw new Error("No project path available to open pull requests");
        }
        await forgeClient.openPRs(path, query, state);
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
      argsSchema: z
        .object({ projectPath: z.string().optional(), branch: z.string().optional() })
        .optional(),
      run: async (args) => {
        const projectPath = args?.projectPath;
        const branch = args?.branch;
        const path = projectPath ?? useProjectStore.getState().currentProject?.path;
        if (!path) {
          throw new Error("No project path available to open commits");
        }
        await forgeClient.openCommits(path, branch);
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
        cwd: z
          .string()
          .optional()
          .describe("Working directory of the git repo. Defaults to the active worktree path."),
        issueNumber: z.number().int().positive(),
      }),
      run: async ({ cwd, issueNumber }, ctx: ActionContext) => {
        const resolvedCwd = cwd ?? ctx.activeWorktreePath;
        if (!resolvedCwd) throw new Error("No active worktree");
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
        cwd: z
          .string()
          .optional()
          .describe("Working directory of the git repo. Defaults to the active worktree path."),
        prNumber: z.number().int().positive(),
      }),
      run: async ({ cwd, prNumber }, ctx: ActionContext) => {
        const resolvedCwd = cwd ?? ctx.activeWorktreePath;
        if (!resolvedCwd) throw new Error("No active worktree");
        await forgeClient.openPR(resolvedCwd, prNumber);
      },
    })
  );

  actions.set("forge.assignIssue", () =>
    defineAction({
      id: "forge.assignIssue",
      title: "Assign Issue",
      description: "Assign a forge issue to a user via the active provider",
      category: "forge",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({
        cwd: z
          .string()
          .optional()
          .describe("Working directory of the git repo. Defaults to the active worktree path."),
        issueNumber: z.number().int().positive(),
        username: z.string().min(1).describe("Account to assign the issue to"),
      }),
      run: async ({ cwd, issueNumber, username }, ctx: ActionContext) => {
        const resolvedCwd = cwd ?? ctx.activeWorktreePath;
        if (!resolvedCwd) throw new Error("No active worktree");
        await forgeClient.assignIssue(resolvedCwd, issueNumber, username);
        patchAssigneeCache(assigneeCachePath(cwd), issueNumber, username, true);
      },
    })
  );

  actions.set("forge.unassignIssue", () =>
    defineAction({
      id: "forge.unassignIssue",
      title: "Unassign Issue",
      description: "Remove a user's assignment from a forge issue via the active provider",
      category: "forge",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({
        cwd: z
          .string()
          .optional()
          .describe("Working directory of the git repo. Defaults to the active worktree path."),
        issueNumber: z.number().int().positive(),
        username: z.string().min(1).describe("Account whose assignment should be removed"),
      }),
      run: async ({ cwd, issueNumber, username }, ctx: ActionContext) => {
        const resolvedCwd = cwd ?? ctx.activeWorktreePath;
        if (!resolvedCwd) throw new Error("No active worktree");
        await forgeClient.unassignIssue(resolvedCwd, issueNumber, username);
        patchAssigneeCache(assigneeCachePath(cwd), issueNumber, username, false);
      },
    })
  );

  actions.set("forge.approvePR", () =>
    defineAction({
      id: "forge.approvePR",
      title: "Approve Pull Request",
      description:
        "Submit an approving review on a pull request via the active forge provider. Args: `cwd` (optional) — git repo working directory, defaults to the active worktree path; `prNumber` (required, positive int); `body` (optional) — an approval comment. Errors when `cwd` is omitted and no worktree is active, when the provider can't approve PRs, or when the forge rejects the review (e.g. approving your own PR).",
      category: "forge",
      kind: "command",
      danger: "confirm",
      dangerRationale:
        "Submits an approving review to the remote forge. Retracting it requires dismissing the review.",
      scope: "renderer",
      argsSchema: z.object({
        cwd: z
          .string()
          .optional()
          .describe("Working directory of the git repo. Defaults to the active worktree path."),
        prNumber: z.number().int().positive().describe("Pull request number to approve"),
        body: z.string().optional().describe("Optional approval comment"),
      }),
      run: async ({ cwd, prNumber, body }, ctx: ActionContext) => {
        const resolvedCwd = cwd ?? ctx.activeWorktreePath;
        if (!resolvedCwd) throw new Error("No active worktree");
        await forgeClient.approvePR(resolvedCwd, prNumber, body);
      },
    })
  );

  actions.set("forge.requestChanges", () =>
    defineAction({
      id: "forge.requestChanges",
      title: "Request Changes on Pull Request",
      description:
        "Submit a request-changes review on a pull request via the active forge provider. Args: `cwd` (optional) — git repo working directory, defaults to the active worktree path; `prNumber` (required, positive int); `body` (required) — explains what needs to change. Errors when `cwd` is omitted and no worktree is active, when the provider can't review PRs, or when the forge rejects the review.",
      category: "forge",
      kind: "command",
      danger: "confirm",
      dangerRationale:
        "Submits a request-changes review to the remote forge. Blocks the PR until addressed or dismissed.",
      scope: "renderer",
      argsSchema: z.object({
        cwd: z
          .string()
          .optional()
          .describe("Working directory of the git repo. Defaults to the active worktree path."),
        prNumber: z.number().int().positive().describe("Pull request number to review"),
        body: z.string().trim().min(1).describe("Explanation of the changes being requested"),
      }),
      run: async ({ cwd, prNumber, body }, ctx: ActionContext) => {
        const resolvedCwd = cwd ?? ctx.activeWorktreePath;
        if (!resolvedCwd) throw new Error("No active worktree");
        await forgeClient.requestChanges(resolvedCwd, prNumber, body);
      },
    })
  );

  actions.set("forge.dismissReview", () =>
    defineAction({
      id: "forge.dismissReview",
      title: "Dismiss Pull Request Review",
      description:
        "Dismiss a submitted review on a pull request via the active forge provider. Args: `cwd` (optional) — git repo working directory, defaults to the active worktree path; `prNumber` (required, positive int); `reviewId` (required, positive int) — the review to dismiss, obtained from a prior review-thread lookup; `message` (required) — explains the dismissal. Errors when `cwd` is omitted and no worktree is active, or when the provider can't dismiss reviews.",
      category: "forge",
      kind: "command",
      danger: "confirm",
      dangerRationale: "Dismisses a submitted review on the remote forge. Cannot be undone.",
      scope: "renderer",
      argsSchema: z.object({
        cwd: z
          .string()
          .optional()
          .describe("Working directory of the git repo. Defaults to the active worktree path."),
        prNumber: z.number().int().positive().describe("Pull request number"),
        reviewId: z
          .number()
          .int()
          .positive()
          .describe("Review id to dismiss, from a prior review-thread lookup"),
        message: z.string().trim().min(1).describe("Reason for dismissing the review"),
      }),
      run: async ({ cwd, prNumber, reviewId, message }, ctx: ActionContext) => {
        const resolvedCwd = cwd ?? ctx.activeWorktreePath;
        if (!resolvedCwd) throw new Error("No active worktree");
        await forgeClient.dismissReview(resolvedCwd, prNumber, reviewId, message);
      },
    })
  );

  actions.set("forge.requestReviewers", () =>
    defineAction({
      id: "forge.requestReviewers",
      title: "Request Pull Request Reviewers",
      description:
        "Request reviewers on a pull request via the active forge provider. Args: `cwd` (optional) — git repo working directory, defaults to the active worktree path; `prNumber` (required, positive int); `users` (optional) — account logins; `teams` (optional) — team identifiers (GitHub team slugs). Provide at least one user or team. Errors when `cwd` is omitted and no worktree is active, or when the provider can't request reviewers.",
      category: "forge",
      kind: "command",
      danger: "confirm",
      dangerRationale:
        "Requests reviewers on the remote forge and notifies them. Undone by removing the request.",
      scope: "renderer",
      argsSchema: z
        .object({
          cwd: z
            .string()
            .optional()
            .describe("Working directory of the git repo. Defaults to the active worktree path."),
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
      run: async ({ cwd, prNumber, users, teams }, ctx: ActionContext) => {
        const resolvedCwd = cwd ?? ctx.activeWorktreePath;
        if (!resolvedCwd) throw new Error("No active worktree");
        await forgeClient.requestReviewers(resolvedCwd, prNumber, { users, teams });
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
        "Get repository statistics (commit/issue/PR counts) via the active forge provider. Args: `cwd` (optional) — git repo working directory, defaults to the active worktree path; `bypassCache` (optional) to force a fresh fetch. Returns commitCount, issueCount, prCount, loading, plus optional error/stale/lastUpdated/rate-limit fields. Errors when `cwd` is omitted and no worktree is active; forge failures surface in `error` rather than throwing.",
      category: "forge",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({
        cwd: z
          .string()
          .optional()
          .describe("Working directory of the git repo. Defaults to the active worktree path."),
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
      run: async ({ cwd, bypassCache }, ctx: ActionContext) => {
        const resolvedCwd = cwd ?? ctx.activeWorktreePath;
        if (!resolvedCwd) throw new Error("No active worktree");
        return await forgeClient.getRepoStats(resolvedCwd, bypassCache);
      },
    })
  );

  actions.set("forge.listIssues", () =>
    defineAction({
      id: "forge.listIssues",
      title: "List Issues",
      description:
        "List repository issues via the active forge provider (paginated). Args (all optional): `cwd` (repo dir, defaults to the active worktree path); `search`; `state` ('open'|'closed'|'all', default 'open'); `cursor` from a previous response's `nextCursor`. Returns { items, nextCursor, hasMore }. Errors when `cwd` is omitted and no worktree is active. Do NOT use this for pull requests — call `forge.listPRs`.",
      category: "forge",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: ForgeListOptionsSchema,
      resultSchema: ForgePageResultSchema,
      run: async ({ cwd, search, state, cursor }, ctx: ActionContext) => {
        const resolvedCwd = cwd ?? ctx.activeWorktreePath;
        if (!resolvedCwd) throw new Error("No active worktree");
        return await forgeClient.listIssues(resolvedCwd, { search, state, cursor });
      },
    })
  );

  actions.set("forge.listPRs", () =>
    defineAction({
      id: "forge.listPRs",
      title: "List Pull Requests",
      description:
        "List repository pull requests via the active forge provider (paginated). Args (all optional): `cwd` (repo dir, defaults to the active worktree path); `search`; `state` ('open'|'closed'|'merged'|'all', default 'open'); `cursor` from a previous response's `nextCursor`. Returns { items, nextCursor, hasMore }. Errors when `cwd` is omitted and no worktree is active. Do NOT use this for issues — call `forge.listIssues`.",
      category: "forge",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: ForgePRListOptionsSchema,
      resultSchema: ForgePageResultSchema,
      run: async ({ cwd, search, state, cursor }, ctx: ActionContext) => {
        const resolvedCwd = cwd ?? ctx.activeWorktreePath;
        if (!resolvedCwd) throw new Error("No active worktree");
        return await forgeClient.listPRs(resolvedCwd, { search, state, cursor });
      },
    })
  );

  actions.set("forge.getIssue", () =>
    defineAction({
      id: "forge.getIssue",
      title: "Get Issue",
      description:
        "Fetch a single issue by its number via the active forge provider. Args: `cwd` (optional) — git repo working directory, defaults to the active worktree path; `issueNumber` (required, positive int). Returns the normalized forge issue { number, title, body, state ('open'|'closed'), url, author, assignees, labels, createdAt, updatedAt, ... } or null when not found. Errors when `cwd` is omitted and no worktree is active. Do NOT use `forge.listIssues` to fetch one known number — this is the direct lookup.",
      category: "forge",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({
        cwd: z
          .string()
          .optional()
          .describe("Working directory of the git repo. Defaults to the active worktree path."),
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
      run: async ({ cwd, issueNumber }, ctx: ActionContext) => {
        const resolvedCwd = cwd ?? ctx.activeWorktreePath;
        if (!resolvedCwd) throw new Error("No active worktree");
        return await forgeClient.getIssue(resolvedCwd, issueNumber);
      },
    })
  );

  actions.set("forge.getPR", () =>
    defineAction({
      id: "forge.getPR",
      title: "Get Pull Request",
      description:
        "Fetch a single pull request by its number via the active forge provider. Args: `cwd` (optional) — git repo working directory, defaults to the active worktree path; `prNumber` (required, positive int). Returns the normalized forge PR { number, title, body, state ('open'|'closed'|'merged'), isDraft, merged, url, baseRef, headRef, createdAt, updatedAt, ... } or null when not found. Errors when `cwd` is omitted and no worktree is active. Use this before editing or merging a known PR; do NOT page `forge.listPRs` to find one known number.",
      category: "forge",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({
        cwd: cwdArg,
        prNumber: z.number().int().positive().describe("Pull request number to fetch"),
      }),
      resultSchema: ForgePRResultSchema.nullable(),
      run: async ({ cwd, prNumber }, ctx: ActionContext) => {
        const resolvedCwd = cwd ?? ctx.activeWorktreePath;
        if (!resolvedCwd) throw new Error("No active worktree");
        return await forgeClient.getPR(resolvedCwd, prNumber);
      },
    })
  );

  actions.set("forge.getCIStatus", () =>
    defineAction({
      id: "forge.getCIStatus",
      title: "Get CI Status",
      description:
        "Fetch the roll-up CI status for a single pull request via the active forge provider. Args: `cwd` (optional) — git repo working directory, defaults to the active worktree path; `prNumber` (required, positive int). Returns `{ ciStatus }`, where `ciStatus` is null when the PR doesn't exist and otherwise { state ('success'|'failure'|'pending'|'neutral'|'unknown'), total, passed, failed, pending, requiredChecksPassing? }. `state` is 'neutral' when the PR has no required checks configured — that is NOT a failure. `requiredChecksPassing` is omitted when the provider doesn't gate on required checks; `false` means gating is configured and not yet satisfied. Counts cover required checks only, and provider raw payloads are not returned. Errors when `cwd` is omitted and no worktree is active. Use this to verify a PR is green before merging.",
      category: "forge",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({
        cwd: cwdArg,
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
      run: async ({ cwd, prNumber }, ctx: ActionContext) => {
        const resolvedCwd = cwd ?? ctx.activeWorktreePath;
        if (!resolvedCwd) throw new Error("No active worktree");
        return { ciStatus: await forgeClient.getCIStatus(resolvedCwd, prNumber) };
      },
    })
  );

  actions.set("forge.createPR", () =>
    defineAction({
      id: "forge.createPR",
      title: "Create pull request",
      description:
        "Open a new pull request from `head` into `base` via the active forge provider. Args: `cwd` (optional, defaults to the active worktree path); `head` (source branch, required); `base` (target branch, required); `title` (required); `body` (optional); `draft` (optional). Returns the created normalized PR. Errors when `cwd` is omitted and no worktree is active.",
      category: "forge",
      kind: "command",
      danger: "confirm",
      dangerRationale:
        "Opens a pull request on the remote forge — a shared-state mutation reviewers and automation react to.",
      scope: "renderer",
      argsSchema: z.object({
        cwd: cwdArg,
        head: z.string().min(1).describe("Source branch the changes come from"),
        base: z.string().min(1).describe("Target branch the PR merges into"),
        title: z.string().min(1).describe("Pull request title"),
        body: z.string().optional().describe("Pull request body (Markdown)"),
        draft: z.boolean().optional().describe("Open as a draft pull request"),
      }),
      resultSchema: ForgePRResultSchema,
      run: async ({ cwd, head, base, title, body, draft }, ctx: ActionContext) => {
        const resolvedCwd = cwd ?? ctx.activeWorktreePath;
        if (!resolvedCwd) throw new Error("No active worktree");
        return await forgeClient.createPR(resolvedCwd, { head, base, title, body, draft });
      },
    })
  );

  actions.set("forge.closePR", () =>
    defineAction({
      id: "forge.closePR",
      title: "Close pull request",
      description:
        "Close an open pull request without merging, via the active forge provider. Args: `cwd` (optional, defaults to the active worktree path); `prNumber` (required, positive int). Errors when `cwd` is omitted and no worktree is active.",
      category: "forge",
      kind: "command",
      danger: "confirm",
      dangerRationale:
        "Closes a pull request on the remote forge — a shared-state change reviewers and automation react to.",
      scope: "renderer",
      argsSchema: z.object({
        cwd: cwdArg,
        prNumber: z.number().int().positive().describe("Pull request number to close"),
      }),
      run: async ({ cwd, prNumber }, ctx: ActionContext) => {
        const resolvedCwd = cwd ?? ctx.activeWorktreePath;
        if (!resolvedCwd) throw new Error("No active worktree");
        await forgeClient.closePR(resolvedCwd, prNumber);
      },
    })
  );

  actions.set("forge.reopenPR", () =>
    defineAction({
      id: "forge.reopenPR",
      title: "Reopen pull request",
      description:
        "Reopen a previously closed pull request via the active forge provider. Args: `cwd` (optional, defaults to the active worktree path); `prNumber` (required, positive int). Errors when `cwd` is omitted and no worktree is active.",
      category: "forge",
      kind: "command",
      danger: "confirm",
      dangerRationale:
        "Reopens a pull request on the remote forge — a shared-state change reviewers and automation react to.",
      scope: "renderer",
      argsSchema: z.object({
        cwd: cwdArg,
        prNumber: z.number().int().positive().describe("Pull request number to reopen"),
      }),
      run: async ({ cwd, prNumber }, ctx: ActionContext) => {
        const resolvedCwd = cwd ?? ctx.activeWorktreePath;
        if (!resolvedCwd) throw new Error("No active worktree");
        await forgeClient.reopenPR(resolvedCwd, prNumber);
      },
    })
  );

  actions.set("forge.mergePR", () =>
    defineAction({
      id: "forge.mergePR",
      title: "Merge pull request",
      description:
        "Merge a pull request via the active forge provider. Args: `cwd` (optional, defaults to the active worktree path); `prNumber` (required, positive int); `mergeMethod` (optional 'merge'|'squash'|'rebase'); `commitTitle`/`commitMessage` (optional overrides). Irreversible — writes to the shared base branch. Errors when `cwd` is omitted and no worktree is active, or when the PR is not mergeable.",
      category: "forge",
      kind: "command",
      danger: "confirm",
      dangerRationale:
        "Merging a pull request is irreversible and writes the change into the shared base branch.",
      scope: "renderer",
      argsSchema: z.object({
        cwd: cwdArg,
        prNumber: z.number().int().positive().describe("Pull request number to merge"),
        mergeMethod: z
          .enum(["merge", "squash", "rebase"])
          .optional()
          .describe("Merge strategy (provider default when omitted)"),
        commitTitle: z.string().optional().describe("Override the merge commit title"),
        commitMessage: z.string().optional().describe("Override the merge commit message"),
      }),
      run: async (
        { cwd, prNumber, mergeMethod, commitTitle, commitMessage },
        ctx: ActionContext
      ) => {
        const resolvedCwd = cwd ?? ctx.activeWorktreePath;
        if (!resolvedCwd) throw new Error("No active worktree");
        await forgeClient.mergePR(resolvedCwd, prNumber, {
          mergeMethod,
          commitTitle,
          commitMessage,
        });
      },
    })
  );

  actions.set("forge.createIssue", () =>
    defineAction({
      id: "forge.createIssue",
      title: "Create Issue",
      description:
        "Create a new issue via the active forge provider. Args: `cwd` (optional) — git repo working directory, defaults to the active worktree path; `title` (required); `body` (optional markdown); `labels` (optional array of label names). Returns the created issue { number, title, body, state, url, ... }. Errors when `cwd` is omitted and no worktree is active.",
      category: "forge",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({
        cwd: z
          .string()
          .optional()
          .describe("Working directory of the git repo. Defaults to the active worktree path."),
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
      run: async ({ cwd, title, body, labels }, ctx: ActionContext) => {
        const resolvedCwd = cwd ?? ctx.activeWorktreePath;
        if (!resolvedCwd) throw new Error("No active worktree");
        return await forgeClient.createIssue(resolvedCwd, { title, body, labels });
      },
    })
  );

  actions.set("forge.convertPRToDraft", () =>
    defineAction({
      id: "forge.convertPRToDraft",
      title: "Convert pull request to draft",
      description:
        "Convert an open pull request to a draft via the active forge provider. Args: `cwd` (optional, defaults to the active worktree path); `prNumber` (required, positive int). Errors when `cwd` is omitted and no worktree is active.",
      category: "forge",
      kind: "command",
      danger: "confirm",
      dangerRationale:
        "Changes a pull request's review state on the remote forge — reviewers and automation react to it.",
      scope: "renderer",
      argsSchema: z.object({
        cwd: cwdArg,
        prNumber: z.number().int().positive().describe("Pull request number to convert to draft"),
      }),
      run: async ({ cwd, prNumber }, ctx: ActionContext) => {
        const resolvedCwd = cwd ?? ctx.activeWorktreePath;
        if (!resolvedCwd) throw new Error("No active worktree");
        await forgeClient.convertPRToDraft(resolvedCwd, prNumber);
      },
    })
  );

  actions.set("forge.closeIssue", () =>
    defineAction({
      id: "forge.closeIssue",
      title: "Close Issue",
      description:
        "Close an open issue via the active forge provider. Args: `cwd` (optional) — git repo working directory, defaults to the active worktree path; `issueNumber` (required, positive int); `stateReason` (optional, 'completed', 'not_planned', or 'duplicate'). Returns the updated issue. Errors when `cwd` is omitted and no worktree is active.",
      category: "forge",
      kind: "command",
      danger: "confirm",
      dangerRationale:
        "Closes an issue on the shared forge — a state change other collaborators see; undoing it requires a deliberate reopen.",
      scope: "renderer",
      argsSchema: z.object({
        cwd: z
          .string()
          .optional()
          .describe("Working directory of the git repo. Defaults to the active worktree path."),
        issueNumber: z.number().int().positive().describe("Issue number to close"),
        stateReason: z
          .enum(["completed", "not_planned", "duplicate"])
          .optional()
          .describe("Why the issue is being closed (default: completed)"),
      }),
      resultSchema: ForgeIssueResultSchema,
      run: async ({ cwd, issueNumber, stateReason }, ctx: ActionContext) => {
        const resolvedCwd = cwd ?? ctx.activeWorktreePath;
        if (!resolvedCwd) throw new Error("No active worktree");
        return await forgeClient.closeIssue(resolvedCwd, issueNumber, stateReason);
      },
    })
  );

  actions.set("forge.markPRReadyForReview", () =>
    defineAction({
      id: "forge.markPRReadyForReview",
      title: "Mark pull request ready for review",
      description:
        "Mark a draft pull request ready for review via the active forge provider. Args: `cwd` (optional, defaults to the active worktree path); `prNumber` (required, positive int). Errors when `cwd` is omitted and no worktree is active.",
      category: "forge",
      kind: "command",
      danger: "confirm",
      dangerRationale:
        "Changes a pull request's review state on the remote forge, notifying reviewers.",
      scope: "renderer",
      argsSchema: z.object({
        cwd: cwdArg,
        prNumber: z.number().int().positive().describe("Pull request number to mark ready"),
      }),
      run: async ({ cwd, prNumber }, ctx: ActionContext) => {
        const resolvedCwd = cwd ?? ctx.activeWorktreePath;
        if (!resolvedCwd) throw new Error("No active worktree");
        await forgeClient.markPRReadyForReview(resolvedCwd, prNumber);
      },
    })
  );

  actions.set("forge.reopenIssue", () =>
    defineAction({
      id: "forge.reopenIssue",
      title: "Reopen Issue",
      description:
        "Reopen a closed issue via the active forge provider. Args: `cwd` (optional) — git repo working directory, defaults to the active worktree path; `issueNumber` (required, positive int). Returns the updated issue. Errors when `cwd` is omitted and no worktree is active.",
      category: "forge",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({
        cwd: z
          .string()
          .optional()
          .describe("Working directory of the git repo. Defaults to the active worktree path."),
        issueNumber: z.number().int().positive().describe("Issue number to reopen"),
      }),
      resultSchema: ForgeIssueResultSchema,
      run: async ({ cwd, issueNumber }, ctx: ActionContext) => {
        const resolvedCwd = cwd ?? ctx.activeWorktreePath;
        if (!resolvedCwd) throw new Error("No active worktree");
        return await forgeClient.reopenIssue(resolvedCwd, issueNumber);
      },
    })
  );

  actions.set("forge.commentOnPR", () =>
    defineAction({
      id: "forge.commentOnPR",
      title: "Comment on pull request",
      description:
        "Post a comment on a pull request via the active forge provider. Args: `cwd` (optional, defaults to the active worktree path); `prNumber` (required, positive int); `body` (required comment text). Errors when `cwd` is omitted and no worktree is active.",
      category: "forge",
      kind: "command",
      danger: "confirm",
      dangerRationale:
        "Posts a public comment on a pull request that participants are notified about.",
      scope: "renderer",
      argsSchema: z.object({
        cwd: cwdArg,
        prNumber: z.number().int().positive().describe("Pull request number to comment on"),
        body: z.string().min(1).describe("Comment body (Markdown)"),
      }),
      run: async ({ cwd, prNumber, body }, ctx: ActionContext) => {
        const resolvedCwd = cwd ?? ctx.activeWorktreePath;
        if (!resolvedCwd) throw new Error("No active worktree");
        await forgeClient.commentOnPR(resolvedCwd, prNumber, body);
      },
    })
  );

  actions.set("forge.editPR", () =>
    defineAction({
      id: "forge.editPR",
      title: "Edit pull request",
      description:
        "Edit a pull request's title and/or body via the active forge provider. Args: `cwd` (optional, defaults to the active worktree path); `prNumber` (required, positive int); `title` (optional); `body` (optional). Provide at least one of title/body. Returns the updated normalized PR. Errors when `cwd` is omitted and no worktree is active.",
      category: "forge",
      kind: "command",
      danger: "confirm",
      dangerRationale:
        "Edits a pull request's title/body on the remote forge — a shared-state mutation others see.",
      scope: "renderer",
      argsSchema: z
        .object({
          cwd: cwdArg,
          prNumber: z.number().int().positive().describe("Pull request number to edit"),
          title: z.string().min(1).optional().describe("New pull request title"),
          body: z.string().optional().describe("New pull request body (Markdown)"),
        })
        .refine((v) => v.title !== undefined || v.body !== undefined, {
          message: "Provide a title or body to edit",
        }),
      resultSchema: ForgePRResultSchema,
      run: async ({ cwd, prNumber, title, body }, ctx: ActionContext) => {
        const resolvedCwd = cwd ?? ctx.activeWorktreePath;
        if (!resolvedCwd) throw new Error("No active worktree");
        return await forgeClient.editPR(resolvedCwd, prNumber, { title, body });
      },
    })
  );

  actions.set("forge.editIssue", () =>
    defineAction({
      id: "forge.editIssue",
      title: "Edit Issue",
      description:
        "Edit an issue's title and/or body via the active forge provider. Args: `cwd` (optional) — git repo working directory, defaults to the active worktree path; `issueNumber` (required, positive int); `title` (optional); `body` (optional). Provide at least one of title or body. Only the supplied fields change. Returns the updated issue. Errors when `cwd` is omitted and no worktree is active.",
      category: "forge",
      kind: "command",
      danger: "confirm",
      dangerRationale:
        "Overwrites an issue's title/body on the shared forge — the previous text is not recoverable from git or reflog, so it needs a deliberate confirm.",
      scope: "renderer",
      argsSchema: z
        .object({
          cwd: z
            .string()
            .optional()
            .describe("Working directory of the git repo. Defaults to the active worktree path."),
          issueNumber: z.number().int().positive().describe("Issue number to edit"),
          title: z.string().optional().describe("New issue title"),
          body: z.string().optional().describe("New issue body (markdown)"),
        })
        .refine((v) => v.title !== undefined || v.body !== undefined, {
          message: "Provide at least one of title or body to edit",
        }),
      resultSchema: ForgeIssueResultSchema,
      run: async ({ cwd, issueNumber, title, body }, ctx: ActionContext) => {
        const resolvedCwd = cwd ?? ctx.activeWorktreePath;
        if (!resolvedCwd) throw new Error("No active worktree");
        return await forgeClient.editIssue(resolvedCwd, issueNumber, { title, body });
      },
    })
  );

  actions.set("forge.addIssueComment", () =>
    defineAction({
      id: "forge.addIssueComment",
      title: "Add Issue Comment",
      description:
        "Add a comment to an issue via the active forge provider. Args: `cwd` (optional) — git repo working directory, defaults to the active worktree path; `issueNumber` (required, positive int); `body` (required markdown). Returns the created comment { id, body, url, createdAt }. Errors when `cwd` is omitted and no worktree is active.",
      category: "forge",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({
        cwd: z
          .string()
          .optional()
          .describe("Working directory of the git repo. Defaults to the active worktree path."),
        issueNumber: z.number().int().positive().describe("Issue number to comment on"),
        body: z.string().min(1).describe("Comment body (markdown)"),
      }),
      resultSchema: ForgeCommentResultSchema,
      run: async ({ cwd, issueNumber, body }, ctx: ActionContext) => {
        const resolvedCwd = cwd ?? ctx.activeWorktreePath;
        if (!resolvedCwd) throw new Error("No active worktree");
        return await forgeClient.addIssueComment(resolvedCwd, issueNumber, body);
      },
    })
  );

  actions.set("forge.addIssueLabel", () =>
    defineAction({
      id: "forge.addIssueLabel",
      title: "Add Issue Label",
      description:
        "Add a label (by name) to an issue via the active forge provider. Args: `cwd` (optional) — git repo working directory, defaults to the active worktree path; `issueNumber` (required, positive int); `label` (required label name). Additive — existing labels are kept. Returns the issue's full label set. Errors when `cwd` is omitted and no worktree is active.",
      category: "forge",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({
        cwd: z
          .string()
          .optional()
          .describe("Working directory of the git repo. Defaults to the active worktree path."),
        issueNumber: z.number().int().positive().describe("Issue number to label"),
        label: z.string().min(1).describe("Label name to add"),
      }),
      resultSchema: ForgeLabelArrayResultSchema,
      run: async ({ cwd, issueNumber, label }, ctx: ActionContext) => {
        const resolvedCwd = cwd ?? ctx.activeWorktreePath;
        if (!resolvedCwd) throw new Error("No active worktree");
        return await forgeClient.addIssueLabel(resolvedCwd, issueNumber, label);
      },
    })
  );

  actions.set("forge.removeIssueLabel", () =>
    defineAction({
      id: "forge.removeIssueLabel",
      title: "Remove Issue Label",
      description:
        "Remove a label (by name) from an issue via the active forge provider. Args: `cwd` (optional) — git repo working directory, defaults to the active worktree path; `issueNumber` (required, positive int); `label` (required label name). Errors if the label isn't on the issue. Returns the issue's remaining label set. Errors when `cwd` is omitted and no worktree is active.",
      category: "forge",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({
        cwd: z
          .string()
          .optional()
          .describe("Working directory of the git repo. Defaults to the active worktree path."),
        issueNumber: z.number().int().positive().describe("Issue number to unlabel"),
        label: z.string().min(1).describe("Label name to remove"),
      }),
      resultSchema: ForgeLabelArrayResultSchema,
      run: async ({ cwd, issueNumber, label }, ctx: ActionContext) => {
        const resolvedCwd = cwd ?? ctx.activeWorktreePath;
        if (!resolvedCwd) throw new Error("No active worktree");
        return await forgeClient.removeIssueLabel(resolvedCwd, issueNumber, label);
      },
    })
  );
}
