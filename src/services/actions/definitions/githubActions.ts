import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { z } from "zod";
import { githubClient } from "@/clients";
import { useProjectStore } from "@/store/projectStore";

const GitHubListOptionsSchema = z.object({
  cwd: z.string().describe("Working directory of the git repo"),
  search: z.string().optional().describe("Search query"),
  state: z
    .enum(["open", "closed", "merged", "all"])
    .optional()
    .describe("State filter (default: open)"),
  cursor: z.string().optional().describe("Pagination cursor from previous response"),
});

export function registerGithubActions(actions: ActionRegistry, _callbacks: ActionCallbacks): void {
  actions.set("github.openIssues", () => ({
    id: "github.openIssues",
    title: "Open GitHub Issues",
    description: "Open the GitHub issues list for the current project",
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
    run: async (args: unknown) => {
      const { projectPath, query, state } =
        (args as { projectPath?: string; query?: string; state?: string } | undefined) ?? {};
      const path = projectPath ?? useProjectStore.getState().currentProject?.path;
      if (!path) {
        throw new Error("No project path available to open issues");
      }
      await githubClient.openIssues(path, query, state);
    },
  }));

  actions.set("github.openPRs", () => ({
    id: "github.openPRs",
    title: "Open GitHub Pull Requests",
    description: "Open the GitHub pull requests list for the current project",
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
    run: async (args: unknown) => {
      const { projectPath, query, state } =
        (args as { projectPath?: string; query?: string; state?: string } | undefined) ?? {};
      const path = projectPath ?? useProjectStore.getState().currentProject?.path;
      if (!path) {
        throw new Error("No project path available to open pull requests");
      }
      await githubClient.openPRs(path, query, state);
    },
  }));

  actions.set("github.openCommits", () => ({
    id: "github.openCommits",
    title: "Open GitHub Commits",
    description: "Open the GitHub commits page for the current project",
    category: "github",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z
      .object({ projectPath: z.string().optional(), branch: z.string().optional() })
      .optional(),
    run: async (args: unknown) => {
      const { projectPath, branch } =
        (args as { projectPath?: string; branch?: string } | undefined) ?? {};
      const path = projectPath ?? useProjectStore.getState().currentProject?.path;
      if (!path) {
        throw new Error("No project path available to open commits");
      }
      await githubClient.openCommits(path, branch);
    },
  }));

  actions.set("github.openIssue", () => ({
    id: "github.openIssue",
    title: "Open GitHub Issue",
    description: "Open a GitHub issue in the system browser",
    category: "github",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ cwd: z.string(), issueNumber: z.number().int().positive() }),
    run: async (args: unknown) => {
      const { cwd, issueNumber } = args as { cwd: string; issueNumber: number };
      await githubClient.openIssue(cwd, issueNumber);
    },
  }));

  actions.set("github.openPR", () => ({
    id: "github.openPR",
    title: "Open GitHub Pull Request",
    description: "Open a GitHub pull request URL in the system browser",
    category: "github",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ prUrl: z.string() }),
    run: async (args: unknown) => {
      const { prUrl } = args as { prUrl: string };
      await githubClient.openPR(prUrl);
    },
  }));

  actions.set("github.getRepoStats", () => ({
    id: "github.getRepoStats",
    title: "Get GitHub Repo Stats",
    description: "Get repository statistics using GitHub CLI",
    category: "github",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ cwd: z.string(), bypassCache: z.boolean().optional() }),
    run: async (args: unknown) => {
      const { cwd, bypassCache } = args as { cwd: string; bypassCache?: boolean };
      return await githubClient.getRepoStats(cwd, bypassCache);
    },
  }));

  actions.set("github.listIssues", () => ({
    id: "github.listIssues",
    title: "List GitHub Issues",
    description: "List issues via GitHub CLI. Returns paginated results with cursor for next page.",
    category: "github",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: GitHubListOptionsSchema,
    run: async (args: unknown) => {
      return await githubClient.listIssues(args as any);
    },
  }));

  actions.set("github.listPullRequests", () => ({
    id: "github.listPullRequests",
    title: "List GitHub Pull Requests",
    description:
      "List pull requests via GitHub CLI. Returns paginated results with cursor for next page.",
    category: "github",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: GitHubListOptionsSchema,
    run: async (args: unknown) => {
      return await githubClient.listPullRequests(args as any);
    },
  }));

  actions.set("github.checkCli", () => ({
    id: "github.checkCli",
    title: "Check GitHub CLI",
    description: "Check whether GitHub CLI is available and configured",
    category: "github",
    kind: "query",
    danger: "safe",
    scope: "renderer",
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
    run: async () => {
      return await githubClient.getConfig();
    },
  }));

  actions.set("github.setToken", () => ({
    id: "github.setToken",
    title: "Set GitHub Token",
    description: "Set the GitHub token used for CLI operations",
    category: "github",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    argsSchema: z.object({ token: z.string() }),
    run: async (args: unknown) => {
      const { token } = args as { token: string };
      return await githubClient.setToken(token);
    },
  }));

  actions.set("github.clearToken", () => ({
    id: "github.clearToken",
    title: "Clear GitHub Token",
    description: "Clear the stored GitHub token",
    category: "github",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    run: async () => {
      await githubClient.clearToken();
    },
  }));

  actions.set("github.validateToken", () => ({
    id: "github.validateToken",
    title: "Validate GitHub Token",
    description: "Validate a GitHub token without saving it",
    category: "github",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ token: z.string() }),
    run: async (args: unknown) => {
      const { token } = args as { token: string };
      return await githubClient.validateToken(token);
    },
  }));
}
