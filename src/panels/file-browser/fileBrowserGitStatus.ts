import type { GitStatus } from "@shared/types/git";
import { isAbsolute } from "@shared/utils/path";

/**
 * Worst-first order for the single marker a folder row can carry.
 *
 * Deliberately not `workingTreeDiff`'s `STATUS_PRIORITY`, which is a tie-break
 * for a churn sort and ranks `conflicted` *last*. A folder badge answers "how
 * much does what's inside here want my attention", so a conflict — which blocks
 * the branch outright — has to come first, a deletion next (the content is gone,
 * not merely edited), and gitignored noise last.
 */
const FOLDER_STATUS_SEVERITY: Record<GitStatus, number> = {
  conflicted: 0,
  deleted: 1,
  modified: 2,
  added: 3,
  renamed: 4,
  copied: 5,
  untracked: 6,
  ignored: 7,
};

export interface FileBrowserGitStatusIndex {
  /** Status of each changed file, keyed by its worktree-relative path. */
  readonly fileStatus: ReadonlyMap<string, GitStatus>;
  /**
   * Worst status anywhere below a directory, keyed by its worktree-relative
   * path. This is what lets a collapsed folder say "something in here changed"
   * without its children ever having been listed.
   */
  readonly folderStatus: ReadonlyMap<string, GitStatus>;
}

/** The shape this module needs off a change; anything wider is the caller's. */
interface IndexableChange {
  relativePath: string;
  status: GitStatus;
}

/**
 * Two flat maps rather than a trie: nothing here enumerates a prefix, it only
 * ever asks "what is the status at exactly this path", so the extra structure
 * would buy nothing and cost a walk per lookup.
 *
 * Built from the changed files alone — dozens to hundreds of entries — never
 * from the tree's lazily-loaded listings, which run to tens of thousands of
 * nodes on a real repository. Construction is linear in total path segments and
 * every lookup is O(1).
 */
export function buildFileBrowserGitStatusIndex(
  changes: readonly IndexableChange[]
): FileBrowserGitStatusIndex {
  const fileStatus = new Map<string, GitStatus>();
  const folderStatus = new Map<string, GitStatus>();

  for (const change of changes) {
    const path = change.relativePath;
    if (path === "") continue;
    // The same path can arrive twice (staged and unstaged are separate rows),
    // so keep the more urgent of the two rather than whichever landed last.
    mergeWorst(fileStatus, path, change.status);

    let cut = path.lastIndexOf("/");
    while (cut > 0) {
      mergeWorst(folderStatus, path.slice(0, cut), change.status);
      cut = path.lastIndexOf("/", cut - 1);
    }
  }

  return { fileStatus, folderStatus };
}

function mergeWorst(target: Map<string, GitStatus>, key: string, status: GitStatus): void {
  const existing = target.get(key);
  if (existing === undefined || severityOf(status) < severityOf(existing)) {
    target.set(key, status);
  }
}

function severityOf(status: GitStatus): number {
  // Same IPC-boundary defence as the presentation table: an unrecognised status
  // sorts last rather than ranking itself above a real conflict.
  return FOLDER_STATUS_SEVERITY[status] ?? Number.MAX_SAFE_INTEGER;
}

/** The marker for one tree row, or undefined when nothing under it changed. */
export function getFileBrowserRowGitStatus(
  index: FileBrowserGitStatusIndex | null | undefined,
  path: string,
  isDirectory: boolean
): GitStatus | undefined {
  if (!index) return undefined;
  return isDirectory ? index.folderStatus.get(path) : index.fileStatus.get(path);
}

/**
 * Is this the worktree-relative shape the tree rows and the viewer both join
 * on? `buildWorkingTreeDiffModel` returns the *untouched absolute path* when its
 * root strip misses, so an unfiltered model can carry entries that would never
 * match a row — and persisting one as the selection would aim the viewer at a
 * path outside the worktree it is scoped to.
 */
export function isReadableRelativePath(path: string): boolean {
  if (path === "" || isAbsolute(path)) return false;
  return !path.split("/").includes("..");
}
