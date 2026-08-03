import type { FileTreeNode } from "./copyTree.js";

/**
 * One `listDirectory` request from the read-only file browser panel.
 *
 * Deliberately its own channel rather than a reuse of `copytree:get-file-tree`:
 * that channel is rate-limited to 5 calls per 10 seconds, which suits the
 * occasional copy-tree file picker but not a lazily-expanding tree, where every
 * folder the user opens — and every refresh after an agent writes files — is
 * another call.
 */
export interface FileBrowserListDirectoryPayload {
  /**
   * Worktree whose root the listing is resolved against. Absent means "this
   * sender's own workspace root" — the project or scratch folder its view is
   * bound to (#11482). No absolute root is ever named by the renderer: main
   * derives it from the trusted `ctx.projectId` binding, so a scratch or
   * worktree-less project is reachable without widening what a renderer can
   * ask for.
   */
  worktreeId?: string;
  /** Directory to list, relative to the resolved root; absent or "" lists the root */
  dirPath?: string;
}

/** Entries of one directory, directories first then case-insensitive by name. */
export type FileBrowserListDirectoryResult = FileTreeNode[];

/**
 * Validate a batch of path-like tokens spotted in terminal output. The
 * terminal's directory-link detection is syntactic and would happily linkify
 * `and/or`; only tokens that stat to a real entry inside the worktree become
 * links, so the check has to be cheap and batched (one call per hovered line).
 */
export interface FileBrowserStatPathsPayload {
  /** Worktree whose root the paths are resolved against; absent = the sender's workspace root */
  worktreeId?: string;
  /** Candidate paths relative to the resolved root, at most 32 per call */
  paths: string[];
}

/** One entry per requested path, in order; null = missing or unreadable. */
export type FileBrowserStatPathsResult = ("file" | "directory" | null)[];
