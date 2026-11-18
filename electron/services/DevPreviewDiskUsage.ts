import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import type {
  DevPreviewDirMeta,
  DevPreviewPackageManager,
} from "../../shared/types/ipc/devPreview.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";

// Framework build/dep caches wiped by restartAndClearCache, relative to the
// session cwd. Covers Next, Vite, Turbo, SvelteKit, Astro, and Nuxt root caches
// plus Vite's node_modules/.vite dep-optimization cache (distinct from a
// root-level .vite directory). Missing dirs are tolerated by removal callers.
export const CACHE_DIRS: readonly string[] = [
  ".next",
  ".vite",
  ".turbo",
  ".svelte-kit",
  ".astro",
  ".nuxt",
  path.join("node_modules", ".vite"),
];

/**
 * Deletes the framework cache directories under cwd. Returns an error
 * message string if any deletion failed, or null on success. `force: true`
 * makes missing directories a no-op.
 */
export async function clearCacheDirs(cwd: string): Promise<string | null> {
  const failures: string[] = [];
  for (const dir of CACHE_DIRS) {
    try {
      await fsPromises.rm(path.join(cwd, dir), { recursive: true, force: true });
    } catch (err) {
      failures.push(`${dir} (${formatErrorMessage(err, "deletion failed")})`);
    }
  }
  return failures.length > 0 ? failures.join(", ") : null;
}

// Lockfile precedence mirrors detectInstallCommand: bun > pnpm > yarn > npm.
// package-lock.json is only used to report the lockfile name when no other
// lockfile is present; it does not change the install command (npm is the
// default fallback regardless).
export function detectPackageManagerInfo(cwd: string): {
  packageManager: DevPreviewPackageManager;
  lockfileName: string | null;
} {
  if (existsSync(path.join(cwd, "bun.lock"))) {
    return { packageManager: "bun", lockfileName: "bun.lock" };
  }
  if (existsSync(path.join(cwd, "bun.lockb"))) {
    return { packageManager: "bun", lockfileName: "bun.lockb" };
  }
  if (existsSync(path.join(cwd, "pnpm-lock.yaml"))) {
    return { packageManager: "pnpm", lockfileName: "pnpm-lock.yaml" };
  }
  if (existsSync(path.join(cwd, "yarn.lock"))) {
    return { packageManager: "yarn", lockfileName: "yarn.lock" };
  }
  if (existsSync(path.join(cwd, "package-lock.json"))) {
    return { packageManager: "npm", lockfileName: "package-lock.json" };
  }
  return { packageManager: "npm", lockfileName: null };
}

export function detectInstallCommand(cwd: string): string {
  const info = detectPackageManagerInfo(cwd);
  return `${info.packageManager} install`;
}

export async function statDirMeta(cwd: string, relPath: string): Promise<DevPreviewDirMeta> {
  const fullPath = path.join(cwd, relPath);
  try {
    const stat = await fsPromises.stat(fullPath);
    if (!stat.isDirectory()) {
      return { relPath, exists: false, mtimeMs: null };
    }
    return { relPath, exists: true, mtimeMs: stat.mtimeMs };
  } catch {
    return { relPath, exists: false, mtimeMs: null };
  }
}

// A Windows scan that couldn't finish gets one more pass: a dev server replacing
// its output mid-scan usually leaves the second pass clean. Never sleeps.
const WALK_ATTEMPTS = 2;

/**
 * The bytes under `dirPath`, or null when the figure couldn't be completed
 * (not a directory, an unreadable or vanished entry, a failed `du`). A partial
 * sum is never returned: the confirmation preview presents every number as a
 * measured size, so an undercount, or a zero for an unreadable directory,
 * would be taken as fact. `platform` exists so tests reach the Windows walk.
 */
export async function computeDirSize(
  dirPath: string,
  platform: NodeJS.Platform = process.platform
): Promise<number | null> {
  try {
    const stat = await fsPromises.stat(dirPath);
    if (!stat.isDirectory()) return null;
  } catch {
    return null;
  }
  if (platform === "win32") {
    for (let attempt = 0; attempt < WALK_ATTEMPTS; attempt++) {
      const bytes = await computeDirSizeWalk(dirPath);
      if (bytes !== null) return bytes;
    }
    return null;
  }
  return computeDirSizeDu(dirPath);
}

// POSIX path: shell out to `du -sk` (kilobytes). execFile avoids shell
// interpretation entirely — dirPath cannot inject. `du` deduplicates
// hardlinks by inode within the traversal, so pnpm-linked files inside
// node_modules count once per inode (still reports apparent content size,
// not the disk that would actually be reclaimed by deletion).
async function computeDirSizeDu(dirPath: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile("du", ["-sk", dirPath], { maxBuffer: 1024 * 1024, timeout: 30_000 }, (err, stdout) => {
      if (err) return resolve(null);
      const firstField = stdout.trim().split(/\s+/, 1)[0];
      const kilobytes = Number.parseInt(firstField, 10);
      if (!Number.isFinite(kilobytes)) return resolve(null);
      resolve(kilobytes * 1024);
    });
  });
}

// Windows fallback: no `du` available. Walks the tree with opendir,
// accumulating file sizes via lstat. Tracks an inode set to dedupe
// hardlinks where the FS reports a stable inode (NTFS returns 0/unstable
// values in some cases — those entries simply count each time, accepting a
// small over-report on edge filesystems). Any directory that can't be opened
// or entry that can't be read — vanished mid-walk included, as with `du` —
// abandons the scan with null rather than skipping it.
async function computeDirSizeWalk(dirPath: string): Promise<number | null> {
  try {
    let total = 0;
    const seenInos = new Set<string>();
    const stack: string[] = [dirPath];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      const handle = await fsPromises.opendir(cur);
      for await (const ent of handle) {
        const full = path.join(cur, ent.name);
        if (ent.isDirectory()) {
          stack.push(full);
        } else if (ent.isFile() || ent.isSymbolicLink()) {
          const st = await fsPromises.lstat(full);
          const inoKey = st.ino ? `${st.dev}:${st.ino}` : null;
          if (inoKey && seenInos.has(inoKey)) continue;
          if (inoKey) seenInos.add(inoKey);
          total += st.size;
        }
      }
    }
    return total;
  } catch {
    return null;
  }
}
