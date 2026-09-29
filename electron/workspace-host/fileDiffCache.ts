import { createHash } from "crypto";
import { lstat, readlink, stat } from "fs/promises";
import { homedir } from "os";
import { join, posix, resolve } from "path";
import type { SimpleGit } from "simple-git";

/**
 * Holds the encoded full diff behind `getFileDiff`'s byte windows, so paging
 * through a large diff runs git twice instead of once per window — an agent
 * reading a 10MB diff at the 24KB default would otherwise spawn ~430 full
 * diffs and re-encode every one of them.
 *
 * An entry is served only while its freshness key still matches, and the key
 * is always taken before the diff it guards is computed. For a git diff it
 * covers every input git reads: the HEAD commit (which the diff is then pinned
 * to), the index, the worktree entry, the effective config and every
 * attributes file. Anything it cannot fingerprint — a directory or gitlink,
 * a relocated git dir or index — is not cached at all. Bounded by entry
 * count, total bytes and an idle timeout, since only a diff still being paged
 * is worth holding.
 */

const MAX_ENTRIES = 4;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const IDLE_TTL_MS = 90_000;

// Relocate the repository or index for every git we spawn, out of sight of
// the paths the probe stats.
const GIT_LOCATION_ENV_KEYS = [
  "GIT_DIR",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_WORK_TREE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
];

interface Entry {
  freshness: string;
  bytes: Uint8Array;
  expiresAt: number;
}

export interface GitDiffFreshness {
  key: string;
  /** The commit the key was taken against; diff against it, not `HEAD`. */
  head: string;
}

/** Absence is a stable answer; any other failure means freshness is unknown. */
async function statKey(path: string, follow = true): Promise<string | null> {
  try {
    const s = follow ? await stat(path, { bigint: true }) : await lstat(path, { bigint: true });
    return `${s.mode}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "-" : null;
  }
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

export class FileDiffCache {
  private readonly entries = new Map<string, Entry>();
  private totalBytes = 0;
  private sweepTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  static key(
    source: "file" | "git",
    cwd: string,
    gitPath: string,
    status: string,
    ignoreWhitespace: boolean
  ): string {
    return [source, cwd, gitPath, status, String(ignoreWhitespace)].join("\u0000");
  }

  /** Freshness of a diff built from the worktree file alone (untracked/added). */
  static fileFreshness(absolutePath: string): Promise<string | null> {
    return statKey(absolutePath);
  }

  /**
   * Freshness of `git diff <head> -- <path>`, or null when it cannot be
   * established (unborn HEAD, git failure, an input it cannot see) — the
   * caller then computes the diff uncached.
   */
  static async gitFreshness(
    git: SimpleGit,
    cwd: string,
    gitPath: string,
    absolutePath: string
  ): Promise<GitDiffFreshness | null> {
    if (GIT_LOCATION_ENV_KEYS.some((key) => process.env[key])) return null;

    // A symlink's patch is its target string, which a stat that follows it
    // cannot see; a directory is a gitlink or a subtree whose content no stat
    // of its own reflects.
    const entry = await statKey(absolutePath, false);
    if (entry === null) return null;
    let entryKey = entry;
    try {
      const s = await lstat(absolutePath);
      if (s.isDirectory()) return null;
      if (s.isSymbolicLink()) entryKey += `>${await readlink(absolutePath)}`;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return null;
    }

    let gitDir: string;
    let commonDir: string;
    let toplevel: string;
    let prefix: string;
    let head: string;
    let vars: string;
    try {
      // `git var -l` is the effective config, includes resolved, plus the
      // global and system attributes paths git will actually read.
      const [revParse, varList] = await Promise.all([
        git.raw([
          "rev-parse",
          "--absolute-git-dir",
          "--git-common-dir",
          "--show-toplevel",
          "--show-prefix",
          "--verify",
          "HEAD",
        ]),
        git.raw(["var", "-l"]),
      ]);
      // Positional: the prefix is an empty line when cwd is the toplevel.
      const lines = revParse.split("\n");
      if (lines.length !== 6 || lines[5] !== "" || typeof varList !== "string") return null;
      gitDir = lines[0];
      commonDir = resolve(cwd, lines[1]);
      toplevel = lines[2];
      prefix = lines[3];
      head = lines[4];
      vars = varList;
    } catch {
      return null;
    }

    // Attributes apply from the repository root down, so a cwd below the
    // toplevel still has ancestors git reads.
    const attributeFiles: string[] = [];
    for (let dir = posix.dirname(prefix + gitPath); ; dir = posix.dirname(dir)) {
      attributeFiles.push(join(toplevel, dir === "." ? "" : dir, ".gitattributes"));
      if (dir === "." || dir === "/") break;
    }
    const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    attributeFiles.push(join(xdgConfig, "git", "attributes"), "/etc/gitattributes");
    for (const line of vars.split("\n")) {
      const match = /^(?:GIT_ATTR_GLOBAL|GIT_ATTR_SYSTEM|core\.attributesfile)=(.+)$/i.exec(line);
      // Git resolves a relative attributes path from the repository root.
      if (match) attributeFiles.push(resolve(toplevel, expandHome(match[1])));
    }

    const stats = await Promise.all(
      [join(gitDir, "index"), join(commonDir, "info", "attributes"), ...attributeFiles].map(
        (path) => statKey(path)
      )
    );
    if (stats.includes(null)) return null;
    // The ident lines carry the current time, not configuration.
    const config = vars
      .split("\n")
      .filter((line) => !/^GIT_(?:AUTHOR|COMMITTER)_IDENT=/.test(line))
      .join("\n");
    const configHash = createHash("sha256").update(config).digest("hex");
    return { key: [head, entryKey, configHash, ...stats].join("|"), head };
  }

  get(key: string, freshness: string): Uint8Array | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.freshness !== freshness || entry.expiresAt <= Date.now()) {
      this.delete(key);
      return null;
    }
    // Reinsert so Map order is least-recently-used first.
    this.entries.delete(key);
    entry.expiresAt = Date.now() + IDLE_TTL_MS;
    this.entries.set(key, entry);
    return entry.bytes;
  }

  set(key: string, freshness: string, bytes: Uint8Array): void {
    this.delete(key);
    // A request still in flight at dispose must not repopulate the cache.
    if (this.disposed || bytes.byteLength > MAX_TOTAL_BYTES) return;
    this.entries.set(key, { freshness, bytes, expiresAt: Date.now() + IDLE_TTL_MS });
    this.totalBytes += bytes.byteLength;
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= MAX_ENTRIES && this.totalBytes <= MAX_TOTAL_BYTES) break;
      this.delete(oldest);
    }
    this.scheduleSweep();
  }

  dispose(): void {
    this.disposed = true;
    this.entries.clear();
    this.totalBytes = 0;
    if (this.sweepTimer) clearTimeout(this.sweepTimer);
    this.sweepTimer = null;
  }

  private delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.totalBytes -= entry.bytes.byteLength;
  }

  private scheduleSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = null;
      const now = Date.now();
      for (const [key, entry] of this.entries) {
        if (entry.expiresAt <= now) this.delete(key);
      }
      if (this.entries.size > 0) this.scheduleSweep();
    }, IDLE_TTL_MS);
    this.sweepTimer.unref?.();
  }
}
