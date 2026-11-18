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
