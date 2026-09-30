import {
  appendFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";

/**
 * Every temp dir the harness makes starts with this, so the reaper and the
 * teardown can tell ours from anything else in tmpdir.
 */
export const E2E_TEMP_PREFIX = "daintree-e2e-";

/**
 * Set by the global setup to a per-run manifest file. Playwright workers are
 * separate processes, so each one appends the dirs it creates and the global
 * teardown — back in the runner process — removes them.
 */
export const E2E_TEMP_MANIFEST_ENV = "DAINTREE_E2E_TEMP_MANIFEST";

/** `1` keeps every recorded dir after the run, for post-mortems. */
export const E2E_KEEP_USERDATA_ENV = "DAINTREE_E2E_KEEP_USERDATA";

export const STALE_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Record a dir for removal at the end of the run. A no-op outside a run that
 * installed the global setup (vitest, a config without it): nothing is lost,
 * the dir simply outlives the run like it always did.
 */
export function recordTempDir(dir: string, env: NodeJS.ProcessEnv = process.env): void {
  const manifest = env[E2E_TEMP_MANIFEST_ENV];
  if (!manifest) return;
  try {
    appendFileSync(manifest, `${dir}\n`);
  } catch {
    // Best effort: a lost record only means a leftover the reaper takes later.
  }
}

export function readTempManifest(manifest: string): string[] {
  if (!existsSync(manifest)) return [];
  const lines = readFileSync(manifest, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return [...new Set(lines)];
}

function resolveTmpRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return path.resolve(root);
  }
}

/**
 * Whether `target` is safe to delete: a direct child of tmpdir, carrying our
 * prefix, and not itself a symlink (which could point anywhere). The parent is
 * compared through realpath because macOS tmpdir lives behind /var → /private/var.
 */
export function isRemovableTempPath(target: string, root: string = tmpdir()): boolean {
  if (!path.isAbsolute(target)) return false;
  const base = path.basename(target);
  if (!base.startsWith(E2E_TEMP_PREFIX)) return false;
  if (resolveTmpRoot(path.dirname(target)) !== resolveTmpRoot(root)) return false;
  try {
    if (lstatSync(target).isSymbolicLink()) return false;
  } catch {
    return false;
  }
  return true;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Remove a dir, retrying the transient failures Windows gives for files a
 * just-exited process still holds. Returns false instead of throwing: cleanup
 * must never fail a run.
 */
export function removeTempPath(target: string): boolean {
  const attempts = process.platform === "win32" ? 8 : 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      // rmSync unlinks symlinks inside the tree rather than following them.
      rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transient = code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY";
      if (!transient || attempt === attempts) return false;
      sleepSync(200 * attempt);
    }
  }
  return false;
}

export function removeRecordedTempDirs(
  manifest: string,
  root: string = tmpdir()
): { removed: string[]; skipped: string[] } {
  const removed: string[] = [];
  const skipped: string[] = [];
  for (const dir of readTempManifest(manifest)) {
    if (!existsSync(dir)) continue;
    if (isRemovableTempPath(dir, root) && removeTempPath(dir)) removed.push(dir);
    else skipped.push(dir);
  }
  return { removed, skipped };
}

/**
 * Newest mtime of `target` and the entries up to `depth` levels below it. A
 * dir's own mtime only moves when its direct entries change, so a HOME whose
 * `.claude/` is being written would otherwise look untouched.
 */
function newestMtimeMs(target: string, depth: number): number {
  let newest = 0;
  try {
    const stat = lstatSync(target);
    newest = stat.mtimeMs;
    if (depth <= 0 || !stat.isDirectory()) return newest;
  } catch {
    return newest;
  }
  let names: string[];
  try {
    names = readdirSync(target);
  } catch {
    return newest;
  }
  for (const name of names) {
    newest = Math.max(newest, newestMtimeMs(path.join(target, name), depth - 1));
  }
  return newest;
}

/**
 * Remove our temp dirs (and stale manifests) untouched for `maxAgeMs`. Age
 * keeps this off anything a concurrent run on the same machine is still
 * using, and so does every dir a still-fresh manifest of another run lists.
 */
export function reapStaleTempDirs(
  root: string = tmpdir(),
  maxAgeMs: number = STALE_TEMP_MAX_AGE_MS,
  now: number = Date.now()
): string[] {
  const reaped: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return reaped;
  }
  const isFresh = (target: string, depth: number) => now - newestMtimeMs(target, depth) < maxAgeMs;

  const protectedDirs = new Set<string>();
  for (const name of entries) {
    if (!name.startsWith(`${E2E_TEMP_PREFIX}manifest-`)) continue;
    const manifest = path.join(root, name);
    if (!isFresh(manifest, 0)) continue;
    for (const dir of readTempManifest(manifest)) protectedDirs.add(path.basename(dir));
  }

  for (const name of entries) {
    if (!name.startsWith(E2E_TEMP_PREFIX) || protectedDirs.has(name)) continue;
    const target = path.join(root, name);
    try {
      if (lstatSync(target).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    if (isFresh(target, 2)) continue;
    if (removeTempPath(target)) reaped.push(target);
  }
  return reaped;
}
