import { runGitForBytes } from "./git/reviewPoint/runGit.js";
import { diffCodeNames } from "./voiceCodeNames.js";

// A branch's whole diff, read once per dictation; one past this is too big to
// say much about what the speaker is on right now.
const MAX_DIFF_BYTES = 2_000_000;
// Dictations come in runs; one read serves the worktree's next minute of them.
const DIFF_NAMES_FRESH_MS = 60_000;

const recent = new Map<string, { at: number; names: Promise<string[]> }>();

async function readDiff(cwd: string, deadline: number): Promise<string[]> {
  const left = () => Math.max(1, deadline - Date.now());
  const run = async (args: string[]) =>
    (await runGitForBytes(cwd, args, { timeoutMs: left(), maxStdoutBytes: MAX_DIFF_BYTES })).stdout
      .toString("utf8")
      .trim();
  const base = await run(["merge-base", "HEAD", "origin/HEAD"]);
  if (!base) return [];
  // Tree to tree: the working tree is never read, so no filter, textconv or
  // fsmonitor the repository configures runs. Committed work only. Submodules
  // are ignored, since an inline submodule diff runs a nested git diff that
  // keeps neither of the flags above.
  const diff = await run([
    "diff",
    "-U0",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--ignore-submodules=all",
    "--submodule=short",
    `${base}..HEAD`,
    "--",
  ]);
  return diffCodeNames(diff);
}

/**
 * The code names a worktree's branch is working on (`diffCodeNames`): its
 * commits since it left the remote's default branch, through the hardened git
 * runner. Shared by the worktree's dictations for a minute. None on any
 * failure, none past `timeoutMs`, whatever git is still doing.
 */
export function readWorktreeDiffNames(cwd: string, timeoutMs = 800): Promise<string[]> {
  const now = Date.now();
  const cached = recent.get(cwd);
  if (cached && now - cached.at < DIFF_NAMES_FRESH_MS) return cached.names;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const names = Promise.race([
    readDiff(cwd, now + timeoutMs).catch((): string[] => []),
    new Promise<string[]>((resolve) => {
      timer = setTimeout(() => resolve([]), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
  recent.set(cwd, { at: now, names });
  for (const [key, entry] of recent) {
    if (now - entry.at >= DIFF_NAMES_FRESH_MS) recent.delete(key);
  }
  return names;
}

/** Forgets every cached read, for tests. */
export function resetWorktreeDiffNamesForTests(): void {
  recent.clear();
}
