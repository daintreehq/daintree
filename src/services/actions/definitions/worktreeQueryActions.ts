import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { defineAction } from "../defineAction";
import { z } from "zod";
import { WorktreeSummarySchema } from "./schemas";
import { paginate } from "@shared/utils/boundedOutput";
import { GIT_PAGE_LIMIT_DEFAULT, GIT_PAGE_LIMIT_MAX } from "@shared/config/gitReadLimits";
import { withWorktreeLocation, requireWorktreePath } from "./locationArgs";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { worktreeClient } from "@/clients";

export function registerWorktreeQueryActions(
  actions: ActionRegistry,
  callbacks: ActionCallbacks
): void {
  actions.set("worktree.list", () => ({
    id: "worktree.list",
    title: "List Worktrees",
    description:
      "List every worktree in the active project with summary status. Takes no args. Returns { worktrees } — each entry has id, path, branch, isActive, isMain, issueNumber/issueTitle, prNumber/prTitle/prUrl, status (mood), and lastCommit. Never errors; returns an empty array when none exist. Do NOT use this when you only need the active worktree — call `worktree.getCurrent`.",
    category: "worktree",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    resultSchema: z.object({ worktrees: z.array(WorktreeSummarySchema) }),
    run: async () => {
      const worktrees = callbacks.getWorktrees();
      const activeWorktreeId = callbacks.getActiveWorktreeId();

      const result = worktrees.map((w) => ({
        id: w.id,
        path: w.path,
        branch: w.branch,
        isActive: w.id === activeWorktreeId,
        isMain: w.isMainWorktree ?? false,
        issueNumber: w.issueNumber ?? null,
        issueTitle: w.issueTitle ?? null,
        prNumber: w.linked?.pr?.ref.number ?? null,
        prTitle: w.linked?.pr?.title ?? null,
        prUrl: w.linked?.pr?.url ?? null,
        status: w.mood ?? null,
        lastCommit: w.summary ?? null,
      }));

      return { worktrees: result };
    },
  }));

  actions.set("worktree.getCurrent", () => ({
    id: "worktree.getCurrent",
    title: "Get Current Worktree",
    description:
      "Get the currently active worktree's summary. Takes no args. Returns { worktree } — the same shape as a `worktree.list` entry (id, path, branch, isActive, isMain, issue/PR fields, status, lastCommit), or null when no worktree is active or it can't be found. Never errors. Do NOT use `worktree.list` for this — that returns all worktrees; this returns only the active one.",
    category: "worktree",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    resultSchema: z.object({ worktree: WorktreeSummarySchema.nullable() }),
    run: async () => {
      const activeWorktreeId = callbacks.getActiveWorktreeId();
      if (!activeWorktreeId) {
        return { worktree: null };
      }

      const worktree = getCurrentViewStore().getState().worktrees.get(activeWorktreeId);
      if (!worktree) {
        return { worktree: null };
      }

      const result = {
        id: worktree.id,
        path: worktree.path,
        branch: worktree.branch,
        isActive: true,
        isMain: worktree.isMainWorktree ?? false,
        issueNumber: worktree.issueNumber ?? null,
        issueTitle: worktree.issueTitle ?? null,
        prNumber: worktree.linked?.pr?.ref.number ?? null,
        prTitle: worktree.linked?.pr?.title ?? null,
        prUrl: worktree.linked?.pr?.url ?? null,
        status: worktree.mood ?? null,
        lastCommit: worktree.summary ?? null,
      };

      return { worktree: result };
    },
  }));

  actions.set("worktree.listBranches", () =>
    defineAction({
      id: "worktree.listBranches",
      title: "List Branches",
      description:
        "List git branches for a repository, one page at a time. Args (all optional): `worktreeId` or `worktreePath` — target worktree, defaults to the active one (`rootPath` is accepted as a legacy alias for `worktreePath`); `offset` (default 0); `limit` (default 100, max 200). Returns { branches, total, hasMore, offset, limit, nextOffset } — each branch has name, current (bool), commit (sha), and optional remote. When `hasMore` is true, call again with `offset: nextOffset`. Errors when no worktree is given and none is active, or when the target is not a git repository.",
      category: "worktree",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      // `offset`/`limit` are declared inline rather than through `paginationShape`
      // so the branch-specific ceilings and their descriptions survive (#11531).
      argsSchema: withWorktreeLocation(
        {
          offset: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe("Index to start from — pass a previous `nextOffset` (default 0)."),
          limit: z
            .number()
            .int()
            .positive()
            .max(GIT_PAGE_LIMIT_MAX)
            .optional()
            .describe(
              `Branches per page (default ${GIT_PAGE_LIMIT_DEFAULT}, max ${GIT_PAGE_LIMIT_MAX}).`
            ),
        },
        { legacy: ["rootPath"] }
      ).optional(),
      examples: [
        {
          args: { worktreePath: "/Users/me/Projects/app" },
          description: "List the first 100 branches for the repository at that path",
        },
      ],
      resultSchema: z.object({
        branches: z.array(
          z.object({
            name: z.string(),
            current: z.boolean(),
            commit: z.string(),
            remote: z.string().optional(),
          })
        ),
        total: z.number(),
        hasMore: z.boolean(),
        offset: z.number(),
        limit: z.number(),
        nextOffset: z.number().nullable(),
      }),
      mcpOutputSchema: true,
      run: async (args, ctx) => {
        const { offset, limit, ...location } = args ?? {};
        const result = await worktreeClient.listBranches(requireWorktreePath(location, ctx));
        // Clamped here as well as in argsSchema: dispatch paths that bypass
        // schema validation must not be able to request an unbounded page.
        const start = Math.max(Math.trunc(offset ?? 0) || 0, 0);
        const size = Math.min(
          Math.max(Math.trunc(limit ?? GIT_PAGE_LIMIT_DEFAULT) || 1, 1),
          GIT_PAGE_LIMIT_MAX
        );
        const page = paginate(result, start, size);
        return {
          branches: page.items.map((branch) => ({
            name: branch.name,
            current: branch.current,
            commit: branch.commit,
            remote: branch.remote,
          })),
          total: page.total,
          hasMore: page.hasMore,
          offset: start,
          limit: size,
          nextOffset: page.nextOffset,
        };
      },
    })
  );

  actions.set("worktree.getDefaultPath", () =>
    defineAction({
      id: "worktree.getDefaultPath",
      title: "Get Default Worktree Path",
      description:
        "Compute the default filesystem path for a new worktree from the repo root, branch name, and the configured path pattern. Args: `worktreeId` or `worktreePath` (required) — the repository root to anchor the path on (`rootPath` is accepted as a legacy alias for `worktreePath`); `branchName` (required) — the branch the worktree will track. Returns { path }. Errors when either argument is missing. There is deliberately no active-worktree default: the active worktree is usually a linked worktree, and anchoring on one silently misses the project's configured path pattern and produces a path nested under that worktree.",
      category: "worktree",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: withWorktreeLocation(
        { branchName: z.string().describe("Branch name the new worktree will track.") },
        { legacy: ["rootPath"], requireSelector: true }
      ),
      examples: [
        {
          args: { worktreePath: "/Users/me/Projects/app", branchName: "feature/login" },
          description: "Resolve where a worktree for 'feature/login' would be created",
        },
      ],
      resultSchema: z.object({ path: z.string() }),
      run: async ({ branchName, ...location }, ctx) => {
        const result = await worktreeClient.getDefaultPath(
          requireWorktreePath(location, ctx),
          branchName
        );
        return { path: result };
      },
    })
  );

  actions.set("worktree.getAvailableBranch", () =>
    defineAction({
      id: "worktree.getAvailableBranch",
      title: "Get Available Branch Name",
      description:
        "Resolve a collision-safe branch name: returns the requested name if free, otherwise a numbered variant (e.g. 'feature-2'). Args: `worktreeId` or `worktreePath` (optional) — the repository, defaults to the active worktree (`rootPath` is accepted as a legacy alias for `worktreePath`); `branchName` (required) — the desired branch name. Returns { branch } — the safe name to use. Errors when `branchName` is missing, or when no worktree is given and none is active.",
      category: "worktree",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: withWorktreeLocation(
        { branchName: z.string().describe("Desired branch name to check for collisions.") },
        { legacy: ["rootPath"] }
      ),
      examples: [
        {
          args: { worktreePath: "/Users/me/Projects/app", branchName: "feature/login" },
          description: "Get a non-colliding branch name based on 'feature/login'",
        },
      ],
      resultSchema: z.object({ branch: z.string() }),
      run: async ({ branchName, ...location }, ctx) => {
        const result = await worktreeClient.getAvailableBranch(
          requireWorktreePath(location, ctx),
          branchName
        );
        return { branch: result };
      },
    })
  );
}
