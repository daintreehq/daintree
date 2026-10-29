/**
 * What the two file-row mutations (`git.discardFileChanges`, `file.trash`)
 * would do to one file right now, read before the confirm asks (#15122). The
 * discard preview comes from the same plan the discard runs, so the confirm
 * describes the operation rather than the row's status, which can be stale and
 * can't see a rename's source or a staged-versus-unstaged split.
 */

/** Lines git counts for one side of a change; `binary` when it can't count them. */
export type FileChurn = { insertions: number; deletions: number } | "binary";

/** One side of a change: its line counts and its patch, capped. */
export interface FileChangeSide {
  churn: FileChurn;
  /** Unified diff text with a little context; empty for a binary change. */
  patch: string;
  /** The patch was cut at the preview cap. */
  truncated: boolean;
}

/**
 * - `lose`: a version git can't give back goes for good (a modification, or a
 *   staged copy that differs from the one on disk).
 * - `trash`: nothing is lost for good; the file on disk moves to the OS Trash
 *   (a new file, a rename's or copy's new name).
 * - `restore`: nothing is lost; a deleted file comes back from the last commit.
 */
export type DiscardOutcome = "lose" | "trash" | "restore";

export interface FileDiscardPreview {
  kind: "discard";
  /** The path git reports for the change, as git names it (a rename's new name). */
  path: string;
  /** A rename's old name, which discarding brings back from the last commit. */
  renamedFrom: string | null;
  /** A copy's source, which discarding leaves as it is. */
  copiedFrom: string | null;
  /** The last commit has `path`, so discarding restores it rather than trashing it. */
  inLastCommit: boolean;
  outcome: DiscardOutcome;
  /** The last commit against the index; null when nothing is staged. */
  staged: FileChangeSide | null;
  /** The index against the working tree; null when nothing is unstaged. */
  unstaged: FileChangeSide | null;
  /**
   * A file git has never seen, standing where a staged deletion took the
   * committed one: restoring writes over it, and it is lost.
   */
  overwrites: FileTextSample | null;
  /**
   * The versions this preview read, fingerprinted. Passed back with the
   * discard, which refuses if the file has changed since.
   */
  token: string;
}

/** A file's size, and for a text file its line count and first lines. */
export interface FileTextSample {
  bytes: number;
  /** The file has NUL bytes in its first block, so it has no line preview. */
  binary: boolean;
  /** Null for a binary file or one too large to count. */
  lines: number | null;
  /** The first lines; null when not wanted or when the file is binary. */
  excerpt: string | null;
  excerptTruncated: boolean;
}

export interface FileTrashPreview extends FileTextSample {
  kind: "trash";
  path: string;
  /** The last commit has a copy, which git can bring back. */
  inLastCommit: boolean;
  /** The index has a copy (a staged version stays staged after the trash). */
  inIndex: boolean;
  /** Neither has a copy and git ignores the path. */
  ignored: boolean;
  /** The last commit against the index; null when nothing is staged or not indexed. */
  staged: FileChurn | null;
  /** The index against the working tree; null when nothing is unstaged or not indexed. */
  unstaged: FileChurn | null;
}

export type FileMutationPreview = FileDiscardPreview | FileTrashPreview;
