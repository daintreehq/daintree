import { disableFilters, filterDriversIn } from "./git/reviewPoint/filterDrivers.js";
import {
  GitCommandError,
  GitTimeoutError,
  runGitForBytes,
  type RunGitOptions,
} from "./git/reviewPoint/runGit.js";
import { diffCodeNames } from "./voiceCodeNames.js";

// A branch's whole diff, read once per dictation; one past this is too big to
// say much about what the speaker is on right now.
const MAX_DIFF_BYTES = 2_000_000;

async function readDiff(cwd: string, deadline: number): Promise<string[]> {
  const git = (args: string[], extra: Partial<RunGitOptions> = {}) => {
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) return Promise.reject(new GitTimeoutError(args[0] ?? ""));
    return runGitForBytes(cwd, args, { timeoutMs, maxStdoutBytes: MAX_DIFF_BYTES, ...extra });
  };
  const [config, mergeBase] = await Promise.all([
    git(["config", "-z", "--list"], { okExitCodes: [1] }),
    git(["merge-base", "HEAD", "origin/HEAD"]).then(
      ({ stdout }) => stdout.toString("utf8").trim(),
      // With no default branch to have left (or no history shared with it),
      // the branch starts at its last commit, and only its uncommitted work
      // counts. A read that ran out of time ends here instead.
      (error: unknown) => {
        if (error instanceof GitCommandError) return "";
        throw error;
      }
    ),
  ]);
  const base = mergeBase || "HEAD";
  // The base's tree against the working tree, for every path in the index:
  // committed work and uncommitted work, staged or not, but no untracked file.
  // No program the repository configures runs: every clean and process filter
  // is switched off for the command (a stat-dirty file is hashed through its
  // clean filter), and plumbing runs no textconv or external diff (the flags
  // say so anyway). The hardened profile turns fsmonitor off and points hooks
  // at an app-owned directory. Submodules are never entered: checking one for
  // changes runs status inside it, with its own filters on.
  const { stdout } = await git(
    [
      "diff-index",
      "-p",
      "-U0",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--ignore-submodules=all",
      "--submodule=short",
      base,
      "--",
    ],
    { config: disableFilters(filterDriversIn(config.stdout)) }
  );
  return diffCodeNames(stdout.toString("utf8"));
}

/**
 * The code names a worktree's branch is working on (`diffCodeNames`): what its
 * working tree holds now against where it left the remote's default branch,
 * uncommitted work included, through the hardened git runner. Read fresh for
 * each dictation, since an agent's latest edit is the likeliest thing said.
 * None on any failure, none past `timeoutMs`, whatever git is still doing.
 */
export function readWorktreeDiffNames(cwd: string, timeoutMs = 800): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    readDiff(cwd, Date.now() + timeoutMs).catch((): string[] => []),
    new Promise<string[]>((resolve) => {
      timer = setTimeout(() => resolve([]), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}
