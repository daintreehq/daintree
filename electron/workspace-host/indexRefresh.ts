import { createHardenedGit, createWslHardenedGit } from "../utils/hardenedGit.js";
import type { WslGitInvocation } from "../utils/hardenedGit.js";

/**
 * How long after `git worktree add` the refresh waits. The rewritten index must
 * carry a timestamp later than every file the checkout wrote, or git treats the
 * entries as racily clean again; this clears filesystems with 2 s timestamps.
 */
export const INDEX_REFRESH_DELAY_MS = 2_500;

/**
 * Rewrite a fresh worktree's index once so status stops re-hashing it (#16679).
 *
 * The checkout writes the files and the index within the same timestamp, so
 * every status re-reads file contents until something rewrites the index, and
 * Daintree's own status runs with `GIT_OPTIONAL_LOCKS=0`, which never does.
 * `update-index` takes the index lock as a mandatory lock, so it writes under
 * the same environment. `--refresh` with no paths only updates cached stat
 * data: nothing is staged, unstaged, or added.
 *
 * No `-q`: it also silences a held `index.lock` (exit 128 with no output), and
 * simple-git only rejects a non-zero exit that wrote to stderr. Without it a
 * held lock is a `fatal:` on stderr and rejects, while "needs update" and
 * "needs merge" go to stdout with exit 1 and resolve, the index written anyway.
 */
export async function refreshWorktreeIndex(
  worktreePath: string,
  wsl: WslGitInvocation | undefined,
  mayStart: () => boolean
): Promise<void> {
  // No abort signal: this git holds `index.lock`, and a stopped git that has
  // not exited within the kill grace is SIGKILLed, which leaves the lock behind
  // for the agent's next commit. Only the block timeout can stop it.
  const git = wsl ? await createWslHardenedGit(wsl) : await createHardenedGit(worktreePath);
  // Asked again after the factory's await, which a stop can land inside.
  if (!mayStart()) return;
  await git.raw(["update-index", "--ignore-submodules", "--refresh"]);
}
