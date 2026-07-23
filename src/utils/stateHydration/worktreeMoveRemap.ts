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
 *
 * Known limitation: a `gitDir` name is unique only among concurrently-registered
 * worktrees, not forever — after a linked worktree is pruned, Git can reuse
 * `.git/worktrees/<name>` for a later same-basename worktree. A snapshot for the
 * deleted worktree could then correlate to the unrelated reuse. Closing that
 * needs a main-process incarnation fingerprint (filesystem identity), which is
 * out of scope for the path-change fix; the common move case is handled here.
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
 * Resolve a saved `worktreeId` whose worktree may have moved to a new path.
 *
 * The `gitDir` handle is the stable identity, so it is the primary key: the
 * panel belongs to whichever worktree currently carries its handle. Returns that
 * worktree's id when the handle maps to a DIFFERENT id than the saved one —
 * covering both a plain `git worktree move` and the case where the saved path
 * was taken over by an unrelated worktree while the original moved elsewhere
 * (matching on the still-present old id would wrongly bind the panel to the
 * squatter). Returns `undefined` — so the caller keeps its re-home behavior —
 * when the handle maps to no current worktree (genuinely deleted), maps to the
 * same id (unchanged), or is absent (legacy snapshot with no stored handle).
 */
export function resolveMovedWorktreeId(
  savedWorktreeId: string | undefined,
  savedGitDir: string | undefined,
  ctx: WorktreeMoveContext | null
): string | undefined {
  if (ctx === null) return undefined;
  if (!savedWorktreeId || !savedGitDir) return undefined;
  const currentId = ctx.gitDirToId.get(savedGitDir);
  if (currentId === undefined || currentId === savedWorktreeId) return undefined;
  return currentId;
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
