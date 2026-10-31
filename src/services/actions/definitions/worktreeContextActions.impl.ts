// The worktree context actions' run bodies, loaded on first dispatch by
// `runWorktreeContextAction` in worktreeContextActions.ts, which keeps the
// metadata every view registers at boot (#14274). Nothing here may import
// worktreeContextActions.ts at runtime.
import type { ActionCallbacks } from "../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import type { CopyTreeResult } from "@shared/types";
import { copyTreeClient, systemClient } from "@/clients";
import { resolveCopyTreeRunSource } from "@/lib/copyTreeRunSource";
import { actionService } from "@/services/ActionService";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { copiesWorkspaceRoot } from "./workspaceRootCopyTarget";
import { useForgeProviderHealthStore } from "@/store/forgeProviderHealthStore";
import {
  usePluginWorktreeReviewChecksStore,
  worktreeReviewChecksFor,
} from "@/store/pluginWorktreeReviewChecksStore";
import { pluginManifestIdFromInstanceKey } from "@shared/types/plugin";
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
import { findReviewHubMarkTarget } from "@/components/Worktree/ReviewHub/reviewHubMarkTargets";
import { buildWorkingTreeDiffModel } from "@/lib/workingTreeDiff";
import { basename } from "@shared/utils/path";
import {
  worktreeLabelTokenForName,
  type WorktreeLabelColorName,
} from "@shared/theme/worktreeColors";
import { composeFileBrowserTitle } from "@/panels/file-browser/title";
// Static, unlike the stores below: this module carries the panel types plus a
// handful of pure predicates over them, so it drags in no client or store graph.
import {
  isFileBrowserPanel,
  isGridPanelLocation,
  type FileBrowserPanelData,
} from "@shared/types/panel";
import { isForegroundDispatch } from "./dispatchSource";
import { UnactionableTargetError } from "@/services/actions/unactionableTarget";
import {
  INPUT_LOCKED_INJECTION_REFUSAL,
  isTerminalInputLocked,
} from "@/services/contextInjectionGuard";
import { PANEL_LIMIT_ERROR_SUFFIX } from "./panelLimitError";
import { paginate } from "@shared/utils/boundedOutput";
import { GIT_PAGE_LIMIT_DEFAULT, GIT_PAGE_LIMIT_MAX } from "@shared/config/gitReadLimits";
import {
  WORKTREE_CUSTOM_TITLE_MAX_LENGTH,
  isWorktreeCustomTitleTooLong,
  normalizeWorktreeCustomTitle,
} from "@shared/utils/worktreeCustomTitle";
import {
  deriveReviewReadiness,
  type ReviewReadinessCta,
  type ReviewReadinessItem,
} from "@/components/Worktree/ReviewHub/reviewReadiness";
import type { FileBrowserArgs, FileBrowserPanelArgs } from "./worktreeContextActionArgs";

type WorktreeIdArgs = { worktreeId?: string } | undefined;
type OpenReviewHubArgs = { worktreeId?: string; mode?: "since-review" } | undefined;

type CopyTreeFormat = "xml" | "json" | "markdown" | "tree" | "ndjson" | "sarif";

type CopyContextArgs =
  | {
      worktreeId?: string;
      format?: CopyTreeFormat;
      modified?: boolean;
    }
  | undefined;

type CopyTreeArgs =
  | {
      worktreeId?: string;
      format?: CopyTreeFormat;
      modified?: boolean;
      includePaths?: string[];
      scopePaths?: string[];
      scopeIgnoresIgnoreFiles?: boolean;
    }
  | undefined;

interface CompareDiffArgs {
  worktreeId?: string;
  compareToWorktreeId: string;
  useMergeBase?: boolean;
  ignoreWhitespace?: boolean;
  offset?: number;
  limit?: number;
}

type ReadinessActionSuggestion =
  | {
      actionId: "worktree.openReviewHub" | "worktree.openPR";
      actionArgs: { worktreeId: string };
    }
  | { actionId: "git.pullRebase"; actionArgs: { cwd: string } };

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
    return {
      worktreeId: targetWorktreeId,
      title: composeFileBrowserTitle(worktree.branch ?? worktree.name),
    };
  }
  return {
    worktreeId: undefined,
    title: composeFileBrowserTitle(
      ctx.projectName ?? ctx.scratchName ?? (workspacePath ? basename(workspacePath) : "workspace")
    ),
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

/**
 * The folder to scope the tree to, relative to the browsed base, or `undefined`
 * when the caller named none. An explicit empty root is `""` — the base itself —
 * so it can reset a scoped panel, which omission must not do.
 *
 * Rejected rather than canonicalized: `canonicalizeRootPath` turns `..` into
 * `""` and strips a leading slash, so either would silently open a different
 * folder than the one asked for.
 */
function resolveFileBrowserRoot(args: FileBrowserPanelArgs): string | undefined {
  const raw = args?.rootPath;
  if (raw === undefined) return undefined;
  const normalized = raw.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`Root must be inside the worktree, not an absolute path: ${raw}`);
  }
  const segments = normalized.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) {
    throw new Error(`Root must be inside the worktree: ${raw}`);
  }
  const root = segments.join("/");
  // Again after dropping `.` segments: `./C:/x` only becomes drive-qualified
  // once the dot is gone, and the listing refuses such a path.
  if (/^[A-Za-z]:/.test(root)) {
    throw new Error(`Root must be inside the worktree, not an absolute path: ${raw}`);
  }
  return root;
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

/**
 * Each run's args, as the `argsSchema` beside it in worktreeContextActions.ts
 * declares them. The runner there is typed against this table, so a schema that
 * drifts from what its run reads fails to compile at the `run:` call site.
 */
interface WorktreeContextActionRunArgsTable {
  "worktree.copyTree": CopyTreeArgs;
  "worktree.copyContext": CopyContextArgs;
  "worktree.inject": WorktreeIdArgs;
  "worktree.setLabelColor": { worktreeId: string; color: WorktreeLabelColorName | null };
  "worktree.setCustomTitle": { worktreeId: string; title: string | null };
  "worktree.openEditor": WorktreeIdArgs;
  "worktree.openReviewHub": OpenReviewHubArgs;
  "worktree.markReviewed": WorktreeIdArgs;
  "worktree.clearReviewMark": WorktreeIdArgs;
  "worktree.openChanges": WorktreeIdArgs;
  "worktree.openFileBrowser": FileBrowserArgs;
  "worktree.openFileBrowserPanel": FileBrowserPanelArgs;
  "worktree.reveal": WorktreeIdArgs;
  "worktree.compareDiff": CompareDiffArgs;
  "worktree.reviewReadiness": WorktreeIdArgs;
}

export type WorktreeContextActionRunId = keyof WorktreeContextActionRunArgsTable;

export type WorktreeContextActionRunArgs<Id extends WorktreeContextActionRunId> =
  WorktreeContextActionRunArgsTable[Id];

export const worktreeContextActionRuns: {
  [Id in WorktreeContextActionRunId]: (
    args: WorktreeContextActionRunArgs<Id>,
    ctx: ActionContext,
    callbacks: ActionCallbacks
  ) => Promise<unknown>;
} = {
  "worktree.copyTree": async (args, ctx) => {
    const worktreeId = args?.worktreeId;
    const explicitFormat = args?.format;
    const modified = args?.modified;
    const includePaths = args?.includePaths;
    const scopePaths = args?.scopePaths;
    const scopeIgnoresIgnoreFiles = args?.scopeIgnoresIgnoreFiles;
    const targetWorktreeId = worktreeId ?? ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
    // No worktree at all is a non-git project or a scratch: copy its root,
    // which main resolves from the dispatching view itself (#13210).
    if (!targetWorktreeId && !(await copiesWorkspaceRoot(ctx))) return null;

    const format = explicitFormat ?? DEFAULT_COPYTREE_FORMAT;

    // Bracketed for the toolbar spinner, whoever dispatched — an MCP copy
    // spins the Copy context button the same as a clicked one. After the
    // no-workspace return so a refused dispatch never blips it.
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
        "worktree.copyTree",
        targetWorktreeId
      );
    }

    return {
      worktreeId: targetWorktreeId ?? null,
      fileCount: result.fileCount,
      stats: result.stats ?? null,
      format,
    };
  },

  "worktree.copyContext": async (args, ctx) => {
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

  "worktree.inject": async (args, ctx, callbacks) => {
    const focusedTerminalId = ctx.focusedTerminalId;
    if (!focusedTerminalId) {
      throw new Error("No focused terminal to inject into");
    }
    // As `terminal.inject`: only a caller that reads the result needs the
    // refusal here; a person sees the injection's own error surface.
    if (!isForegroundDispatch(ctx.dispatchSource) && isTerminalInputLocked(focusedTerminalId)) {
      throw new UnactionableTargetError(INPUT_LOCKED_INJECTION_REFUSAL);
    }
    const worktreeId = args?.worktreeId;
    const targetWorktreeId = worktreeId ?? ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
    if (!targetWorktreeId) {
      throw new Error("No worktree selected");
    }
    // The pane that was checked, not whatever holds focus when the hook runs.
    callbacks.onInject(targetWorktreeId, focusedTerminalId);
  },

  "worktree.setLabelColor": async (args) => {
    const { worktreeId, color } = args;
    if (!getCurrentViewStore().getState().worktrees.has(worktreeId)) {
      throw new Error(`Worktree not found: ${worktreeId}`);
    }
    // Lazy, like the panel stores below: the filter store's persistence
    // layer reads localStorage at module scope.
    const { useWorktreeFilterStore } = await import("@/store/worktreeFilterStore");
    useWorktreeFilterStore
      .getState()
      .setWorktreeLabelColor(worktreeId, color === null ? null : worktreeLabelTokenForName(color));
  },

  "worktree.setCustomTitle": async (args) => {
    const { worktreeId, title } = args;
    if (!getCurrentViewStore().getState().worktrees.has(worktreeId)) {
      throw new Error(`Worktree not found: ${worktreeId}`);
    }
    const normalized = title === null ? "" : normalizeWorktreeCustomTitle(title);
    // Rejected rather than truncated: the wire schema can't carry the limit.
    if (isWorktreeCustomTitleTooLong(normalized)) {
      throw new Error(`Title is longer than ${WORKTREE_CUSTOM_TITLE_MAX_LENGTH} characters`);
    }
    const { useWorktreeFilterStore } = await import("@/store/worktreeFilterStore");
    await useWorktreeFilterStore.getState().setWorktreeCustomTitle(worktreeId, normalized || null);
  },

  "worktree.openEditor": async (args, ctx) => {
    const worktreeId = args?.worktreeId;
    const targetWorktreeId = worktreeId ?? ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
    if (!targetWorktreeId) return;

    const worktree = getCurrentViewStore().getState().worktrees.get(targetWorktreeId);
    if (!worktree) return;

    // `openInEditor`, not `openPath` — the latter is the OS default handler,
    // which is what made this indistinguishable from "Reveal Worktree"
    // below (#12329). The project id decides which editor preference the
    // main process reads; omitting it silently falls back to discovery
    // order (#12327). `ctx.projectId` resolves through this view's own
    // workspace id, so it names this view's project rather than whichever
    // one a sibling window last switched to.
    await systemClient.openInEditor({ path: worktree.path, projectId: ctx.projectId });
  },

  "worktree.openReviewHub": async (args, ctx) => {
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
      title: "Review & commit",
      worktreeId: targetWorktreeId,
      // The AI note's first line if it is still current, else "". Never any
      // other source — a substituted commit message caused a real bad push
      // to a shared branch (#7884).
      initialCommitMessage: deriveCommitMessageSeed(worktree, Date.now()),
      // Staging changes what the hub shows, so opening straight into the
      // since-review view leaves the index alone.
      autoStageOnOpen: args?.mode !== "since-review",
      ...(args?.mode === "since-review" && { initialMode: "since-review" as const }),
    });
  },

  "worktree.markReviewed": async (args, ctx) => {
    const target = findReviewHubMarkTarget({
      worktreeId: args?.worktreeId,
      focusedPanelId: ctx.focusedTerminalKind === "review" ? ctx.focusedTerminalId : null,
    });
    // Marking stores what a hub displayed, so there's nothing to mark without one.
    if (!target) throw new Error("Open Review Hub on the worktree to mark it reviewed.");
    const blocked = target.markBlockedReason();
    if (blocked) throw new Error(`Can't mark reviewed yet: ${blocked}.`);
    await target.markReviewed();
  },

  "worktree.clearReviewMark": async (args, ctx) => {
    const target = findReviewHubMarkTarget({
      worktreeId: args?.worktreeId,
      focusedPanelId: ctx.focusedTerminalKind === "review" ? ctx.focusedTerminalId : null,
    });
    if (target) {
      await target.clearReviewMark();
      return;
    }
    if (!args?.worktreeId) {
      throw new Error("Open Review Hub on the worktree, or name it, to clear its review mark.");
    }
    const { clearWorktreeReviewMark, getReviewMarksRevision } =
      await import("@/store/reviewMarksStore");
    const outcome = await clearWorktreeReviewMark(args.worktreeId, getReviewMarksRevision());
    if (outcome.status === "stale") {
      throw new Error("The review mark changed in another window, so it was left as it is.");
    }
  },

  "worktree.openChanges": async (args, ctx) => {
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

    // Lazily imported for the same reason as the review hub above.
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

  "worktree.openFileBrowser": async (args, ctx) => {
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

  "worktree.openFileBrowserPanel": async (args, ctx) => {
    const { worktreeId, title } = resolveFileBrowserTarget(args, ctx);
    const reveal = await resolveFileBrowserReveal(args);
    const rootPath = resolveFileBrowserRoot(args);
    // Settled before anything is selected or focused: a request that can't
    // be honored must not have already moved the user to another worktree.
    // `..` is refused outright since a prefix test would pass `src/../x`.
    // Tested on presence, not truthiness: an explicit base root (`""`)
    // contains everything except a traversal.
    if (
      rootPath !== undefined &&
      reveal &&
      (reveal.browserSelectedPath.split("/").includes("..") ||
        !isWithinBrowserRoot(reveal.browserSelectedPath, rootPath))
    ) {
      throw new Error(
        `Reveal path ${reveal.browserSelectedPath} is outside the root ${rootPath || "."}`
      );
    }
    const foreground = isForegroundDispatch(ctx.dispatchSource);
    // Grid stays the default, so every caller that predates the dock
    // launcher keeps landing exactly where it did.
    const location = args?.location === "dock" ? "dock" : "grid";

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
        // Matched against the surface that was ASKED for, not "anywhere":
        // reusing the grid browser for a dock request would leave the dock
        // empty after a gesture that named it, and moving the panel across
        // instead would drag its whole tab group along. One browser per
        // folder per surface is the smallest honest extension of the old
        // grid-only rule (#11917).
        //
        // Either way a dialog browser is ephemeral modal content and
        // reusing one would hand the grid an uncounted, unpersisted record;
        // trashed, backgrounded and overlay panels surface nothing when
        // activated. `isGridPanelLocation` is the one place that answer
        // lives, so every one of those exclusions — and the legacy
        // `undefined` location that still counts as grid — comes for free.
        const onRequestedSurface =
          location === "dock" ? panel.location === "dock" : isGridPanelLocation(panel.location);
        if (!onRequestedSurface) return false;
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
            ...new Set([...(existing.browserExpandedPaths ?? []), ...reveal.browserExpandedPaths]),
          ].sort(),
          browserSelectedPath: reveal.browserSelectedPath,
          // An explicit root is the caller's scope and was already checked
          // against the reveal above. Otherwise, reveal paths are
          // base-relative, so a tree scoped to a subfolder can only show
          // one that lives under it. Cleared when the target is outside —
          // otherwise the selection would name a row the tree does not
          // contain — and left alone when it is already inside, since
          // dropping a scope the user chose is not part of revealing
          // something they can already see.
          ...(rootPath !== undefined
            ? { browserRootPath: rootPath }
            : !isWithinBrowserRoot(reveal.browserSelectedPath, existing.browserRootPath) && {
                browserRootPath: "",
              }),
        });
      } else if (rootPath !== undefined) {
        // Root alone, like the pane's own "set as root": the selection and
        // expansions the user has are left as they are.
        store.setFileBrowserView(existing.id, { browserRootPath: rootPath });
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
      ...(rootPath && { browserRootPath: rootPath }),
      location,
      // Folded into the same set() that commits the panel, so the offscreen
      // container's watchdog can't close the popover in the render gap
      // (#6590) — the reason `launchPanelKind` passes this rather than
      // opening the chip afterwards.
      ...(location === "dock" && { activateDockOnCreate: args?.activateDockOnCreate === true }),
      ...(foreground && { focusPolicy: "take" as const }),
    });
    if (!panelId) {
      throw new Error(`Could not open file browser panel: ${PANEL_LIMIT_ERROR_SUFFIX}`);
    }
    return { panelId };
  },

  "worktree.reveal": async (args, ctx) => {
    const worktreeId = args?.worktreeId;
    const targetWorktreeId = worktreeId ?? ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
    if (!targetWorktreeId) return;
    const worktree = getCurrentViewStore().getState().worktrees.get(targetWorktreeId);
    if (!worktree) return;
    await systemClient.openPath(worktree.path);
  },

  "worktree.compareDiff": async (args, ctx) => {
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

  "worktree.reviewReadiness": async (args, ctx) => {
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
    // Subscribes on first use; the preload replays what main already holds.
    usePluginWorktreeReviewChecksStore.getState().init();
    // Lazy, like the other stores this module reaches for at run time.
    const { useProjectStore } = await import("@/store/projectStore");
    const projectId = useProjectStore.getState().currentProject?.id ?? null;
    const pluginChecks = worktreeReviewChecksFor(
      projectId
        ? usePluginWorktreeReviewChecksStore.getState().checksByProject[projectId]
        : undefined,
      targetWorktreeId
    ).flatMap(({ pluginId, checks }) =>
      checks.map((check) => ({
        // The manifest id, never the instance key: a project plugin's key
        // carries a machine-local project id (#12211). A check's command
        // is left out too; this query runs nothing.
        pluginId: pluginManifestIdFromInstanceKey(pluginId),
        label: check.label,
        severity: check.severity,
        ...(check.detail !== undefined ? { detail: check.detail } : {}),
      }))
    );
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
      pluginChecks,
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
};
