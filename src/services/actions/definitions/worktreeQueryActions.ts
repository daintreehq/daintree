import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { defineAction } from "../defineAction";
import type { ActionContext } from "@shared/types/actions";
import { z } from "zod";
import { WorktreeSummarySchema, WorktreeSetupStateSchema } from "./schemas";
import { paginate } from "@shared/utils/boundedOutput";
import { GIT_PAGE_LIMIT_DEFAULT, GIT_PAGE_LIMIT_MAX } from "@shared/config/gitReadLimits";
import { withWorktreeLocation, requireWorktreePath, requireWorktreeId } from "./locationArgs";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { worktreeClient } from "@/clients";
import type { WorktreeSnapshot } from "@shared/types/workspace-host";

/**
 * The wire spelling of a worktree's post-create initialization state.
 *
 * An absent `setupStatus` is reported as `unknown`, never as `ready`: the host
 * holds it in memory, so a worktree created before this host process started —
 * or by another one — genuinely has no record, and saying "ready" there would
 * be an interpretation rather than an observation.
 */
function readSetupState(worktree: Pick<WorktreeSnapshot, "setupStatus">): string {
  return worktree.setupStatus?.state ?? "unknown";
}

/**
 * Read one worktree's setup status FROM THE HOST, which is the only authority
 * on it.
 *
 * Deliberately not a renderer-store read. The store is fed by worktree-update
 * events on the project's own port, while a create result answers on the
 * parent-process transport — there is no ordering between the two, so a wait
 * issued immediately after a create can find no row at all and would report
 * `unknown` for a worktree the host had already stamped `pending`. That is the
 * one answer this capability must never give, because `unknown` reads as
 * "nothing will ever arrive" and settles the wait.
 */
async function fetchSetupStatus(
  worktreeId: string
): Promise<WorktreeSnapshot["setupStatus"] | undefined | null> {
  const { worktrees } = await worktreeClient.getAllWithStatus();
  const match = worktrees.find((w) => w.id === worktreeId);
  // `null` distinguishes "the host does not have this worktree" from "the host
  // has it and recorded nothing", which are different answers to the caller.
  return match ? match.setupStatus : null;
}

/**
 * The longest a wait may block. The renderer dispatch path times out at 30s, so
 * a longer wait would be killed mid-flight and reported as a transport failure
 * rather than as "still running" — which is the one answer this capability
 * exists to give honestly. Setup scripts routinely outlast this; the contract is
 * therefore "call again", not "wait longer".
 */
const MAX_WAIT_UNTIL_READY_TIMEOUT_MS = 25_000;

/**
 * How often the wait re-reads the host. Setup stages are seconds apart, and
 * each read is a host round trip rather than a local lookup, so this is
 * deliberately slower than a store poll would need to be.
 */
const WAIT_UNTIL_READY_POLL_INTERVAL_MS = 500;

/** States a wait stops on — every state that is not still in progress. */
const SETTLED_SETUP_STATES = new Set(["ready", "failed", "timed-out", "unknown"]);

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
        setupState: readSetupState(w),
      }));

      return { worktrees: result };
    },
  }));

  actions.set("worktree.getCurrent", () => ({
    id: "worktree.getCurrent",
    title: "Get Current Worktree",
    description:
      "Get the worktree currently in use, which is what most work should be scoped to. Use the full worktree listing only when you genuinely need the others. An empty result means no worktree is active, or the active one can no longer be found — either way, handle it before acting.",
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
        setupState: readSetupState(worktree),
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
        "Work out where a worktree for a given branch would live under the project's configured path pattern. A planning helper and an input to the low-level creator: the managed creator resolves its own path, so calling this first is redundant, and it reserves nothing either way. Name the repository explicitly — there is no active-worktree fallback, which would nest the path inside a linked worktree.",
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
        "Turn a desired branch name into one that is currently free, appending a numeric suffix when the name is taken. Planning and display only: it reserves nothing, so the name can be claimed between this call and the one that uses it. Do not call it before the managed worktree creator, which resolves collisions atomically under its own `collisionPolicy` and reports the branch it actually used.",
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

  actions.set("worktree.waitUntilReady", () =>
    defineAction({
      id: "worktree.waitUntilReady",
      title: "Wait Until Worktree Ready",
      description:
        "Wait for a worktree's post-create setup — config copy, submodules, then the setup script and any resource provisioning — to finish, and report where it got to. Setup can outlive the call that created the worktree, so work started before it completes may run against an unpopulated tree. Pass a zero timeout to read the state without blocking. Running out of time is not a failure: call again.",
      category: "worktree",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      // The shared location shape rather than a hand-rolled `worktreeId`, so
      // this tool takes the same selectors as every other worktree-scoped one
      // and a caller that has a path does not have to go find an id first.
      argsSchema: withWorktreeLocation({
        timeoutMs: z
          .number()
          .int()
          .min(0)
          .max(MAX_WAIT_UNTIL_READY_TIMEOUT_MS)
          .optional()
          .describe(
            `Milliseconds to wait; 0 reads the state now. Default and maximum ${MAX_WAIT_UNTIL_READY_TIMEOUT_MS}. Setup often runs longer, so call again rather than expect one call to cover it.`
          ),
      }).optional(),
      resultSchema: z.object({
        worktreeId: z.string(),
        setupState: WorktreeSetupStateSchema,
        stage: z
          .enum(["copy-config", "submodules", "setup-script"])
          .nullable()
          .describe(
            "Which stage is running, or which one failed. Null before setup starts, and once it is ready or unknown."
          ),
        error: z
          .string()
          .nullable()
          .describe("One-line failure summary when the state is failed or timed-out."),
        timedOut: z
          .boolean()
          .describe(
            "True when the wait ended because it ran out of time rather than because setup settled. The reported state is still live — call again to keep waiting."
          ),
      }),
      mcpOutputSchema: true,
      mcpAnnotations: {
        readOnlyHint: true,
        // A wait's answer depends on when it is asked, so a replay is not
        // guaranteed to match — the same reason `terminal.waitUntilIdle`
        // declares this.
        idempotentHint: false,
        destructiveHint: false,
      },
      run: async (args, ctx: ActionContext) => {
        const { timeoutMs, ...location } = args ?? {};
        const worktreeId = requireWorktreeId(location, ctx);
        const budgetMs = Math.min(
          timeoutMs ?? MAX_WAIT_UNTIL_READY_TIMEOUT_MS,
          MAX_WAIT_UNTIL_READY_TIMEOUT_MS
        );
        const deadline = Date.now() + budgetMs;

        for (;;) {
          const status = await fetchSetupStatus(worktreeId);
          if (status === null) {
            // Static, per the repo-wide rule: an error message must never carry
            // the rejected input back out. The id is the caller's own argument,
            // so naming it adds nothing it does not already have.
            throw new Error("Unknown worktree — the workspace host has no worktree with that id.");
          }
          const state = status?.state ?? "unknown";
          const settled = SETTLED_SETUP_STATES.has(state);
          const remaining = deadline - Date.now();
          if (settled || remaining <= 0) {
            return {
              worktreeId,
              setupState: state,
              stage: status?.stage ?? null,
              error: status?.error ?? null,
              // Only a genuinely unsettled state counts as a timeout. Running
              // out of budget on the same tick a worktree became ready is a
              // completed wait, not an expired one.
              timedOut: !settled,
            };
          }
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(WAIT_UNTIL_READY_POLL_INTERVAL_MS, remaining))
          );
        }
      },
    })
  );
}
