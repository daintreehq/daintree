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
  /** Worktree whose root the listing is resolved against */
  worktreeId: string;
  /** Worktree-relative directory to list; absent or "" lists the root */
  dirPath?: string;
  /** Include gitignored entries, each flagged `isIgnored`, instead of dropping them */
  includeIgnored?: boolean;
}

/** Entries of one directory, directories first then case-insensitive by name. */
export type FileBrowserListDirectoryResult = FileTreeNode[];
