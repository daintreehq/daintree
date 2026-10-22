import { readdir, readFile, stat } from "fs/promises";
import path from "path";
import { OPERATION_SENTINEL_NAMES } from "./gitRepoOperationState.js";

/**
 * `clear` only when every git directory of the repository was read and none
 * holds an in-progress operation; `busy` names what was found; `unknown` is
 * every failure to look.
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

const DEFAULT_TIMEOUT_MS = 5_000;

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/**
 * A checkout's own git directory, read without spawning git. A main checkout
 * has a `.git` directory; a linked worktree has a `.git` *file* naming its
 * directory under the main repo's `.git/worktrees/<name>`, which is where that
 * worktree's MERGE_HEAD, rebase state and index lock live.
 */
async function resolveGitDir(checkoutPath: string): Promise<string> {
  const dotGit = path.join(checkoutPath, ".git");
  const info = await stat(dotGit);
  if (info.isDirectory()) return dotGit;
  if (!info.isFile()) throw new Error(".git is neither a directory nor a file");
  const content = await readFile(dotGit, "utf8");
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(content);
  if (!match) throw new Error("malformed .git file");
  return path.resolve(checkoutPath, match[1]);
}

/** The repository's shared directory: a linked worktree's `commondir`, else the git dir itself. */
async function resolveCommonDir(gitDir: string): Promise<string> {
  try {
    const content = await readFile(path.join(gitDir, "commondir"), "utf8");
    return path.resolve(gitDir, content.trim());
  } catch (error) {
    if (isMissing(error)) return gitDir;
    throw error;
  }
}

/**
 * Every git directory of the repository a checkout belongs to: the main one
 * and one per linked worktree, read from disk rather than from any cached
 * worktree list, so a worktree created outside Daintree is covered too.
 */
async function repositoryGitDirs(checkoutPath: string): Promise<string[]> {
  const gitDir = await resolveGitDir(checkoutPath);
  const commonDir = await resolveCommonDir(gitDir);
  const dirs = [gitDir, commonDir];
  try {
    const linked = await readdir(path.join(commonDir, "worktrees"), { withFileTypes: true });
    for (const entry of linked) {
      if (entry.isDirectory()) dirs.push(path.join(commonDir, "worktrees", entry.name));
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  return dirs;
}

async function probe(
  checkoutPaths: readonly string[],
  missingRepoIsClear: boolean
): Promise<GitSleepSafety> {
  const gitDirs = new Set<string>();
  for (const checkoutPath of checkoutPaths) {
    try {
      for (const dir of await repositoryGitDirs(checkoutPath)) gitDirs.add(dir);
    } catch (error) {
      if (missingRepoIsClear && isMissing(error)) continue;
      throw error;
    }
  }
  for (const gitDir of gitDirs) {
    const entries = new Set(await readdir(gitDir));
    const marker = SLEEP_BLOCKING_MARKERS.find((name) => entries.has(name));
    if (marker) return { state: "busy", marker };
  }
  return { state: "clear" };
}

/**
 * Whether the repositories behind these checkouts are safe to put to sleep as
 * far as git is concerned.
 *
 * The fail-closed twin of `getRepoOperationState`: that probe answers
 * "nothing in progress" on any read error so a status poll never stalls, and
 * reads only the directory it is handed. Here a wrong "clear" kills the shell a
 * rebase is waiting in, so an unreadable `.git`, a malformed `gitdir:` file or
 * a stalled mount all come back `unknown`. A checkout with no `.git` at all is
 * `unknown` too, unless the caller already knows the folder isn't a repository.
 */
export async function probeRepositorySleepSafety(
  checkoutPaths: readonly string[],
  options: { missingRepoIsClear?: boolean; timeoutMs?: number } = {}
): Promise<GitSleepSafety> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<GitSleepSafety>((resolve) => {
    timer = setTimeout(
      () => resolve({ state: "unknown", reason: "timeout" }),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );
  });
  try {
    return await Promise.race([
      probe(checkoutPaths, options.missingRepoIsClear === true).catch(
        (error: unknown): GitSleepSafety => ({
          state: "unknown",
          reason: (error as NodeJS.ErrnoException)?.code ?? "read-failed",
        })
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
