import type { FileTreeNode, FileTreeSymlink } from "@shared/types";
import type {
  FileBrowserSortDirection,
  FileBrowserSortKey,
  FileBrowserTreeSnapshot,
} from "@shared/types/panel";

/**
 * What a browser panel is rooted at.
 *
 * `worktree` is the original mode: listings route through the worktree's
 * workspace host and the tree gets git/filesystem change ticks. `workspace` is
 * the view's own project or scratch folder (#11482) — reachable without a
 * worktree, but with no host and no tick source, so it refreshes on demand
 * only.
 *
 * `basePath` is resolved fresh from the store on every render rather than
 * persisted, so a rename, move or relocation is reflected without restarting
 * the panel — and, for `workspace`, so it can never drift from the root main
 * independently derives from the same sender binding.
 */
export type FileBrowserSource =
  | { kind: "worktree"; worktreeId: string; basePath: string }
  | { kind: "workspace"; basePath: string };

/**
 * Identity of a source for generation resets — changing it invalidates every
 * in-flight listing. The kind is part of the key so a worktree and a workspace
 * that happen to share a path are still distinct identities.
 */
export function sourceIdentityKey(source: FileBrowserSource | null): string | null {
  if (!source) return null;
  return source.kind === "worktree"
    ? `worktree:${source.worktreeId}`
    : `workspace:${source.basePath}`;
}

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
  /**
   * Present only on rows that are symbolic links (#11939). `isDirectory` still
   * answers whether the row behaves as a directory — the listing reports the
   * link's *target* kind — so nothing that reads that field needs to know
   * about this one.
   */
  symlink?: FileTreeSymlink;
  /**
   * 1-based position among the row's *visible* siblings, and how many there
   * are. Computed here rather than in the view because only this walk knows
   * what the visibility filter removed: the APG requires `aria-posinset` /
   * `aria-setsize` on a treeitem whose group nesting the DOM does not express,
   * and a virtualized flat list never expresses it. Counting pre-filter would
   * announce positions that do not exist on screen.
   */
  posInSet: number;
  setSize: number;
}

/**
 * The part of a row every entry-level action actually needs: which path, what
 * it's called, and whether it's a directory. Both `FlatTreeRow` and
 * `FolderListingRow` satisfy it structurally, which is what lets the tree and
 * the folder listing share one context-menu builder instead of maintaining two
 * copies of the same menu (#11620).
 */
export interface FileEntryLike {
  path: string;
  name: string;
  isDirectory: boolean;
}

/**
 * One rendered line of a folder's contents listing (#11620) — the flat,
 * depth-less counterpart to `FlatTreeRow`. Built from one already-cached
 * directory listing, never its own fetch.
 */
export interface FolderListingRow {
  /** Worktree-relative path; unique within the folder, so it doubles as the React key */
  path: string;
  name: string;
  isDirectory: boolean;
  /** Byte size for files; undefined for directories and for snapshot-restored nodes */
  size?: number;
  /** Epoch ms; undefined for snapshot-restored nodes, which carry structure only */
  mtimeMs?: number;
  /**
   * Visible entries directly inside this directory — never recursive, and only
   * when that directory's own listing already happens to be cached. Undefined
   * means "not known", which the row renders as unknown rather than as zero: a
   * folder the user has never opened is not an empty folder.
   */
  itemCount?: number;
  /** Present only on rows that are symbolic links (#11939). */
  symlink?: FileTreeSymlink;
}

export type { FileBrowserSortDirection, FileBrowserSortKey };

/** The sort menu's full state: what to order by, and which way. */
export interface FileBrowserSortOrder {
  key: FileBrowserSortKey;
  direction: FileBrowserSortDirection;
}

/**
 * The order the service already returns: folders first, then natural-numeric
 * name (see `FileTreeService`). Sorting by it is a no-op, which is what lets
 * `sortFileNodes` hand back the original array untouched on the default path.
 */
export const DEFAULT_FILE_SORT: FileBrowserSortOrder = { key: "name", direction: "asc" };

export function isDefaultFileSort(sort: FileBrowserSortOrder): boolean {
  return sort.key === DEFAULT_FILE_SORT.key && sort.direction === DEFAULT_FILE_SORT.direction;
}

/**
 * Same collation the service sorts with (`FileTreeService`'s `NAME_COLLATOR`):
 * natural-numeric so `version_10` follows `version_9`, host locale, default
 * sensitivity. Constructed once at module scope — a re-sort touches every node
 * in a directory, and per-call collator construction is costly.
 */
const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true });

/**
 * Total, deterministic name order. Numeric collation alone is not a total
 * order — `file1`, `file01` and `file001` all compare equal — so ties fall
 * through to codepoint comparison rather than to the array's incoming order,
 * which mirrors the service and keeps a client re-sort stable across platforms.
 */
function compareNames(a: string, b: string): number {
  const collated = NAME_COLLATOR.compare(a, b);
  if (collated !== 0) return collated;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Everything after the last dot, lowercased; "" for a dotfile or a name with no
 * dot. `.gitignore` is a name, not an extension — treating its suffix as a type
 * would file every dotfile under a different heading.
 */
function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

/**
 * Compare two nodes for one sort key, with unknowns pushed last.
 *
 * A node restored from a persisted snapshot carries neither `size` nor
 * `mtimeMs` (the snapshot is structure-only by design, #11367), so those keys
 * have to answer for "unknown". Unknowns sort last in *both* directions rather
 * than flipping to the top on descending: they are absent data, not a low
 * value, and a column of em-dashes above the real rows would read as the sort
 * being broken.
 */
function compareByKey(a: FileTreeNode, b: FileTreeNode, key: FileBrowserSortKey): number {
  switch (key) {
    case "modified":
      return compareOptionalNumbers(a.mtimeMs, b.mtimeMs);
    case "size":
      return compareOptionalNumbers(a.size, b.size);
    case "type":
      return compareNames(fileExtension(a.name), fileExtension(b.name));
    case "name":
      return 0;
  }
}

/**
 * Ascending, with unknown values always last regardless of the caller's
 * direction. Anything non-finite counts as unknown: `NaN` compares false
 * against everything including itself, which would make this comparator
 * non-antisymmetric and hand V8 an inconsistent ordering to act on.
 */
function compareOptionalNumbers(a: number | undefined, b: number | undefined): number {
  const knownA = a !== undefined && Number.isFinite(a);
  const knownB = b !== undefined && Number.isFinite(b);
  if (!knownA && !knownB) return 0;
  // Signalled to the caller as a fixed order by `sortFileNodes`, which skips
  // the direction flip whenever this returns a non-finite result.
  if (!knownA) return Number.POSITIVE_INFINITY;
  if (!knownB) return Number.NEGATIVE_INFINITY;
  return a === b ? 0 : (a as number) < (b as number) ? -1 : 1;
}

/**
 * Order one directory's entries for display.
 *
 * Folders always lead, in every key and both directions — the grouping is
 * structural (it is what makes a listing scannable), not part of what the user
 * chose to sort by, and it matches what every file manager does. Direction
 * flips only *within* each group.
 *
 * Returns the input array by reference when the order asked for is the one the
 * service already produced, so the default path costs nothing and the tree's
 * memoized rows keep their identity.
 */
export function sortFileNodes(
  nodes: readonly FileTreeNode[],
  sort: FileBrowserSortOrder
): readonly FileTreeNode[] {
  if (isDefaultFileSort(sort)) return nodes;
  const flip = sort.direction === "desc" ? -1 : 1;
  return [...nodes].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    const primary = compareByKey(a, b, sort.key);
    // An infinite result marks a missing value, which holds its place at the
    // bottom instead of being flipped to the top by a descending sort.
    if (!Number.isFinite(primary)) return primary > 0 ? 1 : -1;
    if (primary !== 0) return primary * flip;
    // Name is the tie-break for every other key, and it flips with the
    // direction too — otherwise a descending size sort would list equal-sized
    // files ascending, which reads as the sort half-applying.
    return compareNames(a.name, b.name) * flip;
  });
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

/** How many rows each hiding mechanism is currently removing from the tree. */
export interface HiddenRowCounts {
  /** Removed by the per-panel dotfile toggle, and revealable by turning it off. */
  dotfiles: number;
  /** Removed by the app-global always-hidden junk list, which lives in Settings. */
  alwaysHidden: number;
}

export const NO_HIDDEN_ROWS: HiddenRowCounts = { dotfiles: 0, alwaysHidden: 0 };

/**
 * How many rows the two filters are removing from the branches the tree is
 * *currently showing* — the same walk `flattenTree` does, so the number always
 * describes the rows the user could otherwise see right now.
 *
 * Deliberately bounded to loaded, expanded branches. A collapsed folder's
 * contents have usually never been fetched, so any deeper total would be a
 * guess that changes as listings arrive, and a count that climbs on its own
 * while the user is not doing anything is worse than no count at all.
 *
 * The two categories stay separate because their recoveries differ: dotfiles
 * are one toggle away in this panel, while the junk list is an app-global
 * setting. Collapsing them into one number would offer a fix that does not
 * work for half the rows it claims.
 */
export function countHiddenRows(
  listings: DirectoryListings,
  expandedPaths: ReadonlySet<string>,
  rootPath = "",
  visibility: FileVisibility
): HiddenRowCounts {
  const { hideDotfiles, alwaysHiddenPatterns } = visibility;
  let dotfiles = 0;
  let alwaysHidden = 0;

  const isJunk = (name: string): boolean =>
    alwaysHiddenPatterns.some((pattern) => matchesBasenameGlob(name, pattern));

  const walk = (dirPath: string, depth: number): void => {
    // The same depth bound `flattenTree` walks under, and for the same reason:
    // a symlink cycle would otherwise recurse until the stack blows.
    if (depth > MAX_TREE_DEPTH) return;
    const listed = listings.get(dirPath);
    if (!listed) return;

    for (const node of listed) {
      // Junk is counted first and wins: an entry matching both (`.DS_Store` is
      // a dotfile *and* junk) is not revealable by the dotfile toggle, so
      // counting it as a dotfile would promise a recovery that does nothing.
      if (isJunk(node.name)) {
        alwaysHidden += 1;
        continue;
      }
      if (hideDotfiles && node.name.startsWith(".")) {
        dotfiles += 1;
        continue;
      }
      // Only visible directories are descended into — a hidden folder's
      // children are not rows the user is missing from *this* view, they are
      // rows behind one collapsed parent, and counting them would inflate the
      // badge by whole subtrees.
      if (node.isDirectory && expandedPaths.has(node.path)) walk(node.path, depth + 1);
    }
  };

  walk(rootPath, 0);
  return { dotfiles, alwaysHidden };
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
  isVisible?: (name: string) => boolean,
  sort: FileBrowserSortOrder = DEFAULT_FILE_SORT
): FlatTreeRow[] {
  const rows: FlatTreeRow[] = [];

  const walk = (dirPath: string, depth: number): void => {
    // Depth guard: a listings map whose directories contain one another — the
    // shape a symlink cycle produces, now that the service lists symlinks
    // (#11939) — would otherwise recurse until the stack blows.
    //
    // This is the bound on *rendering*, and it is the only one needed. A cycle
    // cannot run away on its own: every listing is one level fetched on
    // explicit expansion, nothing auto-expands, and a restored panel replays a
    // finite recorded set. Reaching depth 64 through a loop takes 64 deliberate
    // clicks, and the rows simply stop there.
    if (depth > MAX_TREE_DEPTH) return;
    const listed = listings.get(dirPath);
    if (!listed) return;
    // Per level, not across the whole tree: each directory's entries are
    // ordered among themselves, which is the only ordering a tree can express.
    // Never in place — the listings map is what `snapshotFromListings` persists
    // and what an unsorted consumer reads, so it must stay as the service sent
    // it.
    const children = sortFileNodes(listed, sort);
    // Filtered first, then enumerated: `setSize` has to be the number of rows
    // that actually render at this level, so the hidden entries must be gone
    // before anything is counted.
    const visible = isVisible ? children.filter((node) => isVisible(node.name)) : children;

    let position = 0;
    for (const node of visible) {
      position += 1;
      const isExpanded = node.isDirectory && expandedPaths.has(node.path);
      rows.push({
        path: node.path,
        name: node.name,
        isDirectory: node.isDirectory,
        depth,
        isExpanded,
        isLoading: node.isDirectory && loadingPaths.has(node.path) && !listings.has(node.path),
        posInSet: position,
        setSize: visible.length,
        ...(node.size != null && { size: node.size }),
        ...(node.symlink && { symlink: node.symlink }),
      });
      if (isExpanded) walk(node.path, depth + 1);
    }
  };

  walk(rootPath, 0);
  return rows;
}

export const MAX_TREE_DEPTH = 64;

/**
 * Build the rows for one folder's contents listing (#11620) from the listing
 * that folder already has cached — never a fetch, and never recursive.
 *
 * Returns null when that folder has not been listed yet, which is the caller's
 * raw "still pending" signal: it is deliberately distinguishable from an empty
 * array (a folder that really holds nothing) so the two never collapse into one
 * indistinguishable state.
 *
 * A directory row's `itemCount` is filled in only when that child's own listing
 * happens to already be cached — expanding it in the tree is what puts it
 * there. Counting means counting *visible* entries, so the number always agrees
 * with what opening the folder would show.
 */
export function buildFolderListingRows(
  listings: DirectoryListings,
  dirPath: string,
  isVisible?: (name: string) => boolean,
  sort: FileBrowserSortOrder = DEFAULT_FILE_SORT
): FolderListingRow[] | null {
  const listed = listings.get(dirPath);
  if (!listed) return null;
  const visible = isVisible ? listed.filter((node) => isVisible(node.name)) : listed;
  return sortFileNodes(visible, sort).map((node) => {
    const childListing = node.isDirectory ? listings.get(node.path) : undefined;
    const itemCount =
      childListing === undefined
        ? undefined
        : isVisible
          ? childListing.filter((child) => isVisible(child.name)).length
          : childListing.length;
    return {
      path: node.path,
      name: node.name,
      isDirectory: node.isDirectory,
      ...(node.size != null && { size: node.size }),
      ...(node.mtimeMs != null && { mtimeMs: node.mtimeMs }),
      ...(itemCount != null && { itemCount }),
      ...(node.symlink && { symlink: node.symlink }),
    };
  });
}

/**
 * Look one worktree-relative path up in the loaded listings by asking its
 * parent directory, or undefined when that parent has not been listed.
 *
 * This is how the panel learns whether a selection is a file or a folder.
 * Deriving it from the rendered tree rows instead would make the answer depend
 * on what is expanded — and the folder listing can select an entry whose parent
 * is collapsed in the tree, which has no row at all.
 */
export function findNodeInListings(
  listings: DirectoryListings,
  relativePath: string
): FileTreeNode | undefined {
  const parent = parentDirectoryOf(relativePath);
  return listings.get(parent)?.find((node) => node.path === relativePath);
}

/**
 * The directory a worktree-relative path lives in; "" for a root-level entry.
 * This is the listing that answers what the path is, which is why the prune
 * has to keep it alive for as long as something is asking.
 */
export function parentDirectoryOf(relativePath: string): string {
  const slash = relativePath.lastIndexOf("/");
  return slash === -1 ? "" : relativePath.slice(0, slash);
}

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
/**
 * Typeahead: the row a printable-prefix buffer should move the cursor to.
 *
 * Searches forward from the row *after* the cursor and wraps once, so repeating
 * the same letter cycles through every match rather than sticking on the first.
 * The one exception is a buffer that is still being typed (length > 1), which
 * re-tests the cursor row first — otherwise typing `sr` in a folder holding
 * `src` would match `src` on the `s`, then skip past it looking for the next
 * `sr` and land somewhere unrelated.
 *
 * Case-insensitive, and matched against the row `name` rather than the path:
 * the name is what is rendered, and a user typing `p` means the `panels` they
 * can see, not `src/panels`.
 *
 * Returns null when nothing matches, which the caller must treat as "do
 * nothing" — moving the cursor on a failed match would make a typo silently
 * navigate somewhere.
 */
export function resolveTypeahead(
  buffer: string,
  rows: readonly FlatTreeRow[],
  cursorPath: string | null
): string | null {
  if (buffer === "" || rows.length === 0) return null;
  const prefix = buffer.toLowerCase();
  const index = cursorPath === null ? -1 : rows.findIndex((row) => row.path === cursorPath);

  // A multi-character buffer is a refinement of the search that just matched,
  // so the row it landed on is a legitimate answer again.
  const start = buffer.length > 1 ? index : index + 1;
  const total = rows.length;
  for (let offset = 0; offset < total; offset++) {
    const row = rows[(Math.max(start, 0) + offset) % total];
    if (row && row.name.toLowerCase().startsWith(prefix)) return row.path;
  }
  return null;
}

/**
 * How long a typeahead buffer survives without another keystroke. The WAI-ARIA
 * APG leaves this to the implementation; 1000ms is the long-standing platform
 * default (Windows list views, macOS Finder) and is what a user who pauses
 * mid-word expects to have been forgotten.
 */
export const TYPEAHEAD_RESET_MS = 1000;

export type TreeKeyIntent =
  | { type: "select"; path: string }
  | { type: "expand"; path: string }
  | { type: "collapse"; path: string }
  | { type: "activate"; path: string };

export function resolveTreeKey(
  key: string,
  rows: readonly FlatTreeRow[],
  cursorPath: string | null
): TreeKeyIntent | null {
  if (rows.length === 0) return null;

  const index = cursorPath === null ? -1 : rows.findIndex((row) => row.path === cursorPath);
  const current = index >= 0 ? rows[index] : undefined;

  switch (key) {
    case "ArrowDown": {
      // No cursor yet starts at the top rather than doing nothing, so the
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
 *
 * `keepPaths` retains directories the viewer still depends on even when they
 * are collapsed (#11620): the folder whose contents are being listed, and the
 * parent that answers what the current selection *is*. Neither is the stale,
 * unused listing this prune exists to drop — and both matter because selection
 * and expansion are independent. Without the first, collapsing any *other*
 * folder evicts the listing being read; without the second, picking a file out
 * of that listing drops the very listing that knows it is a file, and the
 * viewer blanks the instant it is clicked.
 */
export function pruneListings(
  listings: DirectoryListings,
  expandedPaths: ReadonlySet<string>,
  rootPath = "",
  keepPaths: readonly string[] = []
): Map<string, readonly FileTreeNode[]> {
  const next = new Map<string, readonly FileTreeNode[]>();
  for (const [dirPath, nodes] of listings) {
    if (dirPath === rootPath || keepPaths.includes(dirPath) || expandedPaths.has(dirPath))
      next.set(dirPath, nodes);
  }
  return next;
}

/**
 * Bounds on a persisted tree snapshot (#11367). Listings mirror
 * `MAX_RESTORED_EXPANDED_PATHS` (the snapshot only ever holds the root plus
 * expanded directories); the node cap keeps a pathologically wide tree from
 * bloating the panel record, and the text budget bounds the *bytes* the
 * counts alone would not — 10k nodes of 4k-character paths would be tens of
 * megabytes serialized into every project-state save. Capture returns null
 * rather than truncating — a partial directory presented as complete would
 * be a lie the refresh can't distinguish from a deletion — leaving any
 * previous snapshot in place.
 */
export const MAX_SNAPSHOT_LISTINGS = 500;
export const MAX_SNAPSHOT_NODES = 10_000;
/** Aggregate cap on name+path characters across the whole snapshot (~1MB UTF-16). */
export const MAX_SNAPSHOT_TEXT_CHARS = 512_000;

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
  source: FileBrowserSource,
  rootPath: string
): FileBrowserTreeSnapshot | null {
  if (!listings.has(rootPath)) return null;
  if (listings.size > MAX_SNAPSHOT_LISTINGS) return null;
  let totalNodes = 0;
  let totalChars = 0;
  const entries: FileBrowserTreeSnapshot["listings"] = [];
  for (const [dirPath, nodes] of listings) {
    totalNodes += nodes.length;
    if (totalNodes > MAX_SNAPSHOT_NODES) return null;
    // Listing keys count against the budget too — 500 deep dirPaths carry
    // real bytes even with few nodes.
    totalChars += dirPath.length;
    for (const node of nodes) {
      totalChars += node.name.length + node.path.length;
    }
    if (totalChars > MAX_SNAPSHOT_TEXT_CHARS) return null;
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
  return {
    ...(source.kind === "worktree" && { worktreeId: source.worktreeId }),
    basePath: source.basePath,
    rootPath,
    listings: entries,
  };
}

/**
 * Whether a persisted snapshot was captured under the identity now being
 * rendered. Both tags must agree: the worktree id (absent on both sides for a
 * workspace-rooted browser) and the absolute base, which catches a relocated
 * project that kept its id. A mismatch just cold-starts.
 */
export function snapshotMatchesSource(
  snapshot: FileBrowserTreeSnapshot,
  source: FileBrowserSource,
  rootPath: string
): boolean {
  const snapshotWorktreeId = snapshot.worktreeId;
  const sourceWorktreeId = source.kind === "worktree" ? source.worktreeId : undefined;
  if (snapshotWorktreeId !== sourceWorktreeId) return false;
  if (snapshotWorktreeId === undefined) {
    // A workspace snapshot has no worktree id, so the base is its only
    // identity — an absent one would match every workspace and let a corrupt
    // record paint fabricated rows in any of them.
    if (snapshot.basePath !== source.basePath) return false;
  } else if (snapshot.basePath !== undefined && snapshot.basePath !== source.basePath) {
    // Absent is tolerated here alone: snapshots written before the base tag
    // existed are worktree-rooted, and their worktree id already pins identity.
    return false;
  }
  return snapshot.rootPath === rootPath;
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
  isVisible?: (name: string) => boolean,
  keepPath: string | null = null
): string[] {
  const targets = [rootPath];
  // The folder the viewer is listing is re-read like an expanded one even when
  // it is collapsed in the tree (#11620) — it is on screen, so leaving it out
  // would let it go stale while the tree beside it updates. Added up front and
  // guarded below so the walk can't list it twice.
  if (keepPath !== null && keepPath !== rootPath && !expandedPaths.has(keepPath)) {
    targets.push(keepPath);
  }
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
