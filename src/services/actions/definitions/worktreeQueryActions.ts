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
      "List every worktree in the active project with its branch, status and any linked issue or pull request. Use this to discover worktree ids; ask for the current worktree instead when all you need is the one in use. It never fails — an empty list means the project has no worktrees.",
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
        // `Worktree.branch` is undefined on a detached HEAD, and the summary
        // shape declares `string | null` like every sibling field here.
        branch: w.branch ?? null,
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
      "Get the worktree currently in use, which is what most work should be scoped to. Use the full worktree listing only when you genuinely need the others. It never fails: an empty result means no worktree is active, which is the case a caller most often needs to handle before acting.",
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
        // Undefined on a detached HEAD; the summary shape declares `string | null`.
        branch: worktree.branch ?? null,
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
        "List a repository's git branches a page at a time, flagging which one is checked out. Use this to discover branch names before creating a worktree or opening a pull request. Long branch lists are paged, so continue from the offset it hands back while more remain. A target that is not a git repository fails rather than returning nothing.",
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
        "Work out where a new worktree for a given branch should live, honouring the project's configured path pattern. Use this before creating a worktree so the path matches project convention rather than being invented. The repository must be named explicitly — there is deliberately no active-worktree fallback, because anchoring on a linked worktree silently produces a path nested inside it.",
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
        "Turn a desired branch name into one that is actually free, appending a numeric suffix when the name is taken. Use this before creating a branch or worktree so creation does not fail on a collision. It only reserves nothing — the name can still be taken between this call and the one that uses it.",
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
