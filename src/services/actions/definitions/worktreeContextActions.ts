import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { defineAction } from "../defineAction";
import { z } from "zod";
import type { ActionContext } from "@shared/types/actions";
import type { BuiltInRuntimeActionId } from "@shared/config/actionIds";
import type { CopyTreeResult } from "@shared/types";
import { copyTreeClient, systemClient } from "@/clients";
import { resolveCopyTreeRunSource } from "@/lib/copyTreeRunSource";
import { actionService } from "@/services/ActionService";
import { getCurrentViewStore, getCurrentViewStoreOrNull } from "@/store/createWorktreeStore";
import { useForgeProviderHealthStore } from "@/store/forgeProviderHealthStore";
// Static, unlike the panel stores below: both are leaf modules (a lease map and
// a zustand store) that pull in no client graph, and they are the same two
// guards `panelStore.addPanel` reads before it decides whether a spawn may
// take focus.
import { isMcpSpawnFocusSuppressed } from "@/store/mcpSpawnFocusGuard";
import { isAssistantFocused } from "@/store/macroFocusStore";
import { DEFAULT_COPYTREE_FORMAT } from "@/lib/copyTreeFormat";
import { formatCopyResultMessage } from "@/lib/formatCopyResult";
import { announceCopyTreeCopy } from "@/lib/copyTreeFeedback";
import { useCopyTreeRunStore } from "@/store/copyTreeRunStore";
import { deriveCommitMessageSeed } from "@/lib/worktreeAiNote";
import { buildWorkingTreeDiffModel } from "@/lib/workingTreeDiff";
import { basename } from "@shared/utils/path";
// Static, unlike the stores below: this module carries the panel types plus a
// handful of pure predicates over them, so it drags in no client or store graph.
import {
  isFileBrowserPanel,
  isGridPanelLocation,
  type FileBrowserPanelData,
} from "@shared/types/panel";
import { isForegroundDispatch } from "./dispatchSource";
import { PANEL_LIMIT_ERROR_SUFFIX } from "./panelLimitError";
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

/**
 * Args shared by both file-browser openers. The two actions differ only in the
 * surface they present on, so a caller that knows what it wants to browse
 * names it identically either way — and `revealPath` in particular must not
 * become the thing that picks a surface, since revealing the root passes no
 * path while still carrying a `revealKind` (#11666).
 */
const fileBrowserArgsSchema = z
  .object({
    // `.min(1)`, unlike the siblings above: an empty string here is not a
    // harmless falsy worktree — it would slip past the unknown-worktree
    // guard and open the workspace root instead of failing.
    worktreeId: z.string().min(1).optional(),
    /**
     * Path to select and scroll into view on open, relative to the worktree or
     * workspace root — the same base `browserSelectedPath` is stored against,
     * not the tree's current scoped root. Every caller computes it that way,
     * and a path relative to a scope the caller cannot see would be
     * unresolvable from outside the panel.
     */
    revealPath: z.string().optional(),
    /**
     * What `revealPath` points at. A directory is also expanded so its
     * children are visible; the caller knows (it validated the path),
     * and re-statting here would be a second round-trip for one bit.
     */
    revealKind: z.enum(["file", "directory"]).optional(),
  })
  .optional();

type FileBrowserArgs = z.infer<typeof fileBrowserArgsSchema>;

/**
 * A palette gate rather than `isEnabled`, for the same reason
 * `worktree.openChanges` above spells out: `isEnabled` never sees args, so on
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
 * The folder both openers browse, resolved once from explicit arg, focus, then
 * ambient context — and the title that names it.
 *
 * `worktreeId` comes back only for a resolved worktree: its absence is what
 * tells the create path to resolve the view's own workspace folder, which
 * nothing ever names explicitly. `createFileBrowserDefaults` records that as
 * `browserWorkspaceRooted`, since grid placement later stamps a worktreeId onto
 * the panel (#11489) — so neither opener may pass that flag itself.
 */
function resolveFileBrowserTarget(
  args: FileBrowserArgs,
  ctx: ActionContext
): { worktreeId: string | undefined; title: string | undefined } {
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

  if (worktree) {
    return { worktreeId: targetWorktreeId, title: `Files — ${worktree.branch ?? worktree.name}` };
  }
  return {
    worktreeId: undefined,
    title: `Files — ${ctx.projectName ?? ctx.scratchName ?? (workspacePath ? basename(workspacePath) : "workspace")}`,
  };
}

/**
 * Whether a base-relative path is visible in a tree scoped to `root`.
 *
 * Segment-wise rather than a bare `startsWith`, which would call `srcx/a.ts` a
 * child of `src`. An absent or empty root is the base itself, which contains
 * everything.
 */
function isWithinBrowserRoot(path: string, root: string | undefined): boolean {
  if (!root) return true;
  return path === root || path.startsWith(`${root}/`);
}

/** Selection and expansion state for a requested reveal, or nothing to reveal. */
async function resolveFileBrowserReveal(
  args: FileBrowserArgs
): Promise<{ browserSelectedPath: string; browserExpandedPaths: string[] } | undefined> {
  // Normalized to "/" regardless of caller: the tree's row keys and
  // `ancestorDirectories` both speak forward slashes, and a
  // Windows-shaped reveal path would otherwise select nothing.
  const revealPath = args?.revealPath?.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!revealPath) return undefined;

  const { ancestorDirectories } = await import("@/panels/file-browser/fileBrowserTree");
  const expanded = new Set(ancestorDirectories(revealPath));
  if (args?.revealKind === "directory") expanded.add(revealPath);
  return { browserSelectedPath: revealPath, browserExpandedPaths: [...expanded].sort() };
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
      run: async (args, ctx: ActionContext) => {
        const worktreeId = args?.worktreeId;
        const explicitFormat = args?.format;
        const modified = args?.modified;
        const includePaths = args?.includePaths;
        const scopePaths = args?.scopePaths;
        const scopeIgnoresIgnoreFiles = args?.scopeIgnoresIgnoreFiles;
        const targetWorktreeId = worktreeId ?? ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
        if (!targetWorktreeId) return null;

        const format = explicitFormat ?? DEFAULT_COPYTREE_FORMAT;

        // Bracketed for the toolbar spinner, whoever dispatched — an MCP copy
        // spins the Copy context button the same as a clicked one. After the
        // no-worktree return so a refused dispatch never blips it.
        const runStore = useCopyTreeRunStore.getState();
        runStore.beginRun();
        let result: CopyTreeResult;
        try {
          result = await copyTreeClient.generateAndCopyFile(
            targetWorktreeId,
            {
              format,
              modified,
              ...(includePaths && includePaths.length > 0 ? { includePaths } : {}),
              ...(scopePaths && scopePaths.length > 0 ? { scopePaths } : {}),
              // Only forwarded when true, matching the conditional spreads
              // above: the field is absent-means-default, so an explicit `false`
              // is noise in the payload. (History would dedupe it onto the same
              // entry either way — `canonicalizeCopyTreeOptions` folds exact
              // `false` away — so this is about keeping the request honest, not
              // about the run history.)
              ...(scopeIgnoresIgnoreFiles === true ? { scopeIgnoresIgnoreFiles } : {}),
            },
            resolveCopyTreeRunSource(ctx.dispatchSource, ctx.copyTreeRunSource)
          );
        } finally {
          runStore.endRun();
        }

        if (result.error) {
          if (modified && result.error.includes("No valid files")) {
            throw new Error("No modified files to copy. Make some changes first.");
          }
          throw new Error(result.error);
        }

        // Every route into this action except the context menu ends here with
        // nothing on screen to say the clipboard changed: the toolbar button,
        // Cmd+Shift+C, the palette, the `worktree.copyContext` alias, and any
        // agent dispatch. `copyContextWithFeedback` is the sole "context-menu"
        // caller and updates its own spinner toast in place, so announcing here
        // too would double-report it. Ordered after the failure checks so a
        // failed copy can never announce success (#11735).
        if (ctx.dispatchSource !== "context-menu") {
          // Deliberately no empty-result explanation here, unlike the
          // context-menu helper: that path knows the user right-clicked a
          // folder, whereas `includePaths`/`scopePaths` also carry globs and
          // individual files, so "this folder…" would be the wrong words for an
          // unmatched pattern. A plain count stays true for every caller.
          announceCopyTreeCopy(
            {
              title: "Context copied",
              message: formatCopyResultMessage({
                fileCount: result.fileCount,
                stats: result.stats,
                format,
              }),
            },
            "worktree.copyTree"
          );
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
      run: async (args, ctx: ActionContext) => {
        // The re-dispatch resets `source` to "user", which would otherwise
        // erase that an agent called the alias — forward the resolved surface
        // explicitly so the history records the real caller.
        const result = await actionService.dispatch("worktree.copyTree", args, {
          source: "user",
          copyTreeRunSource: resolveCopyTreeRunSource(ctx.dispatchSource, ctx.copyTreeRunSource),
        });
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
      run: async (args, ctx: ActionContext) => {
        const { worktreeId, title } = resolveFileBrowserTarget(args, ctx);
        const reveal = await resolveFileBrowserReveal(args);

        // Lazily imported for the same reason as the review hub above: a static
        // import drags panelStore -> panelPersistence in, which reads
        // `projectClient` from `@/clients` at module scope and breaks every
        // action test that mocks `@/clients` without it.
        const { usePanelDialogStore } = await import("@/store/panelDialogStore");

        await usePanelDialogStore.getState().openPanelDialog({
          kind: "file-browser",
          title,
          ...(worktreeId !== undefined && { worktreeId }),
          ...reveal,
        });
      },
    })
  );

  actions.set("worktree.openFileBrowserPanel", () =>
    defineAction({
      id: "worktree.openFileBrowserPanel",
      title: "Browse files",
      description:
        "Show a folder in a persistent read-only file browser panel in the grid, for a worktree or for the current project or scratch folder when no worktree is selected. It focuses the existing grid browser for the same folder rather than opening a second one, and applies an optional reveal path to it.",
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
      argsSchema: fileBrowserArgsSchema,
      run: async (args, ctx: ActionContext) => {
        const { worktreeId, title } = resolveFileBrowserTarget(args, ctx);
        const reveal = await resolveFileBrowserReveal(args);
        const foreground = isForegroundDispatch(ctx.dispatchSource);

        // The grid renders only the active worktree's bucket, so a panel opened
        // for any other worktree is created `background` and never appears —
        // `dispatch` would report ok with nothing on screen. A person who just
        // asked to browse a named worktree means to go there, so follow them;
        // an agent or plugin naming another worktree does not move the user,
        // and keeps today's silent-background behavior.
        if (foreground && worktreeId !== undefined) {
          const { useWorktreeSelectionStore } = await import("@/store/worktreeStore");
          const selection = useWorktreeSelectionStore.getState();
          // Guarded rather than unconditional: `selectWorktree` is a no-op for
          // the already-active worktree, but it still re-persists the restore
          // target and touches the MRU, and browsing is not a navigation the
          // user asked to record twice.
          if (selection.activeWorktreeId !== worktreeId) {
            selection.selectWorktree(worktreeId, { source: "user" });
          }
        }

        // Lazily imported for the same reason the dialog store is above.
        const { usePanelStore } = await import("@/store/panelStore");

        const store = usePanelStore.getState();
        // `panelIds`, deliberately, rather than every `panelsById` record.
        // Unlisted entries are not merely early: a superseded hydration leaves
        // its abandoned panels in the map on purpose, and `activateTerminal`
        // walks this same list — so reusing an unlisted record would report a
        // panel that can never be focused, which is worse than the duplicate
        // that a batch-pending browser would otherwise cause.
        const existing = store.panelIds
          .map((id) => store.panelsById[id])
          .find((panel): panel is FileBrowserPanelData => {
            if (panel === undefined || !isFileBrowserPanel(panel)) return false;
            // Grid members only. A dialog browser is ephemeral modal content
            // and reusing one would hand the grid an uncounted, unpersisted
            // record; trashed and backgrounded panels surface nothing when
            // activated. `isGridPanelLocation` is the one place that answer
            // lives, so dock and overlay come along for free.
            if (!isGridPanelLocation(panel.location)) return false;
            // Identity is the folder the tree is rooted at, not the placement
            // worktree: a workspace-rooted panel carries a worktreeId purely so
            // it lands in a rendered index bucket (#11489), and matching on
            // that id would hand a worktree request the workspace browser.
            const panelIsWorkspaceRooted =
              panel.browserWorkspaceRooted === true || panel.worktreeId === undefined;
            return worktreeId === undefined
              ? panelIsWorkspaceRooted
              : !panelIsWorkspaceRooted && panel.worktreeId === worktreeId;
          });

        if (existing) {
          if (reveal) {
            store.setFileBrowserView(existing.id, {
              // Merged, not replaced: the user's own expansions are theirs to
              // keep, and a reveal only adds the path to what is already open.
              browserExpandedPaths: [
                ...new Set([
                  ...(existing.browserExpandedPaths ?? []),
                  ...reveal.browserExpandedPaths,
                ]),
              ].sort(),
              browserSelectedPath: reveal.browserSelectedPath,
              // Reveal paths are base-relative, so a tree scoped to a subfolder
              // can only show one that lives under it. Cleared when the target
              // is outside — otherwise the selection would name a row the tree
              // does not contain — and left alone when it is already inside,
              // since dropping a scope the user chose is not part of revealing
              // something they can already see.
              ...(!isWithinBrowserRoot(reveal.browserSelectedPath, existing.browserRootPath) && {
                browserRootPath: "",
              }),
            });
          }
          // Reuse has to answer the same focus question the create path below
          // does. `activateTerminal` moves `focusedId` AND leaves fullscreen
          // (#11506), so running it unconditionally would let a suppressed
          // dispatch that happens to find an existing browser steal focus from
          // a typing user (#6959) — while the identical dispatch that has to
          // create one would not. Foreground takes focus outright, exactly as
          // the explicit `focusPolicy: "take"` below does; everything else
          // defers to the same two ambient guards `addPanel` resolves
          // "preserve" from. Those two are the whole difference for this kind:
          // `file-browser` keeps the registry's default
          // `defaultFocusOnCreate: true`, the third term of that resolution.
          const takeFocus = foreground || !(isMcpSpawnFocusSuppressed() || isAssistantFocused());
          if (takeFocus) {
            // Activation focuses the panel but leaves a tab group showing
            // whatever tab it had; the group's stored active tab wins over
            // `focusedId` in the grid, so a browser sharing a group would stay
            // hidden behind its sibling. Mirrors `panelStore`'s own focus path.
            const group = store.getPanelGroup(existing.id);
            if (group) store.setActiveTab(group.id, existing.id);
            store.activateTerminal(existing.id);
          }
          return { panelId: existing.id };
        }

        // A person asking to browse expects to see it, so a foreground dispatch
        // takes focus outright — that policy is also the one that leaves
        // fullscreen, so the panel can't land buried behind a maximized cell.
        // Agent/plugin dispatches omit focusPolicy entirely and keep the
        // store's "auto" vs "preserve" resolution, so a background open still
        // never steals focus from a typing user.
        const panelId = await store.addPanel({
          kind: "file-browser",
          title,
          ...(worktreeId !== undefined && { worktreeId }),
          ...reveal,
          location: "grid",
          ...(foreground && { focusPolicy: "take" as const }),
        });
        if (!panelId) {
          throw new Error(`Could not open file browser panel: ${PANEL_LIMIT_ERROR_SUFFIX}`);
        }
        return { panelId };
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
        "Judge whether a worktree is ready to commit, push and merge, and list what is blocking it. This is a read-only summary: it reads git state and performs no git or forge mutation. Signals that depend on forge data report as unknown rather than as passing when that data has not arrived, so an unknown is genuinely unknown and should not be read as a green light.",
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
