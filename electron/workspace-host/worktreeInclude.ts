import { constants as fsConstants } from "fs";
import { copyFile, lstat, mkdir, realpath } from "fs/promises";
import { isAbsolute, join as pathJoin, relative as pathRelative, sep } from "path";
import { checkIgnoredPaths, listUntrackedMatchingPatternFile } from "../utils/gitCheckIgnore.js";
import { logInfo, logWarn } from "../utils/logger.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";

export const WORKTREE_INCLUDE_FILE = ".worktreeinclude";

// A `.worktreeinclude` is meant for small local config (`.env`, certificates,
// editor settings). The caps stop a broad pattern such as `**` from quietly
// cloning a dependency tree or a build cache into every new worktree.
export const WORKTREE_INCLUDE_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const WORKTREE_INCLUDE_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
export const WORKTREE_INCLUDE_MAX_FILES = 1_000;
const MAX_INCLUDE_FILE_BYTES = 64 * 1024;
// Pattern matching skips the repo's own ignore rules, so git walks every
// untracked tree (node_modules included) to find matches. Bounded so a huge
// checkout delays setup by seconds at most, never by the 30s hard ceiling.
const DISCOVERY_TIMEOUT_MS = 10_000;
const MAX_DISCOVERY_OUTPUT_BYTES = 8 * 1024 * 1024;

export interface WorktreeIncludeResult {
  copied: number;
  skippedExisting: number;
  skippedUnsafe: number;
  skippedOversized: number;
  skippedOverLimit: number;
}

export interface WorktreeIncludeOptions {
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxFiles?: number;
}

function isInside(root: string, candidate: string): boolean {
  const rel = pathRelative(root, candidate);
  return rel === "" || (rel.split(sep)[0] !== ".." && !isAbsolute(rel));
}

/**
 * Split a git-reported relative path into segments, or null when it could
 * address anything outside the worktree or inside git's own storage.
 */
export function safeSegments(relPath: string): string[] | null {
  if (relPath.length === 0 || relPath.endsWith("/") || isAbsolute(relPath)) return null;
  const segments = relPath.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return null;
    // Separators and drive/stream syntax that `path.join` would honour on Windows.
    if (process.platform === "win32" && /[\\:]/.test(segment)) return null;
    // Case-folded because `.GIT` is the same directory on APFS and NTFS.
    if (segment.toLowerCase() === ".git") return null;
  }
  return segments;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Create each missing parent directory of `segments` under `destRoot` one
 * level at a time, refusing to pass through anything that is not a real
 * directory. A recursive mkdir would follow a symlink the new checkout
 * carries (a tracked `config -> /etc`) and create directories outside the
 * worktree before any containment check could run. Non-recursive creation
 * also means a destination removed mid-copy is never recreated.
 */
async function ensureParentDirs(destRoot: string, segments: string[]): Promise<boolean> {
  let current = destRoot;
  for (const segment of segments.slice(0, -1)) {
    current = pathJoin(current, segment);
    try {
      const stats = await lstat(current);
      if (!stats.isDirectory()) return false;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return false;
      try {
        await mkdir(current);
      } catch (mkdirErr) {
        if ((mkdirErr as NodeJS.ErrnoException).code !== "EEXIST") return false;
        const stats = await lstat(current);
        if (!stats.isDirectory()) return false;
      }
    }
  }
  return true;
}

/**
 * Copy the gitignored files a repo's `.worktreeinclude` names from `srcRoot`
 * into the new worktree at `destRoot`, keeping their relative paths.
 *
 * A file is copied only when it matches a `.worktreeinclude` pattern AND git's
 * own ignore rules ignore it, so tracked files never come across. Patterns are
 * interpreted by git itself, so gitignore semantics hold exactly — including
 * that `!file` cannot re-include a file whose parent directory was matched.
 * Existing destination files are never overwritten.
 *
 * Never throws: a missing, oversized or unreadable include file, or a git
 * failure, copies nothing and leaves worktree creation to carry on.
 */
export async function copyWorktreeIncludeFiles(
  srcRoot: string,
  destRoot: string,
  options: WorktreeIncludeOptions = {}
): Promise<WorktreeIncludeResult> {
  const result: WorktreeIncludeResult = {
    copied: 0,
    skippedExisting: 0,
    skippedUnsafe: 0,
    skippedOversized: 0,
    skippedOverLimit: 0,
  };
  const maxFileBytes = options.maxFileBytes ?? WORKTREE_INCLUDE_MAX_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? WORKTREE_INCLUDE_MAX_TOTAL_BYTES;
  const maxFiles = options.maxFiles ?? WORKTREE_INCLUDE_MAX_FILES;

  const includeFile = pathJoin(srcRoot, WORKTREE_INCLUDE_FILE);
  try {
    const stats = await lstat(includeFile);
    if (!stats.isFile()) return result;
    if (stats.size > MAX_INCLUDE_FILE_BYTES) {
      logWarn(`[WorktreeInclude] ${WORKTREE_INCLUDE_FILE} is too large; nothing copied`, {
        srcRoot,
        bytes: stats.size,
        limit: MAX_INCLUDE_FILE_BYTES,
      });
      return result;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logWarn(`[WorktreeInclude] could not read ${WORKTREE_INCLUDE_FILE}; nothing copied`, {
        srcRoot,
        error: formatErrorMessage(err, "stat failed"),
      });
    }
    return result;
  }

  let copyList: string[];
  let realSrcRoot: string;
  let realDestRoot: string;
  try {
    realSrcRoot = await realpath(srcRoot);
    realDestRoot = await realpath(destRoot);
    if (realSrcRoot === realDestRoot) return result;
    const candidates = [
      ...(await listUntrackedMatchingPatternFile(srcRoot, includeFile, {
        timeoutMs: DISCOVERY_TIMEOUT_MS,
        maxStdoutBytes: MAX_DISCOVERY_OUTPUT_BYTES,
      })),
    ];
    const safe = candidates.filter((rel) => safeSegments(rel) !== null);
    result.skippedUnsafe += candidates.length - safe.length;
    const absolute = safe.map((rel) => pathJoin(srcRoot, ...rel.split("/")));
    const ignored = await checkIgnoredPaths(srcRoot, absolute, {
      timeoutMs: DISCOVERY_TIMEOUT_MS,
    });
    copyList = safe.filter((_, i) => ignored.has(absolute[i])).sort();
  } catch (err) {
    logWarn(`[WorktreeInclude] could not evaluate ${WORKTREE_INCLUDE_FILE}; nothing copied`, {
      srcRoot,
      error: formatErrorMessage(err, "git failed"),
    });
    return result;
  }

  const oversized: string[] = [];
  const failed: string[] = [];
  let totalBytes = 0;
  for (const [index, rel] of copyList.entries()) {
    if (result.copied >= maxFiles) {
      result.skippedOverLimit = copyList.length - index;
      break;
    }

    const segments = safeSegments(rel)!;
    const src = pathJoin(srcRoot, ...segments);
    const dest = pathJoin(destRoot, ...segments);
    try {
      const stats = await lstat(src);
      // Symlinks are skipped rather than followed or recreated: either could
      // carry content from outside the source repository into the worktree.
      if (!stats.isFile() || !isInside(realSrcRoot, await realpath(src))) {
        result.skippedUnsafe++;
        continue;
      }
      if (stats.size > maxFileBytes || totalBytes + stats.size > maxTotalBytes) {
        result.skippedOversized++;
        oversized.push(rel);
        continue;
      }

      if (!(await ensureParentDirs(destRoot, segments))) {
        result.skippedUnsafe++;
        continue;
      }
      const destParent = pathJoin(destRoot, ...segments.slice(0, -1));
      if (!isInside(realDestRoot, await realpath(destParent))) {
        result.skippedUnsafe++;
        continue;
      }

      // Anything already at the destination, including a dangling symlink
      // the checkout carries, is left exactly as the worktree has it. The
      // explicit lstat matters on Windows, where CopyFileW follows a
      // destination link despite fail-if-exists; COPYFILE_EXCL then covers a
      // file appearing in between.
      //
      // These checks are path-based, so a concurrent process swapping a path
      // component for a symlink between check and copy is not defended
      // against. Such a process already runs as this user with write access
      // to both trees, so it gains nothing it did not already have.
      if (await pathExists(dest)) {
        result.skippedExisting++;
        continue;
      }
      await copyFile(src, dest, fsConstants.COPYFILE_EXCL);
      totalBytes += stats.size;
      result.copied++;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        result.skippedExisting++;
        continue;
      }
      failed.push(`${rel}: ${formatErrorMessage(err, "copy failed")}`);
    }
  }

  if (failed.length > 0) {
    logWarn(`[WorktreeInclude] failed to copy ${failed.length} file(s)`, {
      errors: failed.slice(0, 20),
    });
  }
  if (oversized.length > 0) {
    logWarn(`[WorktreeInclude] skipped ${oversized.length} oversized file(s)`, {
      paths: oversized.slice(0, 20),
      maxFileBytes,
      maxTotalBytes,
    });
  }
  if (result.skippedOverLimit > 0) {
    logWarn(`[WorktreeInclude] file limit reached; ${result.skippedOverLimit} file(s) not copied`, {
      limit: maxFiles,
    });
  }
  if (copyList.length > 0) {
    logInfo(`[WorktreeInclude] copied ${result.copied} file(s) into new worktree`, {
      destRoot,
      ...result,
    });
  }
  return result;
}
