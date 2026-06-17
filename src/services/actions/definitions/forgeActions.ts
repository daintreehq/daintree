import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import { defineAction } from "../defineAction";
import { z } from "zod";
import { forgeClient } from "@/clients";
import { useProjectStore } from "@/store/projectStore";

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
      scope: "renderer",
      argsSchema: z.object({
        cwd: z
          .string()
          .optional()
          .describe("Working directory of the git repo. Defaults to the active worktree path."),
        prNumber: z.number().int().positive().describe("Pull request number to review"),
        body: z.string().min(1).describe("Explanation of the changes being requested"),
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
        message: z.string().min(1).describe("Reason for dismissing the review"),
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
}
