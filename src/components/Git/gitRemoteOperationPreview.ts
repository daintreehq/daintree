/**
 * Canonical fresh preview for the push / pull-rebase confirm surfaces (#11538).
 *
 * `git.push` (D2) and `git.pullRebase` (D1) each confirm on two different
 * surfaces depending on dispatch source: the local deferred-Promise dialogs for
 * palette/keybinding/user dispatch, and the MCP confirm modal for agent
 * dispatch. Both must preview the SAME actual content — the target branch and
 * the local commits — or the safeguard silently weakens depending on who asked.
 * This module owns the one fresh fetch and the plain-line formatter the MCP
 * surface renders, so the two can't drift apart.
 */

/** Max commits fetched and shown before the tail is collapsed. */
export const PREVIEW_COMMIT_LIMIT = 12;

const SHORT_HASH_LEN = 7;

export interface GitPreviewCommit {
  hash: string;
  message: string;
  author: string;
}

export interface GitRemoteOperationPreview {
  /** `null` for a detached HEAD — `getStagingStatus` reports no current branch. */
  branch: string | null;
  commits: GitPreviewCommit[];
}

/**
 * Fetch the branch and recent local commits for `cwd`, fresh at call time.
 *
 * Deliberately un-cached: the preview must describe the repository state at the
 * moment the human is asked to approve, not a snapshot taken earlier (#8725).
 * Rejects if either read fails — callers decide how to surface that (the local
 * dialogs show a retryable error and keep confirm disabled; the MCP surface
 * shows a "couldn't verify" note).
 */
export async function buildGitRemoteOperationPreview(
  cwd: string
): Promise<GitRemoteOperationPreview> {
  const [status, commitList] = await Promise.all([
    window.electron.git.getStagingStatus(cwd),
    window.electron.git.listCommits({ cwd, limit: PREVIEW_COMMIT_LIMIT }),
  ]);
  return {
    branch: status.currentBranch,
    commits: commitList.items.map((c) => ({
      hash: c.hash,
      message: c.message,
      author: c.author.name,
    })),
  };
}

/**
 * Render a preview as plain lines for the MCP confirm surface, so an approver
 * sees the real branch and commits rather than raw `{cwd, setUpstream}` args
 * (the D2 "preview of actual content" rule).
 *
 * `null` means the fresh fetch could not be verified: surface that explicitly
 * rather than an empty list, which would imply "nothing to push". An empty
 * `commits` array IS a valid loaded state and gets `emptyNote`, never a warning.
 */
export function formatGitRemoteOperationPreviewLines(
  preview: GitRemoteOperationPreview | null,
  emptyNote: string
): string[] {
  if (preview === null) {
    return ["⚠ Could not verify the branch and local commits — proceed with caution."];
  }
  const branchLine = `Branch: ${preview.branch ?? "(detached HEAD)"}`;
  if (preview.commits.length === 0) {
    return [branchLine, emptyNote];
  }
  return [
    branchLine,
    ...preview.commits.map(
      (c) => `  ${c.hash.slice(0, SHORT_HASH_LEN)} ${c.message} — ${c.author}`
    ),
  ];
}
