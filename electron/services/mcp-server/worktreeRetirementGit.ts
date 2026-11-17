import { runGitForBytes } from "../git/reviewPoint/runGit.js";
import {
  readWorktreeStatusObservation,
  WORKTREE_STATUS_READ_TIMEOUT_MS,
  type WorktreeStatusObservation,
} from "../git/worktreeStatusObservation.js";

/**
 * What git reported of a worktree about to be retired (#15737): whether
 * anything in it is uncommitted, and whether its commits are on a remote.
 * Observations only; the refusal built from them is the caller's.
 */
export interface WorktreeGitObservation extends WorktreeStatusObservation {
  /**
   * Commits reachable from {@link headOid} that no remote-tracking ref in this
   * repository holds, as of its last fetch: nothing is fetched to ask. Null
   * when there is no commit to ask about.
   */
  unpushedCommits: number | null;
}

const SMALL_MAX_BYTES = 64 * 1024;

/**
 * Read a worktree's status and how many of its commits no remote holds.
 *
 * Git is asked from the worktree's own directory, and the answer counts only
 * if that directory is the top of the repository git found: a linked worktree
 * that lost its `.git` file would otherwise be read as whatever repository
 * contains it.
 *
 * "Pushed" is asked of every remote-tracking ref rather than the branch's
 * upstream: Daintree creates topic branches `--no-track`, so a branch pushed
 * under its own name has no upstream, and one with no commits past a base that
 * is already on the remote has nothing to push at all. Asked of the commit the
 * status read named, so a HEAD that moves between the two reads is never
 * counted against the wrong commit.
 *
 * Submodules are inspected whatever the repository's ignore settings say, and
 * untracked directories are reported whole so a large one cannot overflow the
 * read. Rejects on any failure, an unrecognised record or an output limit, so
 * nothing unreadable is ever reported as clean.
 */
export async function readWorktreeGitObservation(
  worktreePath: string,
  signal?: AbortSignal
): Promise<WorktreeGitObservation> {
  const status = await readWorktreeStatusObservation(worktreePath, signal);
  let unpushedCommits: number | null = null;
  if (status.headOid !== null) {
    const counted = await runGitForBytes(
      worktreePath,
      ["rev-list", "--count", status.headOid, "--not", "--remotes", "--"],
      { signal, timeoutMs: WORKTREE_STATUS_READ_TIMEOUT_MS, maxStdoutBytes: SMALL_MAX_BYTES }
    );
    const text = counted.stdout.toString("utf8").trim();
    if (!/^\d+$/.test(text)) throw new Error("git rev-list --count gave no count");
    unpushedCommits = Number.parseInt(text, 10);
  }
  return { ...status, unpushedCommits };
}
