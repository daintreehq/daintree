import { stat } from "node:fs/promises";
import path from "node:path";

/**
 * Re-read at least this often even when the config stamp holds still: a remote
 * can also arrive through `config.worktree`, an `[include]`d file or the
 * global config, none of which moves the repo's own `config`.
 */
const INVENTORY_MAX_AGE_MS = 5 * 60_000;

interface CachedInventory {
  stamp: string;
  readAt: number;
  remotes: readonly string[];
}

/**
 * Git rewrites `config` through a lockfile rename, so the inode changes on
 * every write — an edit that keeps the size and lands inside the mtime
 * granularity (renaming `origin` to `mirror`) still moves the stamp.
 */
async function readConfigStamp(commonDir: string): Promise<string | null> {
  try {
    const info = await stat(path.join(commonDir, "config"));
    return `${info.ino}:${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
  } catch {
    return null;
  }
}

/**
 * The worktree's configured remotes, cached behind a stat of the common dir's
 * `config`. Asked before every background fetch, so the steady state has to be
 * a single `stat` rather than a `git remote` spawn every cadence tick.
 *
 * Keyed by worktree, not common dir: siblings share `config` but not
 * necessarily their effective config, so one worktree's answer is never
 * served to another. `null` means the remotes could not be read, which callers
 * must treat as unknown — never as "no remotes".
 */
export function createRemoteInventoryReader(
  readRemotes: (worktreePath: string) => Promise<readonly string[] | null>,
  now: () => number = Date.now
): (worktreePath: string, commonDir: string, fresh?: boolean) => Promise<readonly string[] | null> {
  const cache = new Map<string, CachedInventory>();
  return async (worktreePath, commonDir, fresh = false) => {
    const stamp = await readConfigStamp(commonDir);
    if (stamp === null) {
      cache.delete(worktreePath);
      return null;
    }
    const cached = cache.get(worktreePath);
    if (
      !fresh &&
      cached &&
      cached.stamp === stamp &&
      now() - cached.readAt < INVENTORY_MAX_AGE_MS
    ) {
      return cached.remotes;
    }
    const remotes = await readRemotes(worktreePath);
    // A config written while `git remote` ran may or may not be in its answer,
    // and a stale "none" would suppress a fetch the new remote needs. Report
    // unknown and let the next call read the settled file.
    const settled = await readConfigStamp(commonDir);
    if (remotes === null || settled !== stamp) {
      cache.delete(worktreePath);
      return null;
    }
    cache.set(worktreePath, { stamp, readAt: now(), remotes });
    return remotes;
  };
}
