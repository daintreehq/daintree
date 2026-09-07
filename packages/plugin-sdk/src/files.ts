/**
 * `@daintreehq/plugin-sdk/files` — the file-listing machinery Daintree's own
 * file browser runs on.
 *
 * A plugin presenting files should not have to rebuild any of this. What ships
 * here is the part that is genuinely hard and genuinely accumulated: the tree
 * model (lazy children, expansion, flattening to rows, sorting, hidden-entry
 * counting, keyboard navigation), the changed-file status index with its folder
 * roll-up, and several hundred curated filename→category classifications.
 *
 * It is deliberately **headless**. There are no React components, no icons and
 * no styling — a plugin building a custom browser wants its own chrome, and
 * exporting ours would freeze Daintree's internal component contract into the
 * plugin API. What you get is the model; what it looks like is yours.
 *
 * **Everything here is pure.** No I/O, no filesystem access, no clock. Feed it
 * directory listings from `host.fs.readdir(dir, { detail: true })`, which
 * returns the same `FileTreeNode` shape this model consumes. Paths are the
 * slash-separated, root-relative form that listing produces — these helpers do
 * lexical work only and never touch the filesystem, so "canonicalize" here means
 * normalising a string, never resolving a symlink.
 *
 * This is a separate subpath from the SDK root so a plugin's `main` does not
 * pull the file machinery into the main-process bundle just by importing the
 * host types.
 *
 * **Deliberately not exported**, though they exist in the source Daintree's own
 * browser imports: the tree-snapshot persistence helpers and their bounds, the
 * listing-cache eviction policy, and the `FileBrowserSource` union they are
 * keyed by. That union is host vocabulary — it names a worktree id a plugin has
 * no way to construct — and the snapshot format has no version or migration
 * story yet. Publishing them would freeze both before either is ready. Ask if
 * you need tree persistence and we will design a host-neutral shape for it.
 */

export {
  // Tree model — feed it listings, get the flat row list a virtualised list
  // renders.
  flattenTree,
  buildFolderListingRows,
  findNodeInListings,
  sortFileNodes,
  // Sorting
  DEFAULT_FILE_SORT,
  isDefaultFileSort,
  // Visibility / hidden entries
  createVisibilityFilter,
  countHiddenRows,
  isRowPathVisible,
  NO_HIDDEN_ROWS,
  // Lexical path helpers. String manipulation only — none of these consult the
  // filesystem or resolve links.
  parentDirectoryOf,
  canonicalizeRootPath,
  parentRootPath,
  ancestorDirectories,
  // Keyboard navigation. Both take a plain key name rather than a DOM event and
  // return a decision, so they work in any renderer.
  resolveTypeahead,
  resolveTreeKey,
  TYPEAHEAD_RESET_MS,
} from "./files/fileTree.js";

export type {
  FlatTreeRow,
  FolderListingRow,
  FileEntryLike,
  FileBrowserSortOrder,
  FileBrowserSortKey,
  FileBrowserSortDirection,
  FileVisibility,
  HiddenRowCounts,
  DirectoryListings,
  TreeKeyIntent,
} from "./files/fileTree.js";

export { buildFileBrowserGitStatusIndex, getFileBrowserRowGitStatus } from "./files/gitStatus.js";

export type { FileBrowserGitStatusIndex } from "./files/gitStatus.js";

export { getFileTypeCategory } from "./files/fileTypeCategory.js";

export type { FileTypeCategory } from "./files/fileTypeCategory.js";
