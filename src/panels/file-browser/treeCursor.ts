import {
  ancestorDirectories,
  isRowPathVisible,
  type DirectoryListings,
  type FlatTreeRow,
} from "./fileBrowserTree";

/**
 * Why a path with no row has no row — the question that decides whether a tree
 * cursor naming it is stale or merely early.
 *
 * `pending`: a directory on the way down hasn't been listed yet (or the root
 * hasn't, so there is no tree to judge against), so nothing can be concluded.
 * `absent`: everything needed to show the row has been read, or given up on,
 * or the row is deliberately not shown — and it still isn't there: collapsed
 * above, filtered, outside the root, gone from its parent's listing, or under a
 * directory whose listing failed.
 *
 * Only meaningful for a path that is not currently a row; it never answers
 * "visible".
 */
export type MissingRowStatus = "pending" | "absent";

export function missingRowStatus(
  path: string,
  listings: DirectoryListings,
  expandedPaths: ReadonlySet<string>,
  rootPath: string,
  isVisible: (name: string) => boolean,
  failedListings: ReadonlySet<string>
): MissingRowStatus {
  // Nothing is settled before the root is: a re-root starts from an empty tree,
  // and a cursor on the folder that just became the root (or outside it) would
  // otherwise be ruled absent with no rows to move it onto — it would clear and
  // stay clear once the listing landed.
  if (!listings.has(rootPath)) return "pending";
  // The root is the frame, never a row, so a path equal to it is absent for the
  // same reason a path above it is. Filtering and the root check need no
  // further listing: a hidden or out-of-root cursor is settled.
  if (path === rootPath || !isRowPathVisible(path, rootPath, isVisible)) return "absent";

  const prefix = rootPath === "" ? "" : `${rootPath}/`;
  const segments = path.slice(prefix.length).split("/").filter(Boolean);
  let dir = rootPath;
  for (let i = 0; i < segments.length; i += 1) {
    const listed = listings.get(dir);
    // The one non-answer. A restored or revealed cursor lands before the
    // listings under it do, and a root change drops every listing but the
    // root's own — in both, the row appears once its ancestors have been read.
    // A directory whose read failed is not coming, and the hook won't re-ask on
    // its own, so waiting on it would leave the cursor stale for good.
    if (listed === undefined) return failedListings.has(dir) ? "absent" : "pending";
    const next = dir === "" ? segments[i]! : `${dir}/${segments[i]}`;
    if (!listed.some((node) => node.path === next)) return "absent";
    if (i === segments.length - 1) break;
    if (!expandedPaths.has(next)) return "absent";
    dir = next;
  }
  return "absent";
}

/** Where the tree cursor stood the last time its row was on screen. */
export interface CursorSighting {
  path: string;
  /** The rows the cursor was found in, so its old neighbours stay known. */
  rows: readonly FlatTreeRow[];
  index: number;
}

/**
 * The row a cursor should move to once its own row is gone.
 *
 * The nearest ancestor that still has a row wins, since that is the folder the
 * cursor was inside (a collapse hides it there; a delete leaves it there).
 * Failing that, the closest surviving neighbour in the order the user last saw —
 * the row after it, else the row before — which is what a filter or a re-root
 * leaves. A tree that shares no row with the old one lands on its first row.
 * Null only for a tree with no rows at all.
 *
 * Never reads the viewer: this moves the tree's own highlight and nothing else.
 */
export function pickCursorReplacement(
  sighting: CursorSighting,
  rows: readonly FlatTreeRow[]
): string | null {
  if (rows.length === 0) return null;
  const present = new Set<string>();
  for (const row of rows) present.add(row.path);

  const ancestors = ancestorDirectories(sighting.path);
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    if (present.has(ancestors[i]!)) return ancestors[i]!;
  }

  const before = sighting.rows;
  for (let i = sighting.index + 1; i < before.length; i += 1) {
    if (present.has(before[i]!.path)) return before[i]!.path;
  }
  for (let i = sighting.index - 1; i >= 0; i -= 1) {
    if (present.has(before[i]!.path)) return before[i]!.path;
  }
  return rows[0]!.path;
}
