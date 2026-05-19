import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { ActionContext, ActionId } from "@shared/types/actions";
import { defineAction } from "../defineAction";
import { z } from "zod";
// eslint-disable-next-line no-restricted-imports
import { forgeClient, githubClient } from "@/clients";
import { useProjectStore } from "@/store/projectStore";
import { actionService } from "@/services/ActionService";

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
  cursor: z.string().optional().describe("Pagination cursor from previous response"),
});

// Forwards a deprecated alias to its forge.* counterpart and propagates failures
// as thrown errors so callers using await def.run(...) see the same shape they
// would from the primary. Used only by the one-release github.* aliases below.
//
// Source preservation: the inner dispatch defaults to source="user". This is the
// intended behavior — the six github.* aliases are only reachable from
// user-recorded artifacts (keybindings, recipes, MRU). They are intentionally
// excluded from every agent-exposing allowlist (MCP, help assistant), and an
// adversarial test pins that exclusion so a future allowlist edit cannot
// silently launder agent intent through a deprecated alias.
async function dispatchAlias<T = unknown>(targetId: ActionId, args: unknown): Promise<T> {
  const result = await actionService.dispatch<T>(targetId, args);
  if (!result.ok) {
    // Preserve the structured error code on the thrown error so callers can
    // discriminate VALIDATION_ERROR vs EXECUTION_ERROR vs DISABLED without
    // re-parsing the message.
    const err = new Error(result.error.message) as Error & { code?: string };
    err.code = result.error.code;
    throw err;
  }
  return result.result;
}

export function registerGithubActions(actions: ActionRegistry, _callbacks: ActionCallbacks): void {
  // ---------------------------------------------------------------------------
  // forge.* primaries — provider-routed action surface.
  //
  // With only the GitHub provider registered today, each forge.* calls the
  // existing githubClient.* methods directly. When a second provider lands,
  // the run() bodies switch to ForgeProviderRegistry routing without changing
  // the public action shape.
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
  // github.* one-release aliases — forward to forge.* counterparts.
  //
  // Registered here in host code rather than via the GitHub built-in plugin
  // because PluginService.registerPluginAction enforces `id.startsWith(pluginId + ".")`
  // — plugin daintree.github cannot contribute bare `github.*` IDs without
  // significant plugin-system surface changes. Aliases retire in the next
  // release alongside the github.* IDs in BUILT_IN_ACTION_IDS.
  //
  // nonRepeatable: true — keeps deprecated alias IDs out of ActionService.lastAction
  // so action.repeatLast and similar replays the underlying forge.* primary, not
  // the alias ID that's scheduled for removal.
  // ---------------------------------------------------------------------------

  actions.set("github.openIssues", () =>
    defineAction({
      id: "github.openIssues",
      title: "Open GitHub Issues",
      description: "Alias of forge.openIssues. Removed in the next release.",
      category: "github",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      nonRepeatable: true,
      run: async (args) => {
        await dispatchAlias("forge.openIssues", args);
      },
    })
  );

  actions.set("github.openPRs", () =>
    defineAction({
      id: "github.openPRs",
      title: "Open GitHub Pull Requests",
      description: "Alias of forge.openPRs. Removed in the next release.",
      category: "github",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      nonRepeatable: true,
      run: async (args) => {
        await dispatchAlias("forge.openPRs", args);
      },
    })
  );

  actions.set("github.openCommits", () =>
    defineAction({
      id: "github.openCommits",
      title: "Open GitHub Commits",
      description: "Alias of forge.openCommits. Removed in the next release.",
      category: "github",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      nonRepeatable: true,
      run: async (args) => {
        await dispatchAlias("forge.openCommits", args);
      },
    })
  );

  actions.set("github.openIssue", () =>
    defineAction({
      id: "github.openIssue",
      title: "Open GitHub Issue",
      description: "Alias of forge.openIssue. Removed in the next release.",
      category: "github",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      nonRepeatable: true,
      run: async (args) => {
        await dispatchAlias("forge.openIssue", args);
      },
    })
  );

  actions.set("github.assignIssue", () =>
    defineAction({
      id: "github.assignIssue",
      title: "Assign GitHub Issue",
      description: "Alias of forge.assignIssue. Removed in the next release.",
      category: "github",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      nonRepeatable: true,
      run: async (args) => {
        await dispatchAlias("forge.assignIssue", args);
      },
    })
  );

  actions.set("github.validateToken", () =>
    defineAction({
      id: "github.validateToken",
      title: "Validate GitHub Token",
      description: "Alias of forge.validateToken. Removed in the next release.",
      category: "github",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      nonRepeatable: true,
      resultSchema: z.object({
        valid: z.boolean(),
        scopes: z.array(z.string()).optional(),
        expiresAt: z.number().nullable().optional(),
        error: z.string().optional(),
      }),
      run: async (args) => {
        return await dispatchAlias("forge.validateToken", args);
      },
    })
  );

  // ---------------------------------------------------------------------------
  // github.* host actions that are NOT migrating to forge.* in this stage.
  // These stay on the host since they are GitHub-specific (CLI checks, token
  // storage, paginated listings) rather than provider-abstract operations.
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
      description: "Get repository statistics using GitHub CLI",
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
        "List issues via GitHub CLI. Returns paginated results with cursor for next page.",
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
      description: "Fetch a single GitHub issue by number, including title, labels, and assignees.",
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
      resultSchema: z.object({
        number: z.number(),
        title: z.string(),
        state: z.string(),
        url: z.string(),
        body: z.string().nullable().optional(),
        labels: z.array(z.unknown()).optional(),
        assignees: z.array(z.unknown()).optional(),
        createdAt: z.string().optional(),
        updatedAt: z.string().nullable().optional(),
      }),
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
        "List pull requests via GitHub CLI. Returns paginated results with cursor for next page.",
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
    description: "Check whether GitHub CLI is available and configured",
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
