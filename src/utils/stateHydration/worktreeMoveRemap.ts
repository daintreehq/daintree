import type { WorktreeState } from "@shared/types";
import { rebaseAbsolutePath } from "@shared/utils/projectPathRelocation";

/**
 * Correlation context for detecting worktree moves at restore time (#11388).
 *
 * A worktree id is its normalized absolute path, so `git worktree move` (or an
 * external relocation) gives a worktree a brand-new id while its stable
 * `.git/worktrees/<name>` admin-dir handle (`gitDir`) is preserved. This context
 * pairs the set of current ids with a `gitDir → current id` index so a saved
 * panel whose `worktreeId` no longer matches can be remapped to the worktree's
 * new id instead of being orphaned and re-homed to the active worktree.
 */
export interface WorktreeMoveContext {
  /** Ids of all worktrees currently known to the view. */
  knownIds: Set<string>;
  /** Stable `gitDir` handle → the worktree's current (path-derived) id. */
  gitDirToId: Map<string, string>;
}

/**
 * A minimal panel-snapshot shape used to detect and apply a worktree move. Kept
 * structural so both `PanelSnapshot` (save side) and `TerminalState` (restore
 * side) satisfy it without importing either concrete type.
 */
export interface WorktreeMoveRemappable {
  worktreeId?: string;
  worktreeGitDir?: string;
  cwd?: string;
  filePath?: string;
  markdownFilePath?: string;
}

/** Path-bearing fields to rewrite when a panel's worktree has moved. */
export interface WorktreeMovePatch {
  worktreeId: string;
  cwd?: string;
  filePath?: string;
  markdownFilePath?: string;
}

/**
 * Build a {@link WorktreeMoveContext} from the current worktree list.
 *
 * Returns `null` for an empty/absent list. Per #11234 an empty list means "not
 * ready yet", never "every worktree is gone" — a null context makes callers skip
 * remapping entirely and keep saved ids untouched, exactly like the existing
 * re-home guard.
 */
export function buildWorktreeMoveContext(
  worktrees: readonly Pick<WorktreeState, "id" | "gitDir">[] | null | undefined
): WorktreeMoveContext | null {
  if (!worktrees || worktrees.length === 0) return null;
  const knownIds = new Set<string>();
  const gitDirToId = new Map<string, string>();
  for (const wt of worktrees) {
    knownIds.add(wt.id);
    // gitDir (.git/worktrees/<name>) is a 1:1 stable handle for a worktree, so
    // this index never collides. Empty string counts as absent.
    if (wt.gitDir) gitDirToId.set(wt.gitDir, wt.id);
  }
  return { knownIds, gitDirToId };
}

/**
 * Resolve a saved `worktreeId` that may have moved to a new path.
 *
 * Returns the worktree's NEW id only when the saved id is no longer present but
 * its persisted `gitDir` handle matches a current worktree at a different path
 * (i.e. the worktree was moved). Returns `undefined` in every other case —
 * including a still-present id, a genuinely-deleted worktree (no `gitDir`
 * match), and legacy snapshots with no stored `gitDir` — so the caller keeps its
 * existing behavior (re-home to the active worktree).
 */
export function resolveMovedWorktreeId(
  savedWorktreeId: string | undefined,
  savedGitDir: string | undefined,
  ctx: WorktreeMoveContext | null
): string | undefined {
  if (ctx === null) return undefined;
  if (!savedWorktreeId || !savedGitDir) return undefined;
  // Still present at its old path ⇒ not moved.
  if (ctx.knownIds.has(savedWorktreeId)) return undefined;
  const newId = ctx.gitDirToId.get(savedGitDir);
  if (newId !== undefined && newId !== savedWorktreeId) return newId;
  return undefined;
}

/**
 * Compute the path-bearing rewrite for a saved panel whose worktree moved, or
 * `null` when it did not move (or cannot be correlated). The new worktree id is
 * a normalized path, so `cwd`/`filePath`/`markdownFilePath` — which live under
 * the old worktree root — are rebased onto the new root with the same
 * segment-boundary primitive the project-move relocation uses (#11282).
 */
export function resolveWorktreeMovePatch(
  saved: WorktreeMoveRemappable,
  ctx: WorktreeMoveContext | null
): WorktreeMovePatch | null {
  const oldId = saved.worktreeId;
  const newId = resolveMovedWorktreeId(oldId, saved.worktreeGitDir, ctx);
  if (newId === undefined || oldId === undefined) return null;

  const patch: WorktreeMovePatch = { worktreeId: newId };
  if (typeof saved.cwd === "string") {
    patch.cwd = rebaseAbsolutePath(saved.cwd, oldId, newId);
  }
  if (typeof saved.filePath === "string") {
    patch.filePath = rebaseAbsolutePath(saved.filePath, oldId, newId);
  }
  if (typeof saved.markdownFilePath === "string") {
    patch.markdownFilePath = rebaseAbsolutePath(saved.markdownFilePath, oldId, newId);
  }
  return patch;
}
