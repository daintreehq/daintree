import { isPathInside, toWorktreeRelative } from "../../shared/utils/path.js";

/**
 * The worktree-relative directories a burst of absolute changed paths touched:
 * one parent per path, deduped, `""` for the worktree root.
 *
 * Only parents, never the changed paths themselves — a tree discovers a child
 * by looking it up in its parent's listing, never by iterating expansions, so
 * re-reading the parent is what reveals a create, a delete, a rename or a
 * changed size. That also covers the case a watcher cannot report: a path that
 * is itself a directory carries no `isDirectory` flag in the event, and its own
 * row lives in the parent's listing regardless.
 *
 * `null` is the conservative answer — "this burst cannot be described, refresh
 * everything" — and is returned for an unknown burst and for any path that does
 * not resolve inside the worktree. No cap of its own: one parent per path can
 * never exceed the burst's own `WORKTREE_BURST_PATH_CAP`, which has already
 * degraded the burst to `null` by the time it would matter.
 *
 * Containment goes through `isPathInside`/`toWorktreeRelative` rather than a
 * prefix slice: a sibling whose name merely extends the root (`/repo-other/x`
 * under `/repo`) would otherwise mangle into a plausible-looking relative path
 * and scope the refresh to a directory that does not exist (#11276).
 */
export function affectedDirsForBurst(
  burst: ReadonlySet<string> | null,
  worktreePath: string,
  worktreeRealPath: string | null
): string[] | null {
  if (burst === null) return null;
  const dirs = new Set<string>();
  for (const path of burst) {
    const root = [worktreePath, worktreeRealPath].find(
      (candidate) => candidate !== null && candidate !== "" && isPathInside(path, candidate)
    );
    // Collection already rejects paths outside the worktree, so this is the
    // belt-and-braces branch: a root that changed spelling between collection
    // and flush must degrade the burst, never silently drop one of its paths.
    if (root === undefined || root === null) return null;
    const relative = toWorktreeRelative(path, root);
    // `toWorktreeRelative` hands back the input untouched when it cannot strip
    // the root, which would put an absolute path into a relative namespace.
    if (relative === path || relative === "") return null;
    const slash = relative.lastIndexOf("/");
    dirs.add(slash === -1 ? "" : relative.slice(0, slash));
  }
  return [...dirs];
}
