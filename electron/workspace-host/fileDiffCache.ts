import { createHash } from "crypto";
import { lstat, readFile, readlink, realpath, stat } from "fs/promises";
import { homedir } from "os";
import { join, posix, resolve } from "path";
import type { SimpleGit } from "simple-git";
import { resolveHeadOidFromGitDir } from "../utils/git.js";
import { resolveGitDirFromFs } from "../utils/gitUtils.js";

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
 *
 * The git spawns behind a key are kept with the entry they keyed, and the next
 * window reuses them while the filesystem shows that nothing they read has
 * moved: `.git` still leads to the same git dir, HEAD resolves to the same
 * commit, and every config file git named has the same stat. Back-to-back
 * windows then cost stats, not processes.
 */

const MAX_ENTRIES = 4;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const IDLE_TTL_MS = 90_000;

interface Entry {
  freshness: string;
  bytes: Uint8Array;
  expiresAt: number;
  probe: GitDiffProbe | null;
}

/** What `rev-parse` and `git var -l` answered for one freshness key. */
export interface GitDiffProbe {
  gitDir: string;
  commonDir: string;
  toplevel: string;
  prefix: string;
  head: string;
  vars: string;
  /**
   * Where `.git` leads and the stats of every config file git reads, taken
   * between two reads of `git var -l` that agree. Null when the config files
   * can't all be named, and the probe is then never reused.
   */
  validator: string | null;
}

export interface GitDiffFreshness {
  key: string;
  /** The commit the key was taken against; diff against it, not `HEAD`. */
  head: string;
  probe: GitDiffProbe;
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

/**
 * The config files behind `git var -l`, or null when they can't all be named.
 * Git 2.42+ lists the global and system files it reads (system is absent under
 * `GIT_CONFIG_NOSYSTEM`); an older git lists neither. An include can pull in
 * any file at all, so its presence rules the list out too.
 */
function configFiles(vars: string, gitDir: string, commonDir: string): string[] | null {
  const files = [join(commonDir, "config"), join(gitDir, "config.worktree")];
  let listsGlobal = false;
  for (const line of vars.split("\n")) {
    if (/^include(?:if\..*)?\.path=/i.test(line)) return null;
    const match = /^GIT_CONFIG_(GLOBAL|SYSTEM)=(.*)$/.exec(line);
    if (!match) continue;
    if (match[1] === "GLOBAL") listsGlobal = true;
    if (match[2]) files.push(expandHome(match[2]));
  }
  return listsGlobal ? files : null;
}

/** `git var -l` without the ident lines, which carry the current time. */
function configOf(vars: string): string {
  return vars
    .split("\n")
    .filter((line) => !/^GIT_(?:AUTHOR|COMMITTER)_IDENT=/.test(line))
    .join("\n");
}

/**
 * Fingerprint of what a probe's spawns read beyond HEAD, from the filesystem
 * alone. Only for a cwd at the repository root, where `.git` is the one entry
 * repository discovery consults. A `.git` directory is identified by its inode
 * (its mtime moves with every ref or index write, which other parts of the key
 * already see), a gitfile by its full stat, and either by the real path of the
 * git dir it leads to, which must be the probed one, as must the common dir
 * that dir's `commondir` names: a symlink or pointer retargeted underneath an
 * unchanged `.git` is a different repository.
 */
async function probeValidator(
  cwd: string,
  gitDir: string,
  commonDir: string,
  prefix: string,
  vars: string
): Promise<string | null> {
  if (prefix !== "") return null;
  const files = configFiles(vars, gitDir, commonDir);
  if (files === null) return null;
  let discovery: string;
  try {
    // From the real cwd: a relative gitfile pointer is left unresolved under a
    // symlinked path.
    const realCwd = await realpath(cwd);
    const [s, found, pointer] = await Promise.all([
      lstat(join(realCwd, ".git"), { bigint: true }),
      resolveGitDirFromFs(realCwd),
      readFile(join(gitDir, "commondir"), "utf-8").then(
        (text) => text.trim(),
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return "";
          throw error;
        }
      ),
    ]);
    if (found === null) return null;
    const [foundReal, gitDirReal, commonDirReal, pointedReal] = await Promise.all([
      realpath(found),
      realpath(gitDir),
      realpath(commonDir),
      realpath(pointer ? resolve(gitDir, pointer) : gitDir),
    ]);
    if (foundReal !== gitDirReal || pointedReal !== commonDirReal) return null;
    const entry = s.isDirectory()
      ? `d:${s.dev}:${s.ino}`
      : `f:${s.mode}:${s.ino}:${s.size}:${s.mtimeNs}`;
    discovery = [entry, gitDirReal, commonDirReal].join(">");
  } catch {
    return null;
  }
  // `commondir` is statted as well as followed: a pointer moved away and back
  // between two windows names the same dir both times, but never stats the same.
  const watched = [...files, join(gitDir, "commondir")];
  const stats = await Promise.all(watched.map((path) => statKey(path)));
  if (stats.includes(null)) return null;
  return [discovery, ...watched.map((path, i) => `${path}=${stats[i]}`)].join("|");
}

/** The previous probe, when the filesystem shows nothing it read has changed. */
async function reusableProbe(cwd: string, previous: GitDiffProbe): Promise<GitDiffProbe | null> {
  if (previous.validator === null) return null;
  const [head, validator] = await Promise.all([
    // Against the probed common dir, which the validator has just confirmed,
    // never a pointer cached from before it moved.
    resolveHeadOidFromGitDir(previous.gitDir, previous.commonDir),
    probeValidator(cwd, previous.gitDir, previous.commonDir, previous.prefix, previous.vars),
  ]);
  return head === previous.head && validator === previous.validator ? previous : null;
}

async function runProbe(git: SimpleGit, cwd: string): Promise<GitDiffProbe | null> {
  try {
    // `git var -l` is the effective config, includes resolved, plus the
    // global and system attributes paths git will actually read.
    const [revParse, vars] = await Promise.all([
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
    if (lines.length !== 6 || lines[5] !== "" || typeof vars !== "string") return null;
    const [gitDir, commonDirRaw, toplevel, prefix, head] = lines;
    const commonDir = resolve(cwd, commonDirRaw);
    const validator = await probeValidator(cwd, gitDir, commonDir, prefix, vars);
    // A config write between `git var -l` and those stats would pair the old
    // answer with the new files, an include among them. Asking again after the
    // stats closes that: the same answer means the files the stats describe are
    // the ones git read, or have moved since, which the stats then no longer
    // match, so nothing reuses them. A different answer means the config moved
    // mid-probe, and no key is taken from it at all.
    if (validator !== null) {
      const again = await git.raw(["var", "-l"]);
      if (typeof again !== "string" || configOf(again) !== configOf(vars)) return null;
    }
    return { gitDir, commonDir, toplevel, prefix, head, vars, validator };
  } catch {
    return null;
  }
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
    ignoreWhitespace: boolean,
    side?: string
  ): string {
    return [source, cwd, gitPath, status, String(ignoreWhitespace), side ?? ""].join("\u0000");
  }

  /**
   * Freshness of a diff built from the worktree file alone (untracked/added).
   * Not followed: a symlink's patch is its target string, and retargeting it
   * replaces the link entry itself.
   */
  static fileFreshness(absolutePath: string): Promise<string | null> {
    return statKey(absolutePath, false);
  }

  /**
   * Freshness of `git diff <head> -- <path>`, or null when it cannot be
   * established (unborn HEAD, git failure, an input it cannot see) — the
   * caller then computes the diff uncached. `previous` is the probe of the
   * entry being checked, reused instead of spawning git when still valid.
   */
  static async gitFreshness(
    git: SimpleGit,
    cwd: string,
    gitPath: string,
    absolutePath: string,
    previous: GitDiffProbe | null = null
  ): Promise<GitDiffFreshness | null> {
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

    const probe =
      (previous ? await reusableProbe(cwd, previous) : null) ?? (await runProbe(git, cwd));
    if (probe === null) return null;
    const { gitDir, commonDir, toplevel, prefix, head, vars } = probe;

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
    const configHash = createHash("sha256").update(configOf(vars)).digest("hex");
    // The validator rides in the key too: a config file rewritten and put back
    // between two windows hashes the same, but never stats the same.
    return {
      key: [head, entryKey, configHash, probe.validator ?? "", ...stats].join("|"),
      head,
      probe,
    };
  }

  /** The probe behind a live entry, for its next freshness check to start from. */
  probe(key: string): GitDiffProbe | null {
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt <= Date.now()) return null;
    return entry.probe;
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

  set(key: string, freshness: string, bytes: Uint8Array, probe: GitDiffProbe | null = null): void {
    this.delete(key);
    // A request still in flight at dispose must not repopulate the cache.
    if (this.disposed || bytes.byteLength > MAX_TOTAL_BYTES) return;
    this.entries.set(key, { freshness, bytes, expiresAt: Date.now() + IDLE_TTL_MS, probe });
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
