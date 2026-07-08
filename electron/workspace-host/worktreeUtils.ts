import { execFile } from "child_process";
import { mkdir, writeFile, stat, realpath } from "fs/promises";
import {
  join as pathJoin,
  dirname,
  basename,
  resolve as pathResolve,
  relative as pathRelative,
  isAbsolute as pathIsAbsolute,
  sep,
} from "path";
import { getGitDir } from "../utils/gitUtils.js";
import { getGitLocaleEnv } from "../utils/hardenedGit.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { NOTE_PATH } from "./types.js";

// Hard ceiling on the `git lfs version` probe. `git` is already on PATH, so a
// healthy probe returns in milliseconds; the 3 s cap only matters on slow/
// network-mounted filesystems or misconfigured shells. On timeout we treat LFS
// as unavailable rather than delay the load-project-result event (precedent:
// #4852 — don't block startup on optional probes).
const LFS_PROBE_TIMEOUT_MS = 3000;

/**
 * Probe whether `git lfs` is installed on the user's PATH. Uses raw `execFile`
 * (not simple-git / hardenedGit) because LFS availability is a read-only CLI
 * check that has nothing to do with the project's git repo; routing it through
 * hardenedGit would strip credential helpers for no reason. Returns `false` on
 * any error, non-matching stdout, or timeout.
 */
export function probeGitLfsAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const child = execFile(
      "git",
      ["lfs", "version"],
      {
        timeout: LFS_PROBE_TIMEOUT_MS,
        windowsHide: true,
        env: { ...process.env, ...getGitLocaleEnv(), LC_ALL: "" },
      },
      (err, stdout) => {
        if (err) {
          done(false);
          return;
        }
        done(/^git-lfs\//.test(stdout.trim()));
      }
    );

    // Defence in depth: if execFile's timeout fails to fire (e.g. child is
    // detached from the event loop), cap the wait ourselves.
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Best-effort — process may already have exited.
      }
      done(false);
    }, LFS_PROBE_TIMEOUT_MS + 500);

    child.on("exit", () => clearTimeout(timer));
    child.on("error", () => {
      clearTimeout(timer);
      done(false);
    });
  });
}

export function escapeBranchRegex(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseCheckedOutBranches(porcelainOutput: string): Set<string> {
  const branches = new Set<string>();
  for (const line of porcelainOutput.split("\n")) {
    if (line.startsWith("branch ")) {
      const ref = line.replace("branch ", "").replace("refs/heads/", "").trim();
      if (ref) {
        branches.add(ref);
      }
    }
  }
  return branches;
}

/**
 * Matches git's refusal when `worktree add -b` names a branch that already
 * exists ("fatal: a branch named 'x' already exists"). Deliberately anchored
 * on "branch named" — `worktree add` reports an existing target *path* with a
 * similar "already exists" phrase, and that failure must not trigger branch
 * collision recovery. Git output is locale-pinned to C/English by the
 * hardened factory's env, so message matching is stable.
 */
export function isBranchAlreadyExistsError(error: unknown): boolean {
  return /branch named .* already exists/i.test(formatErrorMessage(error, ""));
}

export function nextAvailableBranchName(baseName: string, existing: Set<string>): string {
  if (!existing.has(baseName)) {
    return baseName;
  }
  const pattern = new RegExp(`^${escapeBranchRegex(baseName)}-(\\d+)$`);
  let maxSuffix = 1;
  for (const name of existing) {
    const match = name.match(pattern);
    if (match) {
      const n = parseInt(match[1], 10);
      if (n > maxSuffix) {
        maxSuffix = n;
      }
    }
  }
  return `${baseName}-${maxSuffix + 1}`;
}

export async function ensureNoteFile(worktreePath: string): Promise<void> {
  const gitDir = await getGitDir(worktreePath);
  if (!gitDir) {
    return;
  }

  const notePath = pathJoin(gitDir, NOTE_PATH);

  try {
    await stat(notePath);
  } catch {
    try {
      const daintreeDir = dirname(notePath);
      await mkdir(daintreeDir, { recursive: true });
      await writeFile(notePath, "", { flag: "wx" });
    } catch (createError) {
      const code = (createError as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        console.warn("[WorkspaceHost] Failed to create note file:", notePath);
      }
    }
  }
}

/**
 * Canonicalize the nearest existing ancestor of `target` through `realpath`,
 * then re-append the not-yet-created tail segments. A worktree directory does
 * not exist when its path is validated, so `realpath(target)` would throw
 * ENOENT; walking up to the first existing ancestor still canonicalizes any
 * symlink in the existing portion of the path (e.g. a parent symlinked outside
 * the workspace) without requiring the leaf to exist. Falls back to the
 * lexically resolved path if no ancestor exists.
 */
export async function canonicalizeNearestExisting(target: string): Promise<string> {
  let current = pathResolve(target);
  const tail: string[] = [];
  // Bounded by path depth; dirname() reaches a fixed point at the fs root.
  for (;;) {
    try {
      const real = await realpath(current);
      return tail.length ? pathResolve(real, ...tail) : real;
    } catch (error) {
      // Only "does not exist" justifies walking up. A real failure (EACCES on
      // an existing-but-unreadable segment, EIO, ELOOP) must not be silently
      // downgraded to lexical reasoning — that would let an inaccessible
      // symlink escape containment. Re-throw anything other than absent paths.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw error;
      }
      const parent = dirname(current);
      if (parent === current) {
        return pathResolve(target);
      }
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * Enforce that a worktree create target stays within the repository's parent
 * directory. That parent is the outermost location the worktree path patterns
 * can produce — the default `{parent-dir}/{base-folder}-worktrees/{branch-slug}`
 * places the worktree as a sibling of the repo, and `validatePathPattern`
 * rejects absolute patterns that don't start with `{parent-dir}`. Containing to
 * the parent (rather than rootPath itself) preserves that model while rejecting
 * arbitrary writable locations and symlink escapes. Throws on violation. #9154.
 */
export async function assertWorktreePathContained(
  rootPath: string,
  absoluteCreatePath: string
): Promise<void> {
  const resolvedRoot = pathResolve(rootPath);
  const parentDir = dirname(resolvedRoot);
  // A repo at the filesystem root would make the parent boundary the root
  // itself, which would accept any path on the system. Reject rather than
  // degrade to an open boundary.
  if (parentDir === resolvedRoot) {
    throw new Error("Cannot create a worktree for a repository at the filesystem root");
  }
  const boundary = await realpath(parentDir);
  const target = await canonicalizeNearestExisting(absoluteCreatePath);
  const rel = pathRelative(boundary, target);
  // Reject the boundary itself (rel === ""), escapes ("../…"), and absolute
  // results (different drive on Windows). A plain "startsWith('..')" would
  // misfire on a legitimate sibling like "..foo"; gate on the separator. #4702.
  if (rel === "" || rel === ".." || rel.startsWith(".." + sep) || pathIsAbsolute(rel)) {
    throw new Error("Worktree path must be within the repository's parent directory");
  }
}
