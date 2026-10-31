import { parsePorcelainV2 } from "../git/reviewPoint/parseGitRecords.js";
import { runGitForBytes } from "../git/reviewPoint/runGit.js";

/**
 * What git reported of a worktree about to be retired (#15737): whether
 * anything in it is uncommitted, and whether its commits are on a remote.
 * Observations only; the refusal built from them is the caller's.
 */
export interface WorktreeGitObservation {
  /** The commit HEAD named, or null on a branch with no commit yet. */
  headOid: string | null;
  /** The branch checked out, or null when HEAD is detached. */
  branch: string | null;
  staged: number;
  unstaged: number;
  /** Untracked entries, a directory with nothing tracked in it counted once. */
  untracked: number;
  conflicted: number;
  /**
   * Commits reachable from {@link headOid} that no remote-tracking ref in this
   * repository holds, as of its last fetch: nothing is fetched to ask. Null
   * when there is no commit to ask about.
   */
  unpushedCommits: number | null;
}

const STATUS_TIMEOUT_MS = 15_000;
const STATUS_MAX_BYTES = 8 * 1024 * 1024;
const COUNT_TIMEOUT_MS = 15_000;
const COUNT_MAX_BYTES = 64;

/**
 * Read a worktree's status and how many of its commits no remote holds.
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
  const { stdout } = await runGitForBytes(
    worktreePath,
    [
      "status",
      "--porcelain=v2",
      "-z",
      "--branch",
      "--no-renames",
      "--untracked-files=normal",
      "--ignore-submodules=none",
    ],
    { signal, timeoutMs: STATUS_TIMEOUT_MS, maxStdoutBytes: STATUS_MAX_BYTES }
  );
  const status = parsePorcelainV2(stdout);
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  let conflicted = 0;
  for (const record of status.records) {
    if (record.kind === "untracked") untracked++;
    else if (record.kind === "unmerged") conflicted++;
    else {
      if (record.xy[0] !== ".") staged++;
      if (record.xy[1] !== ".") unstaged++;
    }
  }
  let unpushedCommits: number | null = null;
  if (status.headOid !== null) {
    const counted = await runGitForBytes(
      worktreePath,
      ["rev-list", "--count", status.headOid, "--not", "--remotes", "--"],
      { signal, timeoutMs: COUNT_TIMEOUT_MS, maxStdoutBytes: COUNT_MAX_BYTES }
    );
    const text = counted.stdout.toString("utf8").trim();
    if (!/^\d+$/.test(text)) throw new Error("git rev-list --count gave no count");
    unpushedCommits = Number.parseInt(text, 10);
  }
  return {
    headOid: status.headOid,
    branch: status.headBranch,
    staged,
    unstaged,
    untracked,
    conflicted,
    unpushedCommits,
  };
}
