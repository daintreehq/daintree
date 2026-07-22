import type { FileTreeNode } from "@shared/types";

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
  /** Whether git reports this entry as ignored (only ever true when showing ignored) */
  isIgnored: boolean;
  /** Byte size for files; undefined for directories */
  size?: number;
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
  rootPath = ""
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
      const isExpanded = node.isDirectory && expandedPaths.has(node.path);
      rows.push({
        path: node.path,
        name: node.name,
        isDirectory: node.isDirectory,
        depth,
        isExpanded,
        isLoading: node.isDirectory && loadingPaths.has(node.path) && !listings.has(node.path),
        isIgnored: node.isIgnored === true,
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
  rootPath = ""
): string[] {
  const targets = [rootPath];
  const walk = (dirPath: string, depth: number): void => {
    if (depth > MAX_TREE_DEPTH) return;
    const children = listings.get(dirPath);
    if (!children) return;
    for (const node of children) {
      if (!node.isDirectory || !expandedPaths.has(node.path)) continue;
      targets.push(node.path);
      walk(node.path, depth + 1);
    }
  };
  walk(rootPath, 0);
  return targets;
}
