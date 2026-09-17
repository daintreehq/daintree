import { inferWorktreeIdFromCwd } from "@/utils/worktreePaths";

/**
 * Where a cold-restored agent pane should start, given the worktree it is filed
 * under (#12434).
 *
 * A live move (#11853) refiles a pane without touching its process, so a
 * snapshot can name one worktree while its `cwd` still sits in another. Cold
 * start is the boundary where that is reconciled: a new process has no reason
 * to start anywhere but the worktree the pane is shown under.
 *
 * - `unchanged`: nothing proves a move — the list isn't ready (#11234), the
 *   pane has no filing or no cwd, it already runs inside its worktree (a
 *   subdirectory counts), or its cwd is under no worktree at all, which is a
 *   directory the user chose and not ours to relocate.
 * - `moved`: filed under a live worktree other than the one it runs in.
 * - `destination-unavailable`: filed under a worktree this project's list
 *   doesn't have, while running in one it does. Absence is not proof of
 *   deletion, which is exactly why the answer is to ask rather than to fall
 *   back to the directory it was launched in.
 */
export type ColdLaunchTarget =
  { kind: "unchanged" } | { kind: "moved"; cwd: string } | { kind: "destination-unavailable" };

const UNCHANGED: ColdLaunchTarget = { kind: "unchanged" };

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * A worktree id IS a path, but creation and enumeration spell it differently
 * (realpath vs resolve), so a lexical match on either spelling still names it.
 */
function findWorktree<T extends { id: string; path: string }>(
  worktrees: readonly T[],
  worktreeId: string
): T | undefined {
  const exact = worktrees.find((w) => w.id === worktreeId);
  if (exact) return exact;
  const wanted = normalizePath(worktreeId);
  return worktrees.find(
    (w) => normalizePath(w.id) === wanted || (w.path !== "" && normalizePath(w.path) === wanted)
  );
}

export function resolveColdLaunchTarget(
  saved: { cwd?: string; worktreeId?: string },
  worktrees: readonly { id: string; path: string }[] | null | undefined
): ColdLaunchTarget {
  if (!worktrees || worktrees.length === 0) return UNCHANGED;
  const { cwd, worktreeId } = saved;
  if (!cwd || !worktreeId) return UNCHANGED;

  const launchRootId = inferWorktreeIdFromCwd(cwd, worktrees);
  if (launchRootId === undefined) return UNCHANGED;

  const destination = findWorktree(worktrees, worktreeId);
  if (!destination) return { kind: "destination-unavailable" };
  if (destination.id === launchRootId || !destination.path) return UNCHANGED;
  return { kind: "moved", cwd: destination.path };
}

/** Lexical equality under the same normalization the resolver uses. */
export function isSameDirectory(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}
