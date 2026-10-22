import { readdir, readFile, stat } from "fs/promises";
import path from "path";
import { OPERATION_SENTINEL_NAMES } from "./gitRepoOperationState.js";

/**
 * `clear` only when the per-worktree git directory was read and holds no
 * in-progress operation; `busy` names what was found; `unknown` is every
 * failure to look.
 */
export type GitSleepSafety =
  { state: "clear" } | { state: "busy"; marker: string } | { state: "unknown"; reason: string };

/**
 * A held index lock means some git process is mid-write in this worktree. The
 * polling probe leaves it out as too transient to steer a poll, but it is
 * exactly what a teardown that is about to kill that worktree's shells must
 * wait out.
 */
const SLEEP_BLOCKING_MARKERS = [...OPERATION_SENTINEL_NAMES, "index.lock"] as const;

const DEFAULT_TIMEOUT_MS = 2_000;

/**
 * Resolve a worktree's own git directory without spawning git. A main checkout
 * has a `.git` directory; a linked worktree has a `.git` *file* naming its
 * directory under the main repo's `.git/worktrees/<name>`, which is where that
 * worktree's MERGE_HEAD, rebase state and index lock live.
 */
async function resolveWorktreeGitDir(worktreePath: string): Promise<string> {
  const dotGit = path.join(worktreePath, ".git");
  const info = await stat(dotGit);
  if (info.isDirectory()) return dotGit;
  if (!info.isFile()) throw new Error(".git is neither a directory nor a file");
  const content = await readFile(dotGit, "utf8");
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(content);
  if (!match) throw new Error("malformed .git file");
  return path.resolve(worktreePath, match[1]);
}

async function probe(worktreePath: string): Promise<GitSleepSafety> {
  const gitDir = await resolveWorktreeGitDir(worktreePath);
  const entries = new Set(await readdir(gitDir));
  const marker = SLEEP_BLOCKING_MARKERS.find((name) => entries.has(name));
  return marker ? { state: "busy", marker } : { state: "clear" };
}

/**
 * Whether a worktree is safe to put to sleep as far as git is concerned.
 *
 * The fail-closed twin of `getRepoOperationState`: that probe answers
 * "nothing in progress" on any read error so a status poll never stalls, and
 * reads only the directory it is handed. Here a wrong "clear" kills the shell a
 * rebase is waiting in, so an unreadable `.git`, a malformed `gitdir:` file or
 * a stalled mount all come back `unknown`.
 */
export async function probeGitSleepSafety(
  worktreePath: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<GitSleepSafety> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<GitSleepSafety>((resolve) => {
    timer = setTimeout(() => resolve({ state: "unknown", reason: "timeout" }), timeoutMs);
  });
  try {
    return await Promise.race([
      probe(worktreePath).catch((error: unknown): GitSleepSafety => ({
        state: "unknown",
        reason: (error as NodeJS.ErrnoException)?.code ?? "read-failed",
      })),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
