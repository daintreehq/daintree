import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { pathComparisonKey } from "../../../shared/utils/path.js";
import { parseIndexListing, parsePorcelainV2 } from "../git/reviewPoint/parseGitRecords.js";
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
   * Tracked files status never checks: marked assume-unchanged, or
   * skip-worktree while present in the working tree. A sparse checkout's
   * absent skip-worktree files are not counted; there is nothing there to lose.
   */
  hiddenFromStatus: number;
  /**
   * Commits reachable from {@link headOid} that no remote-tracking ref in this
   * repository holds, as of its last fetch: nothing is fetched to ask. Null
   * when there is no commit to ask about.
   */
  unpushedCommits: number | null;
}

const READ_TIMEOUT_MS = 15_000;
const STATUS_MAX_BYTES = 8 * 1024 * 1024;
const INDEX_MAX_BYTES = 64 * 1024 * 1024;
const SMALL_MAX_BYTES = 64 * 1024;
const LSTAT_BATCH = 64;

async function exists(target: Buffer): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

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
  const options = (maxStdoutBytes: number) => ({
    signal,
    timeoutMs: READ_TIMEOUT_MS,
    maxStdoutBytes,
  });
  const top = await runGitForBytes(
    worktreePath,
    ["rev-parse", "--show-toplevel"],
    options(SMALL_MAX_BYTES)
  );
  const compare = { caseInsensitive: process.platform === "win32" };
  const [foundTop, ownTop] = await Promise.all([
    // Only git's own line ending comes off: a directory name may end in a space.
    realpath(top.stdout.toString("utf8").replace(/\r?\n$/, "")),
    realpath(worktreePath),
  ]);
  if (pathComparisonKey(foundTop, compare) !== pathComparisonKey(ownTop, compare)) {
    throw new Error("git answered for a repository other than the worktree's own");
  }

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
    options(STATUS_MAX_BYTES)
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

  // `-v` tags a lowercase letter for assume-unchanged and `S` for
  // skip-worktree: status takes both on trust, so edits there are invisible.
  const listing = await runGitForBytes(
    worktreePath,
    ["ls-files", "-s", "-v", "-z"],
    options(INDEX_MAX_BYTES)
  );
  let hiddenFromStatus = 0;
  const skipped: Buffer[] = [];
  for (const record of parseIndexListing(listing.stdout)) {
    if (/^[a-z]$/.test(record.tag)) hiddenFromStatus++;
    else if (record.tag === "S") skipped.push(record.path);
  }
  const root = Buffer.from(ownTop + path.sep);
  for (let start = 0; start < skipped.length; start += LSTAT_BATCH) {
    signal?.throwIfAborted();
    const batch = skipped.slice(start, start + LSTAT_BATCH);
    const present = await Promise.all(batch.map((entry) => exists(Buffer.concat([root, entry]))));
    hiddenFromStatus += present.filter(Boolean).length;
  }

  let unpushedCommits: number | null = null;
  if (status.headOid !== null) {
    const counted = await runGitForBytes(
      worktreePath,
      ["rev-list", "--count", status.headOid, "--not", "--remotes", "--"],
      options(SMALL_MAX_BYTES)
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
    hiddenFromStatus,
    unpushedCommits,
  };
}
