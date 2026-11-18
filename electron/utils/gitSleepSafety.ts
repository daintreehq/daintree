import { lstat, readdir, readFile, realpath, stat } from "fs/promises";
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

/** How many submodule directories one probe will walk before giving up as unknown. */
const MAX_MODULE_DIRS = 256;

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** Nothing at all at `target`, as opposed to a symlink whose target is missing. */
async function isAbsent(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return false;
  } catch (error) {
    if (isMissing(error)) return true;
    throw error;
  }
}

/**
 * A path a git pointer file names, resolved as git resolves it: from `base`,
 * following each symlink before any `..` after it rather than collapsing `..`
 * lexically first.
 */
function resolvePointer(base: string, target: string): Promise<string> {
  return realpath(path.isAbsolute(target) ? target : `${base}${path.sep}${target}`);
}

/**
 * A checkout's own git directory, read without spawning git, or undefined when
 * the checkout has no `.git` and the caller knows it isn't a repository. A main
 * checkout has a `.git` directory; a linked worktree has a `.git` *file* naming
 * its directory under the main repo's `.git/worktrees/<name>`, which is where
 * that worktree's MERGE_HEAD, rebase state and index lock live. Paths are
 * canonical, so checkouts reached through different symlinks agree on their
 * repository, and a relative `gitdir:` resolves from the checkout's physical
 * location, as git resolves it.
 */
async function resolveGitDir(
  checkoutPath: string,
  missingRepoIsClear: boolean
): Promise<string | undefined> {
  const dotGit = path.join(checkoutPath, ".git");
  const info = await stat(dotGit).catch(async (error: unknown) => {
    if (missingRepoIsClear && isMissing(error) && (await isAbsent(dotGit))) return undefined;
    throw error;
  });
  if (!info) return undefined;
  if (info.isDirectory()) return realpath(dotGit);
  if (!info.isFile()) throw new Error(".git is neither a directory nor a file");
  const content = await readFile(dotGit, "utf8");
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(content);
  if (!match) throw new Error("malformed .git file");
  return resolvePointer(await realpath(checkoutPath), match[1]);
}

/** The repository's shared directory: a linked worktree's `commondir`, else the git dir itself. */
async function resolveCommonDir(gitDir: string): Promise<string> {
  let content: string;
  try {
    content = await readFile(path.join(gitDir, "commondir"), "utf8");
  } catch (error) {
    if (isMissing(error)) return gitDir;
    throw error;
  }
  return resolvePointer(gitDir, content.trim());
}

async function subdirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

interface Walk {
  /** Submodule directories this probe may still visit. */
  left: number;
  /** Common directories already walked, so a repository is walked and charged once per probe. */
  walked: Set<string>;
}

/**
 * A repository's own git directory plus every git directory nested under it:
 * one per linked worktree (`worktrees/<name>`) and one per absorbed submodule
 * (`modules/<path>`, whose name can itself span directories, and which can
 * have worktrees and submodules of its own). A submodule initialized from a
 * linked worktree lives under that worktree's own `modules/`. Empty when this
 * probe already walked the repository from another of its checkouts.
 */
async function nestedGitDirs(commonDir: string, walk: Walk): Promise<string[]> {
  if (walk.walked.has(commonDir)) return [];
  walk.walked.add(commonDir);
  const dirs = [commonDir, ...(await subdirectories(path.join(commonDir, "worktrees")))];
  const pending: string[] = [];
  for (const dir of dirs) pending.push(...(await subdirectories(path.join(dir, "modules"))));
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    if (--walk.left < 0) throw new Error("too many submodule directories");
    let isGitDir = false;
    try {
      isGitDir = (await stat(path.join(dir, "HEAD"))).isFile();
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (isGitDir) dirs.push(...(await nestedGitDirs(dir, walk)));
    else pending.push(...(await subdirectories(dir)));
  }
  return dirs;
}

/**
 * Every git directory of the repositories these checkouts belong to, read from
 * disk rather than from any cached worktree list, so a worktree created outside
 * Daintree, or a submodule paused mid-rebase, is covered too. Each checkout's
 * own git directory is kept even when its repository was already walked.
 */
async function probe(
  checkoutPaths: readonly string[],
  missingRepoIsClear: boolean
): Promise<GitSleepSafety> {
  const gitDirs = new Set<string>();
  const walk: Walk = { left: MAX_MODULE_DIRS, walked: new Set() };
  for (const checkoutPath of checkoutPaths) {
    const gitDir = await resolveGitDir(checkoutPath, missingRepoIsClear);
    if (gitDir === undefined) continue;
    gitDirs.add(gitDir);
    for (const dir of await nestedGitDirs(await resolveCommonDir(gitDir), walk)) gitDirs.add(dir);
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
