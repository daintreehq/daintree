import fs from "node:fs/promises";
import path from "node:path";
import { getGitCommonDir } from "../../utils/gitUtils.js";
import type { RemoteLister } from "./matcher.js";

type Remotes = Awaited<ReturnType<RemoteLister>>;

/**
 * The longest a reading is reused, for what the fingerprint can't see:
 * global config and `insteadOf`, included files, worktree config.
 */
const DEFAULT_MAX_AGE_MS = 30_000;

export type ConfigFingerprint = (repoPath: string) => Promise<string | null>;

/**
 * The repository's own config file. Git rewrites it by lock-then-rename, so
 * every `git remote` change lands a new inode, whatever the filesystem's
 * timestamp granularity.
 */
export const repositoryConfigFingerprint: ConfigFingerprint = async (repoPath) => {
  const commonDir = await getGitCommonDir(repoPath, { logErrors: false });
  if (!commonDir) return null;
  const stats = await fs.stat(path.resolve(commonDir, "config")).catch(() => null);
  return stats ? `${stats.ino}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}` : null;
};

interface Entry {
  fingerprint: string;
  readAt: number;
  remotes: Promise<Remotes>;
}

/**
 * Repository remotes for lookups that come close together: one read per
 * repository while its config stays the same, shared by the lookups that
 * overlap it. A repository whose config can't be found is read every time,
 * and a failed read is never kept.
 */
export class RemoteReadCache {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly fingerprint: ConfigFingerprint;
  private readonly maxAgeMs: number;

  constructor(
    private readonly listRemotes: RemoteLister,
    options: { now?: () => number; fingerprint?: ConfigFingerprint; maxAgeMs?: number } = {}
  ) {
    this.now = options.now ?? (() => Date.now());
    this.fingerprint = options.fingerprint ?? repositoryConfigFingerprint;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  }

  readonly read: RemoteLister = async (repoPath) => {
    const key = path.resolve(repoPath);
    // Taken before the read: a write while git runs changes the next lookup's
    // fingerprint, so that lookup reads again.
    const fingerprint = await this.fingerprint(repoPath).catch(() => null);
    const now = this.now();
    if (fingerprint === null) {
      this.entries.delete(key);
      return copy(await this.listRemotes(repoPath));
    }
    const cached = this.entries.get(key);
    if (cached && cached.fingerprint === fingerprint && now - cached.readAt < this.maxAgeMs) {
      return copy(await cached.remotes);
    }
    this.sweep(now);
    const entry: Entry = {
      fingerprint,
      readAt: now,
      remotes: Promise.resolve().then(() => this.listRemotes(repoPath)),
    };
    this.entries.set(key, entry);
    entry.remotes.catch(() => {
      // Only this read's own entry: a newer one for a changed config stays.
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    return copy(await entry.remotes);
  };

  /** Expired readings are never reused, so only the last few seconds' repositories are held. */
  private sweep(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.readAt >= this.maxAgeMs) this.entries.delete(key);
    }
  }
}

function copy(remotes: Remotes): Remotes {
  return remotes.map((remote) => ({ ...remote }));
}
