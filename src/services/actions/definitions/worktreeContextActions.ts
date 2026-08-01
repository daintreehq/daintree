import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { defineAction } from "../defineAction";
import { z } from "zod";
import type { ActionContext } from "@shared/types/actions";
import type { BuiltInRuntimeActionId } from "@shared/config/actionIds";
import { copyTreeClient, systemClient } from "@/clients";
import { actionService } from "@/services/ActionService";
import { getCurrentViewStore, getCurrentViewStoreOrNull } from "@/store/createWorktreeStore";
import { useForgeProviderHealthStore } from "@/store/forgeProviderHealthStore";
import { DEFAULT_COPYTREE_FORMAT } from "@/lib/copyTreeFormat";
import { deriveCommitMessageSeed } from "@/lib/worktreeAiNote";
import { buildWorkingTreeDiffModel } from "@/lib/workingTreeDiff";
import { basename } from "@shared/utils/path";
import { paginate } from "@shared/utils/boundedOutput";
import { GIT_PAGE_LIMIT_DEFAULT, GIT_PAGE_LIMIT_MAX } from "@shared/config/gitReadLimits";
import {
  deriveReviewReadiness,
  REVIEW_READINESS_ITEM_IDS,
  type ReviewReadinessCta,
  type ReviewReadinessItem,
} from "@/components/Worktree/ReviewHub/reviewReadiness";

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

type ReadinessActionSuggestion =
  | {
      actionId: "worktree.openReviewHub" | "worktree.openPR";
      actionArgs: { worktreeId: string };
    }
  | { actionId: "git.pullRebase"; actionArgs: { cwd: string } };

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

/**
 * Args always target the inspected worktree explicitly — the suggested
 * actions fall back to the focused/active worktree when args are omitted,
 * which is wrong whenever `worktree.reviewReadiness` was queried for another.
 */
function toReadinessActionSuggestion(
  cta: ReviewReadinessCta,
  target: { worktreeId: string; worktreePath: string }
): ReadinessActionSuggestion {
  switch (cta.kind) {
    case "focus-conflicts":
    case "focus-staged":
      return {
        actionId: "worktree.openReviewHub",
        actionArgs: { worktreeId: target.worktreeId },
      };
    case "pull-rebase":
      return { actionId: "git.pullRebase", actionArgs: { cwd: target.worktreePath } };
    case "open-pr":
      return { actionId: "worktree.openPR", actionArgs: { worktreeId: target.worktreeId } };
  }
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

function toReadinessResultItem(
  item: ReviewReadinessItem,
  target: { worktreeId: string; worktreePath: string }
) {
  return {
    id: item.id,
    severity: item.severity,
    label: item.label,
    ...(item.detail !== undefined ? { detail: item.detail } : {}),
    ...(item.action !== undefined ? toReadinessActionSuggestion(item.action, target) : {}),
  };
}

export function registerWorktreeContextActions(
  actions: ActionRegistry,
  callbacks: ActionCallbacks
): void {
  actions.set("worktree.copyTree", () =>
    defineAction({
      id: "worktree.copyTree",
      title: "Copy Worktree Context",
      description: "Generate and copy context for a worktree to clipboard",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z
        .object({
          worktreeId: z.string().optional(),
          format: z.enum(["xml", "json", "markdown", "tree", "ndjson", "sarif"]).optional(),
          modified: z.boolean().optional(),
          includePaths: z
            .array(z.string())
            .optional()
            .describe(
              "Worktree-relative minimatch patterns to scope the context to. Patterns match file paths, so a folder needs a glob: pass 'src/panels/**', not 'src/panels'."
            ),
          scopePaths: z
            .array(z.string().min(1))
            .min(1)
            .optional()
            .describe(
              "Worktree-relative literal file or directory paths to walk — not patterns, so pass 'src/panels', not 'src/panels/**'. Ignore rules still resolve from the worktree root, so the result matches what a whole-worktree copy would have returned for that subtree. Prefer this over includePaths when selecting a folder."
            ),
        })
        .optional(),
      run: async (args, ctx: ActionContext) => {
        const worktreeId = args?.worktreeId;
        const explicitFormat = args?.format;
        const modified = args?.modified;
        const includePaths = args?.includePaths;
        const scopePaths = args?.scopePaths;
        const targetWorktreeId = worktreeId ?? ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
        if (!targetWorktreeId) return null;

        const format = explicitFormat ?? DEFAULT_COPYTREE_FORMAT;

        const result = await copyTreeClient.generateAndCopyFile(targetWorktreeId, {
          format,
          modified,
          ...(includePaths && includePaths.length > 0 ? { includePaths } : {}),
          ...(scopePaths && scopePaths.length > 0 ? { scopePaths } : {}),
        });

        if (result.error) {
          if (modified && result.error.includes("No valid files")) {
            throw new Error("No modified files to copy. Make some changes first.");
          }
          throw new Error(result.error);
        }

        return {
          worktreeId: targetWorktreeId,
          fileCount: result.fileCount,
          stats: result.stats ?? null,
          format,
        };
      },
    })
  );

  actions.set("worktree.copyContext", () =>
    defineAction({
      id: "worktree.copyContext",
      title: "Copy Worktree Context (Alias)",
      description:
        "Alias for generating a worktree context bundle; behaves identically to the copy-tree capability.",
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
      run: async (args) => {
        const result = await actionService.dispatch("worktree.copyTree", args, { source: "user" });
        if (!result.ok) {
          throw new Error(result.error.message);
        }
        return result.result as unknown;
      },
    })
  );

  actions.set("worktree.inject", () =>
    defineAction({
      id: "worktree.inject",
      title: "Inject Worktree Context into Focused Terminal",
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
      run: async (args, ctx: ActionContext) => {
        const hasFocusedTerminal = Boolean(ctx.focusedTerminalId);
        if (!hasFocusedTerminal) {
          throw new Error("No focused terminal to inject into");
        }
        const worktreeId = args?.worktreeId;
        const targetWorktreeId = worktreeId ?? ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
        if (!targetWorktreeId) {
          throw new Error("No worktree selected");
        }
        callbacks.onInject(targetWorktreeId);
      },
    })
  );

  actions.set("worktree.openEditor", () =>
    defineAction({
      id: "worktree.openEditor",
      title: "Open in Editor",
      description: "Open a worktree folder in the OS file manager / editor",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({ worktreeId: z.string().optional() }).optional(),
      run: async (args, ctx: ActionContext) => {
        const worktreeId = args?.worktreeId;
        const targetWorktreeId = worktreeId ?? ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
        if (!targetWorktreeId) return;

        const worktree = getCurrentViewStore().getState().worktrees.get(targetWorktreeId);
        if (!worktree) return;

        await systemClient.openPath(worktree.path);
      },
    })
  );

  actions.set("worktree.openReviewHub", () =>
    defineAction({
      id: "worktree.openReviewHub",
      title: "Open Review Hub",
      description: "Open the Review Hub for a worktree to review uncommitted changes",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({ worktreeId: z.string().optional() }).optional(),
      run: async (args, ctx: ActionContext) => {
        const worktreeId = args?.worktreeId;
        const targetWorktreeId = worktreeId ?? ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
        if (!targetWorktreeId) return;

        const worktree = getCurrentViewStore().getState().worktrees.get(targetWorktreeId);
        if (!worktree) return;

        // Imported lazily, like `fleetActions` does with ActionService: a static
        // import pulls panelStore -> panelPersistence into this module's graph,
        // and that reads `projectClient` from `@/clients` at module scope. Every
        // action test that mocks `@/clients` without it then dies at import.
        const { usePanelDialogStore } = await import("@/store/panelDialogStore");

        await usePanelDialogStore.getState().openPanelDialog({
          kind: "review",
          title: "Review & Commit",
          worktreeId: targetWorktreeId,
          // The AI note's first line if it is still current, else "". Never any
          // other source — a substituted commit message caused a real bad push
          // to a shared branch (#7884).
          initialCommitMessage: deriveCommitMessageSeed(worktree, Date.now()),
          autoStageOnOpen: true,
        });
      },
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
      run: async (args, ctx: ActionContext) => {
        const worktreeId = args?.worktreeId;
        const targetWorktreeId = worktreeId ?? ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
        if (!targetWorktreeId) return;

        // Read straight from the store: WorktreeMonitor keeps `worktreeChanges`
        // current with no component mounted, so this opens a fresh set even from
        // a collapsed card, where the Changed Files list does not exist.
        const worktreeChanges = getCurrentViewStore()
          .getState()
          .worktrees.get(targetWorktreeId)?.worktreeChanges;
        if (!worktreeChanges || worktreeChanges.changes.length === 0) return;

        const { diffChangeSet } = buildWorkingTreeDiffModel(
          worktreeChanges.changes,
          worktreeChanges.rootPath
        );
        const firstChange = diffChangeSet[0];
        if (!firstChange) return;

        // Lazily imported for the same reason as the review hub below.
        const { usePanelDialogStore } = await import("@/store/panelDialogStore");

        await usePanelDialogStore.getState().openPanelDialog({
          kind: "diff",
          filePath: firstChange.path,
          fileStatus: firstChange.status,
          diffSource: "working-tree",
          changeSet: diffChangeSet,
          viewedKey: firstChange.viewedKey,
          title: basename(firstChange.path),
          worktreeId: targetWorktreeId,
        });
      },
    })
  );

  actions.set("worktree.openFileBrowser", () =>
    defineAction({
      id: "worktree.openFileBrowser",
      title: "Browse files",
      description:
        "Open a read-only file browser for a worktree, or for the current project or scratch folder when no worktree is selected",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      // A palette gate rather than `isEnabled`, for the same reason
      // `worktree.openChanges` above spells out: `isEnabled` never sees args,
      // so on an explicit `worktreeId` it would answer for the focused
      // worktree instead. Readiness is broader than a worktree now — a scratch
      // or worktree-less project can open its own root (#11482).
      palette: {
        mode: "requireContext",
        isReady: (ctx: ActionContext) => {
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
        },
        reason: "No folder to browse",
      },
      argsSchema: z
        .object({
          // `.min(1)`, unlike the siblings above: an empty string here is not a
          // harmless falsy worktree — it would slip past the unknown-worktree
          // guard and open the workspace root instead of failing.
          worktreeId: z.string().min(1).optional(),
          /** Path relative to the browser root, to select and scroll into view on open. */
          revealPath: z.string().optional(),
          /**
           * What `revealPath` points at. A directory is also expanded so its
           * children are visible; the caller knows (it validated the path),
           * and re-statting here would be a second round-trip for one bit.
           */
          revealKind: z.enum(["file", "directory"]).optional(),
        })
        .optional(),
      run: async (args, ctx: ActionContext) => {
        const targetWorktreeId = args?.worktreeId ?? ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
        const worktree = targetWorktreeId
          ? getCurrentViewStore().getState().worktrees.get(targetWorktreeId)
          : undefined;

        // One rule for every source of the id, explicit arg or ambient context:
        // a named worktree that doesn't resolve is an error, never a cue to
        // browse something else. Falling through to the workspace root would
        // open the folder *above* the one named — the wrong folder, not a
        // degraded one — and a stale `focusedWorktreeId` outliving its deleted
        // worktree is exactly how that would happen unnoticed.
        if (targetWorktreeId !== undefined && !worktree) {
          throw new Error(`Worktree not found: ${targetWorktreeId}`);
        }

        // No worktree id at all is the normal state in a scratch or a
        // worktree-less project (#11482) — browse the workspace root instead of
        // silently doing nothing. The context provider resolves both pointers
        // from one view-scoped lookup, so only one of them is ever set and this
        // names the folder `useWorkspaceRootPath` opens; the project-first
        // tie-break is a defensive echo of `resolveWorkspaceCwd`, not a choice
        // this action is expected to have to make.
        const workspacePath = ctx.projectPath ?? ctx.scratchPath;
        if (!worktree && !workspacePath) {
          // Thrown, not a bare return: a silent no-op still reports ok from
          // dispatch, so the palette and quick action would look like they
          // worked.
          throw new Error("No folder to browse");
        }
        const workspaceTitle = worktree
          ? undefined
          : `Files — ${ctx.projectName ?? ctx.scratchName ?? (workspacePath ? basename(workspacePath) : "workspace")}`;

        // Lazily imported for the same reason as the review hub above: a static
        // import drags panelStore -> panelPersistence in, which reads
        // `projectClient` from `@/clients` at module scope and breaks every
        // action test that mocks `@/clients` without it.
        const { usePanelDialogStore } = await import("@/store/panelDialogStore");

        // Normalized to "/" regardless of caller: the tree's row keys and
        // `ancestorDirectories` both speak forward slashes, and a
        // Windows-shaped reveal path would otherwise select nothing.
        const revealPath = args?.revealPath?.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
        let reveal: { browserSelectedPath: string; browserExpandedPaths: string[] } | undefined;
        if (revealPath) {
          const { ancestorDirectories } = await import("@/panels/file-browser/fileBrowserTree");
          const expanded = new Set(ancestorDirectories(revealPath));
          if (args?.revealKind === "directory") expanded.add(revealPath);
          reveal = {
            browserSelectedPath: revealPath,
            browserExpandedPaths: [...expanded].sort(),
          };
        }

        // No `worktreeId` for a workspace root: its absence is what tells the
        // create path to resolve the view's own workspace folder, which nothing
        // ever names explicitly. `createFileBrowserDefaults` records that as
        // `browserWorkspaceRooted`, since grid promotion later stamps a
        // placement worktreeId onto the panel (#11489).
        await usePanelDialogStore.getState().openPanelDialog({
          kind: "file-browser",
          title: worktree ? `Files — ${worktree.branch ?? worktree.name}` : workspaceTitle,
          ...(worktree && { worktreeId: targetWorktreeId }),
          ...reveal,
        });
      },
    })
  );

  actions.set("worktree.reveal", () =>
    defineAction({
      id: "worktree.reveal",
      title: "Reveal Worktree",
      description: "Reveal a worktree folder in the OS file manager",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({ worktreeId: z.string().optional() }).optional(),
      run: async (args, ctx: ActionContext) => {
        const worktreeId = args?.worktreeId;
        const targetWorktreeId = worktreeId ?? ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
        if (!targetWorktreeId) return;
        const worktree = getCurrentViewStore().getState().worktrees.get(targetWorktreeId);
        if (!worktree) return;
        await systemClient.openPath(worktree.path);
      },
    })
  );

  actions.set("worktree.compareDiff", () =>
    defineAction({
      id: "worktree.compareDiff",
      title: "Compare Worktree Diff",
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
      run: async (args, ctx: ActionContext) => {
        const leftId = args.worktreeId ?? ctx.focusedWorktreeId ?? ctx.activeWorktreeId ?? null;
        if (!leftId) {
          throw new Error(
            "No base worktree to compare from. Pass `worktreeId` or focus a worktree first."
          );
        }
        const rightId = args.compareToWorktreeId;

        const worktrees = getCurrentViewStore().getState().worktrees;
        const left = worktrees.get(leftId);
        if (!left) {
          throw new Error(`Worktree not found: ${leftId}`);
        }
        const right = worktrees.get(rightId);
        if (!right) {
          throw new Error(`Worktree not found: ${rightId}`);
        }
        if (!left.branch) {
          throw new Error(`Worktree '${leftId}' has no branch (detached HEAD); cannot compare.`);
        }
        if (!right.branch) {
          throw new Error(`Worktree '${rightId}' has no branch (detached HEAD); cannot compare.`);
        }

        const res = await window.electron.git.compareWorktrees(
          left.path,
          left.branch,
          right.branch,
          undefined,
          args.useMergeBase,
          args.ignoreWhitespace
        );
        if (typeof res === "string") {
          throw new Error("Unexpected diff string from worktree comparison; expected a file list.");
        }

        const start = Math.max(Math.trunc(args.offset ?? 0) || 0, 0);
        const size = Math.min(
          Math.max(Math.trunc(args.limit ?? GIT_PAGE_LIMIT_DEFAULT) || 1, 1),
          GIT_PAGE_LIMIT_MAX
        );
        const page = paginate(res.files ?? [], start, size);

        return {
          branch1: res.branch1,
          branch2: res.branch2,
          files: page.items.map((file) => ({
            path: file.path,
            oldPath: file.oldPath,
            status: file.status,
            insertions: file.insertions,
            deletions: file.deletions,
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

  actions.set("worktree.reviewReadiness", () =>
    defineAction({
      id: "worktree.reviewReadiness",
      title: "Review Readiness",
      description:
        "Judge whether a worktree is ready to commit, push and merge, and list what is blocking it. This is a read-only summary that runs no git or forge operation itself. Signals that depend on forge data report as unknown rather than as passing when that data has not arrived, so an unknown is genuinely unknown and should not be read as a green light.",
      category: "worktree",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({ worktreeId: z.string().optional() }).optional(),
      resultSchema: reviewReadinessResultSchema,
      mcpOutputSchema: true,
      mcpAnnotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
      run: async (args, ctx: ActionContext) => {
        const targetWorktreeId =
          args?.worktreeId ?? ctx.focusedWorktreeId ?? ctx.activeWorktreeId ?? null;
        if (!targetWorktreeId) {
          throw new Error("No worktree to inspect. Pass `worktreeId` or focus a worktree first.");
        }
        const worktree = getCurrentViewStore().getState().worktrees.get(targetWorktreeId);
        if (!worktree) {
          throw new Error(`Worktree not found: ${targetWorktreeId}`);
        }

        const status = await window.electron.git.getStagingStatus(worktree.path);
        const linkedPr = worktree.linked?.pr ?? null;
        const pr = linkedPr
          ? {
              number: linkedPr.ref.number,
              url: linkedPr.url,
              state: linkedPr.state,
              ciState: linkedPr.ciStatus?.state ?? null,
            }
          : null;
        const providerId = worktree.linked?.providerId ?? worktree.matchedForgeProviderId ?? null;
        const health = providerId
          ? (useForgeProviderHealthStore.getState().providers[providerId] ?? null)
          : null;

        const summary = deriveReviewReadiness({
          status,
          aheadCount: worktree.aheadCount ?? null,
          behindCount: worktree.behindCount ?? null,
          pr,
          providerHealth: health
            ? { rateLimitBlocked: health.rateLimitBlocked, tokenUnhealthy: health.tokenUnhealthy }
            : null,
        });

        const target = { worktreeId: targetWorktreeId, worktreePath: worktree.path };
        return {
          worktreeId: targetWorktreeId,
          worktreePath: worktree.path,
          worktreeName: worktree.name,
          branch: status.currentBranch,
          level: summary.level,
          commitReady: summary.commitReady,
          pushReady: summary.pushReady,
          prReady: summary.prReady,
          blockers: summary.blockers.map((i) => toReadinessResultItem(i, target)),
          warnings: summary.warnings.map((i) => toReadinessResultItem(i, target)),
          infos: summary.infos.map((i) => toReadinessResultItem(i, target)),
          nextActions: summary.nextActions.map((i) => toReadinessResultItem(i, target)),
          counts: {
            staged: status.staged.length,
            unstaged: status.unstaged.length,
            conflicted: status.conflicted.length,
          },
          aheadCount: worktree.aheadCount ?? null,
          behindCount: worktree.behindCount ?? null,
          pr: pr
            ? { number: pr.number, state: pr.state, url: pr.url ?? null, ciState: pr.ciState }
            : null,
          // Not derivable from the worktree snapshot today; kept in the schema
          // so consumers get a stable shape when a provider-neutral review
          // decision lands (shared/types/forge.ts NormalizedReviewDecision).
          reviewDecision: null,
          forge: {
            providerId,
            rateLimited: health?.rateLimitBlocked ?? false,
            authUnhealthy: health?.tokenUnhealthy ?? false,
          },
        };
      },
    })
  );
}
