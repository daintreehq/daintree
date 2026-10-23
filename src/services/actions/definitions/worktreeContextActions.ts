import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { defineAction } from "../defineAction";
import { z } from "zod";
import type { ActionContext } from "@shared/types/actions";
import type { BuiltInRuntimeActionId } from "@shared/config/actionIds";
import { getCurrentViewStore, getCurrentViewStoreOrNull } from "@/store/createWorktreeStore";
import { WORKTREE_LABEL_COLOR_NAMES } from "@shared/theme/worktreeColors";
import { GIT_PAGE_LIMIT_DEFAULT, GIT_PAGE_LIMIT_MAX } from "@shared/config/gitReadLimits";
import { WORKTREE_CUSTOM_TITLE_MAX_LENGTH } from "@shared/utils/worktreeCustomTitle";
import { REVIEW_READINESS_ITEM_IDS } from "@/components/Worktree/ReviewHub/reviewReadinessItemIds";
import { fileBrowserArgsSchema, fileBrowserPanelArgsSchema } from "./worktreeContextActionArgs";
import type {
  WorktreeContextActionRunArgs,
  WorktreeContextActionRunId,
} from "./worktreeContextActions.impl";

/**
 * Registered actions a readiness item may suggest to programmatic consumers.
 * The renderer rail dispatches local handlers instead; this closed set exists
 * so MCP/automation results never reference unregistered action ids, and the
 * focus-only CTAs deliberately map to opening Review Hub — a read-only result
 * must not advertise a mutating follow-up (like `git.stageAll`) for what is a
 * "go look" affordance in the UI.
 */
const READINESS_SUGGESTION_ACTION_IDS = [
  "worktree.openReviewHub",
  "git.pullRebase",
  "worktree.openPR",
] as const satisfies readonly BuiltInRuntimeActionId[];

/**
 * Whether the context's worktree has anything `worktree.openChanges` could show.
 * Reads the live store rather than the context because `ActionContext` carries
 * no change data — a synchronous, side-effect-free Map lookup.
 */
function hasOpenableChanges(ctx: ActionContext): boolean {
  const targetWorktreeId = ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
  if (!targetWorktreeId) return false;

  const worktreeChanges = getCurrentViewStore()
    .getState()
    .worktrees.get(targetWorktreeId)?.worktreeChanges;

  return (worktreeChanges?.changes.length ?? 0) > 0;
}

const reviewReadinessItemSchema = z.object({
  id: z.enum(REVIEW_READINESS_ITEM_IDS),
  severity: z.enum(["blocker", "warning", "info"]),
  label: z.string(),
  detail: z.string().optional(),
  actionId: z.enum(READINESS_SUGGESTION_ACTION_IDS).optional(),
  actionArgs: z
    .union([z.object({ worktreeId: z.string() }), z.object({ cwd: z.string() })])
    .optional(),
});

/**
 * A check a plugin published for the worktree (#13806). Advisory and
 * attributed: it is a separate list so the closed `id` set of the host's own
 * items stays the whole of what can block, and nothing here moves `level`,
 * `commitReady`, `pushReady` or `prReady`.
 */
const reviewReadinessPluginCheckSchema = z.object({
  pluginId: z.string(),
  label: z.string(),
  severity: z.enum(["warning", "info"]),
  detail: z.string().optional(),
});

const reviewReadinessResultSchema = z.object({
  worktreeId: z.string(),
  worktreePath: z.string(),
  worktreeName: z.string(),
  branch: z.string().nullable(),
  level: z.enum(["ready", "needs-review", "blocked", "unknown"]),
  commitReady: z.boolean(),
  pushReady: z.boolean(),
  prReady: z.union([z.boolean(), z.literal("unknown")]),
  blockers: z.array(reviewReadinessItemSchema),
  warnings: z.array(reviewReadinessItemSchema),
  infos: z.array(reviewReadinessItemSchema),
  nextActions: z.array(reviewReadinessItemSchema),
  pluginChecks: z.array(reviewReadinessPluginCheckSchema),
  counts: z.object({
    staged: z.number(),
    unstaged: z.number(),
    conflicted: z.number(),
  }),
  aheadCount: z.number().nullable(),
  behindCount: z.number().nullable(),
  pr: z
    .object({
      number: z.number(),
      state: z.enum(["open", "merged", "closed", "declined"]),
      url: z.string().nullable(),
      ciState: z.enum(["success", "failure", "pending", "neutral", "unknown"]).nullable(),
    })
    .nullable(),
  reviewDecision: z.string().nullable(),
  forge: z.object({
    providerId: z.string().nullable(),
    rateLimited: z.boolean(),
    authUnhealthy: z.boolean(),
  }),
});

/**
 * A palette gate rather than `isEnabled`, for the same reason
 * `worktree.openChanges` spells out: `isEnabled` never sees args, so on
 * an explicit `worktreeId` it would answer for the focused worktree instead.
 * Readiness is broader than a worktree now — a scratch or worktree-less
 * project can open its own root (#11482).
 */
function fileBrowserIsReady(ctx: ActionContext): boolean {
  // Resolvability, not mere presence: a stale id whose worktree is gone
  // now makes `run` throw, so a readiness check that only tested for a
  // non-empty string would enable a row that cannot open anything.
  const contextWorktreeId = ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
  if (contextWorktreeId !== undefined) {
    // `OrNull`, not `getCurrentViewStore`: that one throws before the
    // worktree provider mounts, and the action manifest is listed in
    // exactly that window — the throw would disable the row rather than
    // answer it.
    const worktrees = getCurrentViewStoreOrNull()?.getState().worktrees;
    return worktrees ? worktrees.has(contextWorktreeId) : false;
  }
  return Boolean(ctx.projectPath ?? ctx.scratchPath);
}

/**
 * Run bodies load on first dispatch (#14274, after the git pilot in #14239).
 * Every view registers the worktree context actions at boot for menus,
 * keybindings and the MCP manifest, but an empty view runs none of them. A
 * failed chunk load rejects inside `run`, which ActionService turns into an
 * error result like any other failure.
 */
async function runWorktreeContextAction<Id extends WorktreeContextActionRunId>(
  id: Id,
  args: WorktreeContextActionRunArgs<Id>,
  ctx: ActionContext,
  callbacks: ActionCallbacks
): Promise<unknown> {
  const { worktreeContextActionRuns } = await import("./worktreeContextActions.impl");
  return worktreeContextActionRuns[id](args, ctx, callbacks);
}

export function registerWorktreeContextActions(
  actions: ActionRegistry,
  callbacks: ActionCallbacks
): void {
  actions.set("worktree.copyTree", () =>
    defineAction({
      id: "worktree.copyTree",
      title: "Copy worktree context",
      description: "Generate and copy context for a worktree to clipboard",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      // Completion feedback is a transient tooltip pinned to the toolbar's Copy
      // context button (announceCopyTreeCopy), which a shortcut hint on that
      // same button would sit directly on top of. 219e2908f already dismissed
      // the hint for exactly this overlap back when the result showed in a
      // forced tooltip. The hint only fires for source "user", so this costs
      // the toolbar and palette routes nothing the completion notice doesn't
      // already cover, and the keybinding route never raised one (#11735).
      suppressShortcutHint: true,
      argsSchema: z
        .object({
          worktreeId: z.string().optional(),
          format: z.enum(["xml", "json", "markdown", "tree", "ndjson", "sarif"]).optional(),
          modified: z.boolean().optional(),
          includePaths: z
            .array(z.string().min(1))
            .min(1)
            .optional()
            .describe(
              "Worktree-relative minimatch patterns to scope the context to. Patterns match file paths, so a folder needs a glob: pass 'src/panels/**', not 'src/panels'."
            ),
          scopePaths: z
            .array(z.string().min(1))
            .min(1)
            .optional()
            .describe(
              "Worktree-relative literal file or directory paths to walk — not patterns, so pass 'src/panels', not 'src/panels/**'. Ignore rules still resolve from the worktree root, so by default the result matches what a whole-worktree copy would have returned for that subtree — unless scopeIgnoresIgnoreFiles is true. Prefer this over includePaths when selecting a folder. This restricts traversal, so includePaths can only narrow within these paths and never add a file outside them."
            ),
          scopeIgnoresIgnoreFiles: z
            .boolean()
            .optional()
            .describe(
              "Lets scopePaths into subtrees an ignore file would have pruned (default false). Requires scopePaths and is rejected without it. Set true when a path you named is being dropped by a `.copytreeignore` or `.gitignore` rule: only the rules blocking entry into each scoped path are removed. Unrelated rules, ignore files inside a scoped folder, project and config exclusions such as node_modules, `.git`, `modified`, and every budget all still apply. To get past a rule declared inside a selected folder, scope the exact file instead of that folder — a scoped directory subsumes any of its children you also list."
            ),
        })
        // Same guard as `CopyTreeOptionsSchema`, restated because this action
        // hand-rolls its args rather than reusing that schema — the field would
        // otherwise reach the service unaccompanied and do nothing (#11750).
        .superRefine((args, ctx) => {
          if (args.scopeIgnoresIgnoreFiles === true && !args.scopePaths?.length) {
            ctx.addIssue({
              code: "custom",
              path: ["scopeIgnoresIgnoreFiles"],
              message: "scopeIgnoresIgnoreFiles requires scopePaths",
            });
          }
        })
        .optional(),
      run: (args, ctx) => runWorktreeContextAction("worktree.copyTree", args, ctx, callbacks),
    })
  );

  actions.set("worktree.copyContext", () =>
    defineAction({
      id: "worktree.copyContext",
      title: "Copy worktree context (alias)",
      description:
        "Alias for generating a worktree context bundle. It accepts a subset of the copy-tree capability's arguments — path scoping is not available here, so use that capability directly for a scoped copy.",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z
        .object({
          worktreeId: z.string().optional(),
          format: z.enum(["xml", "json", "markdown", "tree", "ndjson", "sarif"]).optional(),
          modified: z.boolean().optional(),
        })
        .optional(),
      run: (args, ctx) => runWorktreeContextAction("worktree.copyContext", args, ctx, callbacks),
    })
  );

  actions.set("worktree.inject", () =>
    defineAction({
      id: "worktree.inject",
      title: "Inject worktree context into focused terminal",
      description: "Inject this worktree's context into the currently focused terminal",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z
        .object({
          worktreeId: z.string().optional(),
        })
        .optional(),
      isEnabled: (ctx: ActionContext) => {
        const hasFocusedTerminal = Boolean(ctx.focusedTerminalId);
        return hasFocusedTerminal;
      },
      disabledReason: (ctx: ActionContext) => {
        const hasFocusedTerminal = Boolean(ctx.focusedTerminalId);
        if (!hasFocusedTerminal) {
          return "No focused terminal to inject into";
        }
        return undefined;
      },
      run: (args, ctx) => runWorktreeContextAction("worktree.inject", args, ctx, callbacks),
    })
  );

  actions.set("worktree.setLabelColor", () =>
    defineAction({
      id: "worktree.setLabelColor",
      title: "Set worktree label colour",
      description:
        "Marks a worktree with a colour on its sidebar card so the user can pick it out. The same colour replaces its automatic one in panel headers and pickers. Cosmetic only.",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      keywords: ["label", "colour", "color", "tag", "mark", "highlight"],
      argsSchema: z.object({
        worktreeId: z.string().min(1).describe("Worktree id, from the worktree list"),
        color: z
          .enum(WORKTREE_LABEL_COLOR_NAMES)
          .nullable()
          .describe("Label colour; null clears it"),
      }),
      run: (args, ctx) => runWorktreeContextAction("worktree.setLabelColor", args, ctx, callbacks),
    })
  );

  actions.set("worktree.setCustomTitle", () =>
    defineAction({
      id: "worktree.setCustomTitle",
      title: "Set worktree title",
      description:
        "Names a worktree with a custom title shown in place of its issue, PR or branch headline on its card and in pickers. The computed headline stays visible beneath it. Cosmetic only.",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      keywords: ["title", "name", "rename", "label", "custom"],
      argsSchema: z.object({
        worktreeId: z.string().min(1).describe("Worktree id, from the worktree list"),
        title: z
          .string()
          .nullable()
          .describe(
            `Custom title, at most ${WORKTREE_CUSTOM_TITLE_MAX_LENGTH} characters after whitespace is collapsed; null or blank clears it`
          ),
      }),
      run: (args, ctx) => runWorktreeContextAction("worktree.setCustomTitle", args, ctx, callbacks),
    })
  );

  actions.set("worktree.openEditor", () =>
    defineAction({
      id: "worktree.openEditor",
      title: "Open in editor",
      description: "Open a worktree folder in the project's configured external editor",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({ worktreeId: z.string().optional() }).optional(),
      run: (args, ctx) => runWorktreeContextAction("worktree.openEditor", args, ctx, callbacks),
    })
  );

  actions.set("worktree.openReviewHub", () =>
    defineAction({
      id: "worktree.openReviewHub",
      title: "Open review hub",
      description: "Open the Review Hub for a worktree to review uncommitted changes",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({ worktreeId: z.string().optional() }).optional(),
      run: (args, ctx) => runWorktreeContextAction("worktree.openReviewHub", args, ctx, callbacks),
    })
  );

  actions.set("worktree.openChanges", () =>
    defineAction({
      id: "worktree.openChanges",
      title: "Open changes",
      description:
        "Open the working-tree diff for a worktree on its highest-churn changed file, seeded with the full change set so the diff sidebar can step between every changed file",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      // Deliberately a palette gate, not `isEnabled`. `isEnabled` gates dispatch
      // on ActionContext alone — it never sees args — so on an explicit
      // `worktreeId` it would answer for the *focused* worktree instead: it
      // would refuse a dirty target while a clean one held focus, and, worse,
      // pass for a clean target while a dirty one held focus, letting dispatch
      // report ok for a run() that opened nothing. Gating only the palette row
      // keeps the disabled-with-reason affordance where context IS the target.
      palette: {
        mode: "requireContext",
        isReady: (ctx: ActionContext) => hasOpenableChanges(ctx),
        reason: "No changes in the focused worktree",
      },
      argsSchema: z.object({ worktreeId: z.string().optional() }).optional(),
      run: (args, ctx) => runWorktreeContextAction("worktree.openChanges", args, ctx, callbacks),
    })
  );

  actions.set("worktree.openFileBrowser", () =>
    defineAction({
      id: "worktree.openFileBrowser",
      title: "Browse files",
      description:
        "Show a folder in a temporary read-only file browser dialog, optionally revealing one path inside it. The dialog is deliberately ephemeral — it never counts toward the panel limit and is never restored on restart. Open the persistent grid browser instead when it should stay put.",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      // Hidden rather than gated: the persistent sibling below carries the same
      // title, and two indistinguishable "Browse files" rows differing only in
      // how long the result survives is a coin toss the user cannot see (#11666).
      // The action stays registered and dispatchable — the path-targeted
      // callers that want a throwaway reveal still name it directly.
      palette: { mode: "hidden" },
      argsSchema: fileBrowserArgsSchema,
      run: (args, ctx) =>
        runWorktreeContextAction("worktree.openFileBrowser", args, ctx, callbacks),
    })
  );

  actions.set("worktree.openFileBrowserPanel", () =>
    defineAction({
      id: "worktree.openFileBrowserPanel",
      title: "Browse files",
      description:
        "Show a folder in a persistent read-only file browser panel, for a worktree or for the current project or scratch folder when no worktree is selected. It focuses the existing browser for the same folder on the same surface rather than opening a second one, and applies an optional reveal path to it.",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      keywords: ["files", "browse", "explorer", "tree", "folder", "finder", "assets", "panel"],
      palette: {
        mode: "requireContext",
        isReady: fileBrowserIsReady,
        reason: "No folder to browse",
      },
      argsSchema: fileBrowserPanelArgsSchema,
      run: (args, ctx) =>
        runWorktreeContextAction("worktree.openFileBrowserPanel", args, ctx, callbacks),
    })
  );

  actions.set("worktree.reveal", () =>
    defineAction({
      id: "worktree.reveal",
      title: "Reveal worktree",
      description: "Reveal a worktree folder in the OS file manager",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({ worktreeId: z.string().optional() }).optional(),
      run: (args, ctx) => runWorktreeContextAction("worktree.reveal", args, ctx, callbacks),
    })
  );

  actions.set("worktree.compareDiff", () =>
    defineAction({
      id: "worktree.compareDiff",
      title: "Compare worktree diff",
      description:
        "Compare two worktrees and list the files that differ between their branches, a page at a time. Use this to survey the shape of a change; read a single file's diff afterwards for its contents. It is read-only and opens no UI. Ask for the merge-base comparison when the goal is to see what a pull request would show, rather than every difference between the two tips.",
      category: "worktree",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({
        worktreeId: z.string().optional(),
        compareToWorktreeId: z.string(),
        useMergeBase: z.boolean().optional(),
        ignoreWhitespace: z.boolean().optional(),
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
            `Files per page (default ${GIT_PAGE_LIMIT_DEFAULT}, max ${GIT_PAGE_LIMIT_MAX}).`
          ),
      }),
      resultSchema: z.object({
        branch1: z.string(),
        branch2: z.string(),
        files: z.array(
          z.object({
            path: z.string(),
            oldPath: z.string().optional(),
            status: z.string(),
            insertions: z.number().nullable(),
            deletions: z.number().nullable(),
          })
        ),
        total: z.number(),
        hasMore: z.boolean(),
        offset: z.number(),
        limit: z.number(),
        nextOffset: z.number().nullable(),
      }),
      mcpOutputSchema: true,
      mcpAnnotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
      run: (args, ctx) => runWorktreeContextAction("worktree.compareDiff", args, ctx, callbacks),
    })
  );

  actions.set("worktree.reviewReadiness", () =>
    defineAction({
      id: "worktree.reviewReadiness",
      title: "Review readiness",
      description:
        "Judge whether a worktree is ready to commit, push and merge, listing what blocks it. Read-only. Signals needing forge data that has not arrived report unknown, not passing; never read unknown as green.",
      category: "worktree",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({ worktreeId: z.string().optional() }).optional(),
      resultSchema: reviewReadinessResultSchema,
      mcpOutputSchema: true,
      mcpAnnotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
      run: (args, ctx) =>
        runWorktreeContextAction("worktree.reviewReadiness", args, ctx, callbacks),
    })
  );
}
