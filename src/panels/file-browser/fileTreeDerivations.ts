import type { FileTreeNode } from "@shared/types";
import {
  countHiddenRows,
  createVisibilityFilter,
  DEFAULT_FILE_SORT,
  flattenTree,
  MAX_TREE_DEPTH,
  sortFileNodes,
  type DirectoryListings,
  type FileBrowserSortOrder,
  type FileVisibility,
  type FlatTreeRow,
  type HiddenRowCounts,
} from "./fileBrowserTree";

/**
 * Per-listing memos for the tree's render-time derivations.
 *
 * Every directory landing hands the hook a new listings map, and each of these
 * derivations used to re-walk every loaded directory — re-sorting and
 * re-filtering all of them — to account for the one that changed. Restoring a
 * tree with many expanded folders paid that for every folder as it arrived.
 *
 * Keyed by the listing array itself: a fetch always stores a fresh array and
 * nothing mutates one in place (the maps are copied, never the arrays), so an
 * array that is still in the map still has the contents it was cached with.
 * Each array keeps only its most recent result — the inputs that vary (sort,
 * filter) change on a user gesture, not per landing, so one slot is all a
 * landing burst ever hits.
 */

interface DisplayEntry {
  isVisible: ((name: string) => boolean) | undefined;
  sortKey: FileBrowserSortOrder["key"];
  sortDirection: FileBrowserSortOrder["direction"];
  children: readonly FileTreeNode[];
}

const displayCache = new WeakMap<readonly FileTreeNode[], DisplayEntry>();

function displayChildren(
  listed: readonly FileTreeNode[],
  isVisible: ((name: string) => boolean) | undefined,
  sort: FileBrowserSortOrder
): readonly FileTreeNode[] {
  const cached = displayCache.get(listed);
  if (
    cached !== undefined &&
    cached.isVisible === isVisible &&
    cached.sortKey === sort.key &&
    cached.sortDirection === sort.direction
  ) {
    return cached.children;
  }
  // Sorted then filtered, the order `flattenTree` applies them in.
  const sorted = sortFileNodes(listed, sort);
  const children = isVisible ? sorted.filter((node) => isVisible(node.name)) : sorted;
  displayCache.set(listed, {
    isVisible,
    sortKey: sort.key,
    sortDirection: sort.direction,
    children,
  });
  return children;
}

/**
 * The raw listings seen through their display order: same keys, so `has` (which
 * `isLoading` reads) answers exactly as the raw map does, but each value is the
 * sorted, filtered children. Derived on read, so a listing the walk never
 * reaches — under a collapsed or newly hidden parent — is never sorted.
 */
class DisplayListings implements ReadonlyMap<string, readonly FileTreeNode[]> {
  constructor(
    private readonly raw: DirectoryListings,
    private readonly isVisible: ((name: string) => boolean) | undefined,
    private readonly sort: FileBrowserSortOrder
  ) {}

  get size(): number {
    return this.raw.size;
  }

  has(key: string): boolean {
    return this.raw.has(key);
  }

  get(key: string): readonly FileTreeNode[] | undefined {
    const listed = this.raw.get(key);
    return listed && displayChildren(listed, this.isVisible, this.sort);
  }

  *entries(): MapIterator<[string, readonly FileTreeNode[]]> {
    for (const [key, listed] of this.raw) {
      yield [key, displayChildren(listed, this.isVisible, this.sort)];
    }
  }

  keys(): MapIterator<string> {
    return this.raw.keys();
  }

  *values(): MapIterator<readonly FileTreeNode[]> {
    for (const [, children] of this.entries()) yield children;
  }

  forEach(
    callback: (
      value: readonly FileTreeNode[],
      key: string,
      map: ReadonlyMap<string, readonly FileTreeNode[]>
    ) => void,
    thisArg?: unknown
  ): void {
    for (const [key, children] of this.entries()) callback.call(thisArg, children, key, this);
  }

  [Symbol.iterator](): MapIterator<[string, readonly FileTreeNode[]]> {
    return this.entries();
  }
}

/**
 * `flattenTree` with each directory's sorted, filtered children reused across
 * calls. The SDK walk is fed listings already in display order and already
 * filtered, so its own sort is the default-order no-op and its filter is
 * skipped — the rows it emits are the ones it would have built from the raw
 * listings.
 */
export function flattenTreeMemo(
  listings: DirectoryListings,
  expandedPaths: ReadonlySet<string>,
  loadingPaths: ReadonlySet<string>,
  rootPath: string,
  isVisible: ((name: string) => boolean) | undefined,
  sort: FileBrowserSortOrder
): FlatTreeRow[] {
  return flattenTree(
    new DisplayListings(listings, isVisible, sort),
    expandedPaths,
    loadingPaths,
    rootPath,
    undefined,
    DEFAULT_FILE_SORT
  );
}

interface HiddenEntry {
  hideDotfiles: boolean;
  alwaysHiddenPatterns: readonly string[];
  counts: HiddenRowCounts;
  /** Directory entries neither filter removes — the ones `countHiddenRows` may descend into. */
  descendable: readonly string[];
}

const hiddenCache = new WeakMap<readonly FileTreeNode[], HiddenEntry>();
const EMPTY_EXPANDED: ReadonlySet<string> = new Set();

function hiddenEntry(listed: readonly FileTreeNode[], visibility: FileVisibility): HiddenEntry {
  const cached = hiddenCache.get(listed);
  if (
    cached !== undefined &&
    cached.hideDotfiles === visibility.hideDotfiles &&
    cached.alwaysHiddenPatterns === visibility.alwaysHiddenPatterns
  ) {
    return cached;
  }
  // The single-level tally comes from the SDK itself, so the classification
  // (junk wins over dotfile) is never restated here.
  const counts = countHiddenRows(new Map([["", listed]]), EMPTY_EXPANDED, "", visibility);
  // `countHiddenRows` descends into exactly the directories neither filter
  // removes, which is what the visibility predicate answers.
  const isVisible = createVisibilityFilter(visibility);
  const descendable = listed
    .filter((node) => node.isDirectory && isVisible(node.name))
    .map((node) => node.path);
  const entry: HiddenEntry = {
    hideDotfiles: visibility.hideDotfiles,
    alwaysHiddenPatterns: visibility.alwaysHiddenPatterns,
    counts,
    descendable,
  };
  hiddenCache.set(listed, entry);
  return entry;
}

/** `countHiddenRows` summed from per-listing tallies instead of a fresh walk. */
export function countHiddenRowsMemo(
  listings: DirectoryListings,
  expandedPaths: ReadonlySet<string>,
  rootPath: string,
  visibility: FileVisibility
): HiddenRowCounts {
  let dotfiles = 0;
  let alwaysHidden = 0;

  const walk = (dirPath: string, depth: number): void => {
    if (depth > MAX_TREE_DEPTH) return;
    const listed = listings.get(dirPath);
    if (!listed) return;
    const entry = hiddenEntry(listed, visibility);
    dotfiles += entry.counts.dotfiles;
    alwaysHidden += entry.counts.alwaysHidden;
    for (const path of entry.descendable) {
      if (expandedPaths.has(path)) walk(path, depth + 1);
    }
  };

  walk(rootPath, 0);
  return { dotfiles, alwaysHidden };
}
