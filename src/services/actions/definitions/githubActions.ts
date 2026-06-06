import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import { defineAction } from "../defineAction";
import { z } from "zod";
// eslint-disable-next-line no-restricted-imports
import { forgeClient, githubClient } from "@/clients";
import { useProjectStore } from "@/store/projectStore";

const GitHubListOptionsSchema = z.object({
  cwd: z
    .string()
    .optional()
    .describe("Working directory of the git repo. Defaults to the active worktree path."),
  search: z.string().optional().describe("Search query"),
  state: z
    .enum(["open", "closed", "merged", "all"])
    .optional()
    .describe("State filter (default: open)"),
  cursor: z
    .string()
    .optional()
    .describe(
      "Opaque pagination cursor — pass the previous response's `pageInfo.endCursor` to fetch the next page."
    ),
});

export function registerGithubActions(actions: ActionRegistry, _callbacks: ActionCallbacks): void {
  // ---------------------------------------------------------------------------
  // forge.* primaries — provider-agnostic action surface.
  //
  // Each forge.* action calls forgeClient (the provider-agnostic IPC wrapper).
  // Provider routing is resolved at the IPC layer in electron/ipc/handlers/forge.ts,
  // so these run() bodies stay provider-agnostic.
  // ---------------------------------------------------------------------------

  actions.set("forge.openIssues", () =>
    defineAction({
      id: "forge.openIssues",
      title: "Open Issues",
      description: "Open the forge issues list for the current project",
      category: "github",
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
      category: "github",
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
      category: "github",
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
      category: "github",
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

  actions.set("forge.assignIssue", () =>
    defineAction({
      id: "forge.assignIssue",
      title: "Assign Issue",
      description: "Assign a forge issue to a user via the active provider",
      category: "github",
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
      category: "github",
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

  actions.set("forge.validateToken", () =>
    defineAction({
      id: "forge.validateToken",
      title: "Validate Forge Token",
      description: "Validate a forge access token without saving it",
      category: "github",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({ token: z.string() }),
      resultSchema: z.object({
        valid: z.boolean(),
        scopes: z.array(z.string()).optional(),
        expiresAt: z.number().nullable().optional(),
        error: z.string().optional(),
      }),
      run: async ({ token }) => {
        return await forgeClient.validateToken(token);
      },
    })
  );

  // ---------------------------------------------------------------------------
  // github.* host actions — intentionally GitHub-specific.
  //
  // These actions call githubClient directly for token-backed API access, CLI
  // credential checks, and GitHub URL opening. They are intentionally separate
  // from the forge.* surface, which routes through the provider-agnostic forgeClient.
  // ---------------------------------------------------------------------------

  actions.set("github.openPR", () =>
    defineAction({
      id: "github.openPR",
      title: "Open GitHub Pull Request",
      description: "Open a GitHub pull request URL in the system browser",
      category: "github",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({ prUrl: z.string() }),
      run: async ({ prUrl }) => {
        await githubClient.openPR(prUrl);
      },
    })
  );

  actions.set("github.getRepoStats", () =>
    defineAction({
      id: "github.getRepoStats",
      title: "Get GitHub Repo Stats",
      description:
        "Get repository statistics (commit/issue/PR counts) via the token-backed GitHub API. Args: `cwd` (optional) — git repo working directory, defaults to the active worktree path; `bypassCache` (optional) to force a fresh fetch. Returns commitCount, issueCount, prCount, loading, plus optional ghError/stale/lastUpdated/rate-limit fields. Errors when `cwd` is omitted and no worktree is active; GitHub failures surface in `ghError` rather than throwing.",
      category: "github",
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
        ghError: z.string().optional(),
        stale: z.boolean().optional(),
        lastUpdated: z.number().optional(),
        rateLimitResetAt: z.number().optional(),
        rateLimitKind: z.string().optional(),
      }),
      run: async ({ cwd, bypassCache }, ctx: ActionContext) => {
        const resolvedCwd = cwd ?? ctx.activeWorktreePath;
        if (!resolvedCwd) throw new Error("No active worktree");
        return await githubClient.getRepoStats(resolvedCwd, bypassCache);
      },
    })
  );

  actions.set("github.listIssues", () =>
    defineAction({
      id: "github.listIssues",
      title: "List GitHub Issues",
      description:
        "List repository issues via the token-backed GitHub API (paginated). Args (all optional): `cwd` (repo dir, defaults to the active worktree path); `search`; `state` ('open'|'closed'|'all', default 'open' — 'merged' is accepted by the schema but not meaningful for issues and is silently treated as 'open'); `cursor` from a previous response's `pageInfo.endCursor`. Returns { items, pageInfo:{ hasNextPage, endCursor } }. Errors when `cwd` is omitted and no worktree is active. Do NOT use this for pull requests — call `github.listPullRequests`.",
      category: "github",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: GitHubListOptionsSchema,
      resultSchema: z.object({
        items: z.array(z.unknown()),
        pageInfo: z.object({
          hasNextPage: z.boolean(),
          endCursor: z.string().nullable(),
        }),
      }),
      run: async (args, ctx: ActionContext) => {
        const resolvedCwd = args.cwd ?? ctx.activeWorktreePath;
        if (!resolvedCwd) throw new Error("No active worktree");
        // Schema allows `state: "merged"` (valid for PRs); the issues client API
        // does not. Preserved as a runtime gap — see githubActions.adversarial.test.ts.
        return await githubClient.listIssues({
          ...args,
          cwd: resolvedCwd,
        } as Parameters<typeof githubClient.listIssues>[0]);
      },
    })
  );

  actions.set("github.getIssueByNumber", () =>
    defineAction({
      id: "github.getIssueByNumber",
      title: "Get GitHub Issue",
      description:
        "Fetch a single GitHub issue by its number. Args: `cwd` (optional) — git repo working directory, defaults to the active worktree path; `issueNumber` (required, positive int). Returns the issue { number, title, url, state ('OPEN'|'CLOSED'), updatedAt, author, assignees, commentCount, labels?, linkedPR? } or null when not found. Errors when `cwd` is omitted and no worktree is active. Do NOT use `github.listIssues` to fetch one known number — this is the direct lookup.",
      category: "github",
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
          state: z.string(),
          url: z.string(),
          body: z.string().nullable().optional(),
          labels: z.array(z.unknown()).optional(),
          assignees: z.array(z.unknown()).optional(),
          createdAt: z.string().optional(),
          updatedAt: z.string().nullable().optional(),
        })
        .nullable(),
      run: async ({ cwd, issueNumber }, ctx: ActionContext) => {
        const resolvedCwd = cwd ?? ctx.activeWorktreePath;
        if (!resolvedCwd) throw new Error("No active worktree");
        return await githubClient.getIssueByNumber(resolvedCwd, issueNumber);
      },
    })
  );

  actions.set("github.listPullRequests", () =>
    defineAction({
      id: "github.listPullRequests",
      title: "List GitHub Pull Requests",
      description:
        "List repository pull requests via the token-backed GitHub API (paginated). Args (all optional): `cwd` (repo dir, defaults to the active worktree path); `search`; `state` ('open'|'closed'|'merged'|'all', default 'open'); `cursor` from a previous response's `pageInfo.endCursor`. Returns { items, pageInfo:{ hasNextPage, endCursor } }. Errors when `cwd` is omitted and no worktree is active. Do NOT use this for issues — call `github.listIssues` (issues have no 'merged' state).",
      category: "github",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: GitHubListOptionsSchema,
      resultSchema: z.object({
        items: z.array(z.unknown()),
        pageInfo: z.object({
          hasNextPage: z.boolean(),
          endCursor: z.string().nullable(),
        }),
      }),
      run: async (args, ctx: ActionContext) => {
        const resolvedCwd = args.cwd ?? ctx.activeWorktreePath;
        if (!resolvedCwd) throw new Error("No active worktree");
        return await githubClient.listPullRequests({ ...args, cwd: resolvedCwd });
      },
    })
  );

  actions.set("github.checkCli", () => ({
    id: "github.checkCli",
    title: "Check GitHub CLI",
    description:
      "Check whether a GitHub token is configured (the credential the github.* actions use). Takes no args. Returns { available: boolean, error? } — available:true when a token is stored, otherwise available:false with `error` explaining a token must be set in Settings. Does NOT check for the `gh` binary or token validity. Never throws. Call this before other github.* actions when credential presence is uncertain.",
    category: "github",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    resultSchema: z.object({
      available: z.boolean(),
      error: z.string().optional(),
    }),
    run: async () => {
      return await githubClient.checkCli();
    },
  }));

  actions.set("github.getConfig", () => ({
    id: "github.getConfig",
    title: "Get GitHub Token Config",
    description: "Get stored GitHub token configuration",
    category: "github",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    resultSchema: z.object({
      hasToken: z.boolean(),
      scopes: z.array(z.string()).optional(),
      username: z.string().optional(),
      avatarUrl: z.string().optional(),
    }),
    run: async () => {
      return await githubClient.getConfig();
    },
  }));

  actions.set("github.setToken", () =>
    defineAction({
      id: "github.setToken",
      title: "Set GitHub Token",
      description: "Set the GitHub token used for CLI operations",
      category: "github",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({ token: z.string() }),
      run: async ({ token }) => {
        return await githubClient.setToken(token);
      },
    })
  );

  actions.set("github.clearToken", () => ({
    id: "github.clearToken",
    title: "Clear GitHub Token",
    description: "Clear the stored GitHub token",
    category: "github",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      await githubClient.clearToken();
    },
  }));
}
