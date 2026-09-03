/**
 * The small value types the file-tree model is parameterised by.
 *
 * Split out of `panel.ts` for a mechanical reason: the plugin SDK ships the
 * tree model, and its declaration bundle is built by following every import.
 * `panel.ts` is the app's whole panel union, so reaching into it from the
 * package drags the entire renderer type graph — terminals, xterm, forge — into
 * something whose point is to be dependency-free. Three unions and two record
 * shapes do not justify that.
 *
 * `panel.ts` re-exports everything here, so the persisted panel fields and the
 * tree model that produces them stay one definition rather than two that drift.
 * It lives in `shared/` rather than in the package because the dependency
 * direction is enforced the other way: `shared/` is its own TS project and
 * cannot import from `packages/`.
 */

/** One directory entry in a persisted file-browser tree snapshot. */
export interface FileBrowserSnapshotNode {
  /** Entry basename. */
  name: string;
  /** Root-relative path. */
  path: string;
  isDirectory: boolean;
}

/** One directory's listing in a persisted file-browser tree snapshot. */
export interface FileBrowserTreeSnapshotEntry {
  /** Root-relative directory path; "" = the browse root's own listing. */
  dirPath: string;
  nodes: FileBrowserSnapshotNode[];
}

/**
 * Structure-only snapshot of a file browser's last-known tree (#11367): entry
 * names, paths and directory bits — never contents, sizes or timestamps.
 * Tagged with the identity it was captured under so a worktree switch or
 * re-root can't seed the wrong tree; a mismatch just cold-starts. Arrays
 * rather than a Map because it round-trips through JSON persistence.
 */
export interface FileBrowserTreeSnapshot {
  /** Absent when the browser is rooted at the workspace itself (#11482). */
  worktreeId?: string;
  /**
   * Absolute root the listings were captured under. Identity only — never
   * joined against, so it can't strand a panel the way a persisted absolute
   * *root* would; a mismatch (a relocated project) just cold-starts, which is
   * the same self-healing outcome as a worktree switch.
   */
  basePath?: string;
  /** Browse root relative to the base at capture time; "" = the base itself. */
  rootPath: string;
  listings: FileBrowserTreeSnapshotEntry[];
}

/** What a file browser orders directory entries by (#11620). */
export type FileBrowserSortKey = "name" | "modified" | "size" | "type";
export type FileBrowserSortDirection = "asc" | "desc";
