/**
 * Where a cold-restored agent pane should start, given the worktree it is filed
 * under (#12434).
 *
 * A live move (#11853) refiles a pane without touching its process, so a
 * snapshot can name one worktree while its `cwd` still sits in another. Cold
 * start is the boundary where that is reconciled: a new process has no reason
 * to start anywhere but the worktree the pane is shown under.
 *
 * - `unchanged`: nothing proves a move — the pane has no filing or no cwd, it
 *   already runs inside its worktree (a subdirectory counts), or its cwd is
 *   under no worktree at all, which is a directory the user chose and not ours
 *   to relocate. A worktree id is its path, so a pane running inside its own
 *   filing needs no list to show it.
 * - `moved`: filed under a live worktree other than the one it runs in.
 * - `destination-unavailable`: filed under a worktree this project's list
 *   doesn't have, while something shows it was moved — it runs in a worktree
 *   the list does have, or restore already relaunched it away from the folder
 *   its conversation began in. Absence is not proof of deletion, which is
 *   exactly why the answer is to ask rather than to fall back.
 * - `unconfirmed`: the list isn't ready (#11234) and only it can tell where the
 *   pane belongs (#18009): look again. A pane running outside the worktree it
 *   is filed under is held if the list still doesn't come (`holdIfUnknown`),
 *   since starting it in its saved folder would be guessing against the
 *   filing. One in a subdirectory of its filing is most likely just that, but
 *   a nested worktree moved back to its parent looks the same without a list,
 *   so it waits for the second look too, and starts where it was without one.
 *
 * `worktreeId` is the list's own spelling of the filing whenever one matched,
 * so a filing saved under another spelling of the same path isn't mistaken for
 * a dead worktree later on.
 */
export type ColdLaunchTarget =
  | { kind: "unchanged"; worktreeId?: string }
  | { kind: "moved"; cwd: string; worktreeId: string }
  | { kind: "destination-unavailable" }
  | { kind: "unconfirmed"; holdIfUnknown: boolean };

const UNCHANGED: ColdLaunchTarget = { kind: "unchanged" };

/**
 * Separators unified and trailing slashes dropped; drive-letter and `\\server`
 * paths case-folded, since Windows compares them that way. A POSIX path that
 * merely starts with `//` stays case-sensitive. Lexical only — restore can't
 * wait on the filesystem, so symlinked spellings stay distinct.
 */
function comparablePath(p: string): string {
  const windows = /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");
  const normalized = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return windows ? normalized.toLowerCase() : normalized;
}

/** `path` is `root` or lies under it, by the same lexical comparison. */
export function isWithinDirectory(path: string, root: string): boolean {
  const target = comparablePath(path);
  const base = comparablePath(root);
  return target === base || target.startsWith(`${base}/`);
}

/** The worktree `cwd` runs in: the longest listed path containing it. */
export function findLaunchRoot(
  cwd: string,
  worktrees: readonly { id: string; path: string }[]
): string | undefined {
  const target = comparablePath(cwd);
  let best: { id: string; length: number } | undefined;
  for (const worktree of worktrees) {
    if (!worktree.path) continue;
    const root = comparablePath(worktree.path);
    if (target !== root && !target.startsWith(`${root}/`)) continue;
    if (!best || root.length > best.length) best = { id: worktree.id, length: root.length };
  }
  return best?.id;
}

/**
 * A worktree id IS a path, but creation and enumeration spell it differently
 * (realpath vs resolve), so a match on either spelling still names it.
 */
function findWorktree<T extends { id: string; path: string }>(
  worktrees: readonly T[],
  worktreeId: string
): T | undefined {
  const exact = worktrees.find((w) => w.id === worktreeId);
  if (exact) return exact;
  const wanted = comparablePath(worktreeId);
  return worktrees.find(
    (w) => comparablePath(w.id) === wanted || (w.path !== "" && comparablePath(w.path) === wanted)
  );
}

/**
 * The filing names a worktree an authoritative list doesn't have. An unknown
 * or empty list proves nothing (#11234).
 */
export function isFilingUnavailable(
  worktreeId: string | undefined,
  worktrees: readonly { id: string; path: string }[] | null | undefined
): boolean {
  if (!worktreeId || !worktrees || worktrees.length === 0) return false;
  return findWorktree(worktrees, worktreeId) === undefined;
}

export function resolveColdLaunchTarget(
  saved: { cwd?: string; worktreeId?: string; conversationCwd?: string },
  worktrees: readonly { id: string; path: string }[] | null | undefined
): ColdLaunchTarget {
  const { cwd, worktreeId } = saved;
  if (!cwd || !worktreeId) return UNCHANGED;
  if (!worktrees || worktrees.length === 0) {
    if (isSameDirectory(cwd, worktreeId)) return UNCHANGED;
    return { kind: "unconfirmed", holdIfUnknown: !isWithinDirectory(cwd, worktreeId) };
  }

  const launchRootId = findLaunchRoot(cwd, worktrees);
  const destination = findWorktree(worktrees, worktreeId);
  if (!destination) {
    return launchRootId !== undefined || saved.conversationCwd
      ? { kind: "destination-unavailable" }
      : UNCHANGED;
  }
  if (launchRootId === undefined || destination.id === launchRootId || !destination.path) {
    return { kind: "unchanged", worktreeId: destination.id };
  }
  return { kind: "moved", cwd: destination.path, worktreeId: destination.id };
}

/** Equality under the same comparison the resolver uses. */
export function isSameDirectory(a: string, b: string): boolean {
  return comparablePath(a) === comparablePath(b);
}

/**
 * Between attempts to read a worktree list that wasn't ready (#18009). The
 * first waits out main's coalescing of the same read, which would otherwise
 * hand back the empty answer hydration already has.
 */
export const WORKTREE_REREAD_DELAYS_MS: readonly number[] = [250, 500, 1000];

/**
 * The most the second look may take altogether, reads included: a read can
 * wait seconds on a host that isn't ready, and the panes waiting on it hold
 * their restore batch until it answers.
 */
export const WORKTREE_REREAD_BUDGET_MS = 3000;

/**
 * Read the worktree list again until one comes back, for panes whose filing
 * only a list can confirm. Bounded in attempts and in time, so a list that
 * never comes settles those panes instead of stalling restore: `null` when
 * none came.
 */
export async function rereadWorktreeList<T>(
  read: () => Promise<{ worktrees: readonly T[] } | null | undefined>,
  delaysMs: readonly number[] = WORKTREE_REREAD_DELAYS_MS,
  budgetMs: number = WORKTREE_REREAD_BUDGET_MS
): Promise<T[] | null> {
  const deadline = Date.now() + budgetMs;
  for (const ms of delaysMs) {
    if (Date.now() + ms >= deadline) break;
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
    const status = await settleBy(read(), deadline);
    if (status && status.worktrees.length > 0) return [...status.worktrees];
  }
  return null;
}

/** `pending`'s value, or null once it rejects or `deadline` passes first. */
function settleBy<T>(pending: Promise<T>, deadline: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()));
    pending.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
}
