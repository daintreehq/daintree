import type { FileTreeNode } from "@shared/types";
import type { FileBrowserTreeSnapshot } from "@shared/types/panel";

/**
 * One rendered line of the tree. The tree is rendered as a flat array rather
 * than nested elements because `react-virtuoso` — the virtualizer already used
 * by the sidebar, logs and console lists — windows a linear item list. Nesting
 * is carried by `depth` and drawn as indentation.
 */
export interface FlatTreeRow {
  /** Worktree-relative path; unique across the tree, so it doubles as the React key */
  path: string;
  name: string;
  isDirectory: boolean;
  /** 0 for entries directly under the browser root */
  depth: number;
  /** Directories only: whether this row's children are currently shown */
  isExpanded: boolean;
  /** Directories only: whether a listing for this row is in flight */
  isLoading: boolean;
  /** Byte size for files; undefined for directories */
  size?: number;
}

/**
 * The two visibility controls the browser applies client-side over the raw
 * listing the service now returns (#11330): the app-global always-hidden junk
 * list and the per-panel dotfile toggle. Both filter by entry basename.
 */
export interface FileVisibility {
  /** Hide dot-prefixed entries (the per-panel toggle). */
  hideDotfiles: boolean;
  /** Always-hidden basename globs (literal text plus `*` wildcards). */
  alwaysHiddenPatterns: readonly string[];
}

/**
 * Anchored, case-sensitive basename glob match where `*` is the only wildcard
 * (any run of characters) and every other character is literal. A two-pointer
 * scan with single-star backtracking — O(name · pattern) worst case, never
 * exponential — so a persisted pattern like `*a*a*…*b` can't wedge the render
 * path the way a `.*`-per-`*` regex would (a real ReDoS on user-controlled
 * patterns).
 */
function matchesBasenameGlob(name: string, pattern: string): boolean {
  let n = 0;
  let p = 0;
  let starP = -1;
  let starN = 0;
  while (n < name.length) {
    // `*` is matched as a wildcard BEFORE literal equality, so a filename that
    // itself contains `*` (legal on POSIX) can't consume the pattern's wildcard
    // as a literal — `*` must still match everything.
    if (p < pattern.length && pattern[p] === "*") {
      starP = p;
      starN = n;
      p += 1;
    } else if (p < pattern.length && pattern[p] === name[n]) {
      n += 1;
      p += 1;
    } else if (starP !== -1) {
      // Backtrack: let the last `*` swallow one more character.
      p = starP + 1;
      starN += 1;
      n = starN;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p += 1;
  return p === pattern.length;
}

/**
 * Build the per-entry visibility predicate for one panel's current settings. A
 * `true` result means "show this entry".
 */
export function createVisibilityFilter(visibility: FileVisibility): (name: string) => boolean {
  const { hideDotfiles, alwaysHiddenPatterns } = visibility;
  return (name: string): boolean => {
    for (const pattern of alwaysHiddenPatterns) {
      if (matchesBasenameGlob(name, pattern)) return false;
    }
    if (hideDotfiles && name.startsWith(".")) return false;
    return true;
  };
}

/**
 * Whether the row for a worktree-relative path is currently visible: every path
 * segment below the browser root must pass the filter. Used to reconcile a
 * selection that a visibility change has just hidden. The root's own segments
 * are never tested — the root is the frame, not a row.
 */
export function isRowPathVisible(
  relativePath: string,
  rootPath: string,
  isVisible: (name: string) => boolean
): boolean {
  if (relativePath === rootPath) return true;
  const prefix = rootPath === "" ? "" : `${rootPath}/`;
  if (prefix !== "" && !relativePath.startsWith(prefix)) return false;
  const below = relativePath.slice(prefix.length);
  const segments = below.split("/").filter(Boolean);
  return segments.every((segment) => isVisible(segment));
}

/** Listing state for one directory, keyed by worktree-relative path ("" = root). */
export type DirectoryListings = ReadonlyMap<string, readonly FileTreeNode[]>;

/**
 * Flatten the loaded directory listings into the visible row list.
 *
 * Only expanded directories contribute children, and only directories whose
 * listing has already arrived — an expanded-but-unloaded directory renders as a
 * single loading row rather than blocking or collapsing. That is what keeps the
 * tree lazy: expanding a folder is what triggers its fetch, and the row list is
 * always renderable from whatever has arrived so far.
 */
export function flattenTree(
  listings: DirectoryListings,
  expandedPaths: ReadonlySet<string>,
  loadingPaths: ReadonlySet<string>,
  rootPath = "",
  isVisible?: (name: string) => boolean
): FlatTreeRow[] {
  const rows: FlatTreeRow[] = [];

  const walk = (dirPath: string, depth: number): void => {
    // Depth guard: a listings map assembled from a symlink cycle (or a bug in
    // the caller) would otherwise recurse until the stack blows. The service
    // skips symlinks, so this is a backstop, not the primary defense.
    if (depth > MAX_TREE_DEPTH) return;
    const children = listings.get(dirPath);
    if (!children) return;

    for (const node of children) {
      // A hidden entry contributes no row and, for a directory, no subtree —
      // so its children are never rendered and never fetched.
      if (isVisible && !isVisible(node.name)) continue;
      const isExpanded = node.isDirectory && expandedPaths.has(node.path);
      rows.push({
        path: node.path,
        name: node.name,
        isDirectory: node.isDirectory,
        depth,
        isExpanded,
        isLoading: node.isDirectory && loadingPaths.has(node.path) && !listings.has(node.path),
        ...(node.size != null && { size: node.size }),
      });
      if (isExpanded) walk(node.path, depth + 1);
    }
  };

  walk(rootPath, 0);
  return rows;
}

export const MAX_TREE_DEPTH = 64;

/**
 * Canonical forward-slash form of a worktree-relative browse root: collapses
 * duplicate separators, drops `.` segments and trailing slashes. Anything
 * traversal-shaped falls back to "" (the worktree root) — a root that can't
 * be trusted must fail toward showing more, never escaping.
 */
export function canonicalizeRootPath(value: string): string {
  const segments = value.split(/[\\/]+/).filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) return "";
  return segments.join("/");
}

/** One level up from a browse root; "" once the last segment is gone. */
export function parentRootPath(rootPath: string): string {
  return rootPath.split("/").slice(0, -1).join("/");
}

/**
 * Every ancestor directory of a worktree-relative path, root-first and
 * excluding the path itself. Used to reveal a remembered selection: the
 * directories on the way down have to be expanded before the row exists.
 */
export function ancestorDirectories(relativePath: string): string[] {
  const segments = relativePath.split("/").filter(Boolean);
  const ancestors: string[] = [];
  for (let i = 0; i < segments.length - 1; i += 1) {
    ancestors.push(segments.slice(0, i + 1).join("/"));
  }
  return ancestors;
}

/**
 * Where the keyboard should land for a tree key press, or null when the key
 * should fall through to the browser.
 *
 * Pure and separate from the component so the navigation contract — the part
 * with the real edge cases — is testable without a DOM. Follows the tree
 * conventions the issue asks for: right expands, then descends; left collapses,
 * then ascends to the parent.
 */
export type TreeKeyIntent =
  | { type: "select"; path: string }
  | { type: "expand"; path: string }
  | { type: "collapse"; path: string }
  | { type: "activate"; path: string };

export function resolveTreeKey(
  key: string,
  rows: readonly FlatTreeRow[],
  selectedPath: string | null
): TreeKeyIntent | null {
  if (rows.length === 0) return null;

  const index = selectedPath === null ? -1 : rows.findIndex((row) => row.path === selectedPath);
  const current = index >= 0 ? rows[index] : undefined;

  switch (key) {
    case "ArrowDown": {
      // No selection yet starts at the top rather than doing nothing, so the
      // first arrow press after focusing the tree is never a no-op.
      const next = rows[Math.min(index + 1, rows.length - 1)];
      return next ? { type: "select", path: next.path } : null;
    }
    case "ArrowUp": {
      if (index <= 0) return null;
      const previous = rows[index - 1];
      return previous ? { type: "select", path: previous.path } : null;
    }
    case "ArrowRight": {
      if (!current) return null;
      if (current.isDirectory && !current.isExpanded) {
        return { type: "expand", path: current.path };
      }
      // An already-expanded directory steps into its first child; a file has
      // nothing to open, so the key does nothing rather than jumping away.
      if (current.isDirectory) {
        const child = rows[index + 1];
        return child && child.depth > current.depth ? { type: "select", path: child.path } : null;
      }
      return null;
    }
    case "ArrowLeft": {
      if (!current) return null;
      if (current.isDirectory && current.isExpanded) {
        return { type: "collapse", path: current.path };
      }
      const parent = findParentRow(rows, index);
      return parent ? { type: "select", path: parent.path } : null;
    }
    case "Home": {
      const first = rows[0];
      return first ? { type: "select", path: first.path } : null;
    }
    case "End": {
      const last = rows[rows.length - 1];
      return last ? { type: "select", path: last.path } : null;
    }
    case "Enter": {
      if (!current) return null;
      return { type: "activate", path: current.path };
    }
    default:
      return null;
  }
}

/**
 * Nearest row above `index` with a smaller depth — the parent directory of the
 * row at `index`. Scans rather than deriving from the path so a row whose name
 * contains a separator can't confuse the lookup.
 */
function findParentRow(rows: readonly FlatTreeRow[], index: number): FlatTreeRow | undefined {
  const current = rows[index];
  if (!current || current.depth === 0) return undefined;
  for (let i = index - 1; i >= 0; i -= 1) {
    const candidate = rows[i];
    if (candidate && candidate.depth < current.depth) return candidate;
  }
  return undefined;
}

/**
 * Drop listings for directories that are no longer expanded, plus anything
 * beneath them.
 *
 * Collapsing a folder has to forget its subtree, not just hide it: keeping the
 * stale listing means re-expanding shows whatever was there minutes ago, and on
 * a worktree an agent is actively writing to, that is the wrong answer often
 * enough to matter. The root listing is always retained — it is what the tree
 * renders from.
 */
export function pruneListings(
  listings: DirectoryListings,
  expandedPaths: ReadonlySet<string>,
  rootPath = ""
): Map<string, readonly FileTreeNode[]> {
  const next = new Map<string, readonly FileTreeNode[]>();
  for (const [dirPath, nodes] of listings) {
    if (dirPath === rootPath || expandedPaths.has(dirPath)) next.set(dirPath, nodes);
  }
  return next;
}

/**
 * Bounds on a persisted tree snapshot (#11367). Listings mirror
 * `MAX_RESTORED_EXPANDED_PATHS` (the snapshot only ever holds the root plus
 * expanded directories); the node cap keeps a pathologically wide tree from
 * bloating the panel record. Capture returns null rather than truncating —
 * a partial directory presented as complete would be a lie the refresh can't
 * distinguish from a deletion — leaving any previous snapshot in place.
 */
export const MAX_SNAPSHOT_LISTINGS = 500;
export const MAX_SNAPSHOT_NODES = 10_000;

/**
 * Structure-only snapshot of the current listings for persistence (#11367):
 * names, paths and directory bits — `size` and `children` are deliberately
 * dropped. Null when there is nothing worth keeping (root never loaded) or
 * the tree exceeds the persistence bounds. Entries are sorted by path so two
 * captures of identical content are deep-equal regardless of Map insertion
 * order — the persistence layer's dirty diff relies on that to skip no-op
 * writes.
 */
export function snapshotFromListings(
  listings: DirectoryListings,
  worktreeId: string,
  rootPath: string
): FileBrowserTreeSnapshot | null {
  if (!listings.has(rootPath)) return null;
  if (listings.size > MAX_SNAPSHOT_LISTINGS) return null;
  let totalNodes = 0;
  const entries: FileBrowserTreeSnapshot["listings"] = [];
  for (const [dirPath, nodes] of listings) {
    totalNodes += nodes.length;
    if (totalNodes > MAX_SNAPSHOT_NODES) return null;
    entries.push({
      dirPath,
      nodes: nodes.map((node) => ({
        name: node.name,
        path: node.path,
        isDirectory: node.isDirectory,
      })),
    });
  }
  entries.sort((a, b) => (a.dirPath < b.dirPath ? -1 : a.dirPath > b.dirPath ? 1 : 0));
  return { worktreeId, rootPath, listings: entries };
}

/**
 * Rebuild a listings map from a persisted snapshot. The snapshot nodes are
 * already structure-only, so they slot directly into the `FileTreeNode` shape
 * the tree renders from (`size`/`children` are optional there).
 */
export function listingsFromSnapshot(
  snapshot: FileBrowserTreeSnapshot
): Map<string, readonly FileTreeNode[]> {
  const listings = new Map<string, readonly FileTreeNode[]>();
  for (const entry of snapshot.listings) {
    listings.set(entry.dirPath, entry.nodes);
  }
  return listings;
}

/**
 * The directories whose listings a refresh should re-fetch: the root plus every
 * expanded directory that is actually reachable from it.
 *
 * Reachability matters because `expandedPaths` persists across sessions and
 * survives its directory being deleted. Without this filter a browser restored
 * onto a changed worktree would re-request every folder the user ever opened,
 * including ones that no longer exist, on every single refresh tick.
 */
export function refreshTargets(
  listings: DirectoryListings,
  expandedPaths: ReadonlySet<string>,
  rootPath = "",
  isVisible?: (name: string) => boolean
): string[] {
  const targets = [rootPath];
  const walk = (dirPath: string, depth: number): void => {
    if (depth > MAX_TREE_DEPTH) return;
    const children = listings.get(dirPath);
    if (!children) return;
    for (const node of children) {
      if (!node.isDirectory || !expandedPaths.has(node.path)) continue;
      // A hidden directory has no row, so re-listing it (and its subtree) every
      // tick is pure waste — skip it and everything beneath it.
      if (isVisible && !isVisible(node.name)) continue;
      targets.push(node.path);
      walk(node.path, depth + 1);
    }
  };
  walk(rootPath, 0);
  return targets;
}
