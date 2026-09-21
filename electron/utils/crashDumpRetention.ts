import fsp from "node:fs/promises";
import path from "node:path";

/**
 * App-owned retention for Crashpad's local native crash dumps (#12563).
 *
 * Daintree starts `crashReporter` with `uploadToServer: false`, so no upload
 * thread ever moves reports out of `pending/`. Crashpad's own database prune
 * (128 MiB / 365 days) only runs on the handler's periodic-task thread, first
 * ten minutes after launch and then daily, which is too loose and too late to
 * bound a desktop install. This module applies a tighter budget itself.
 *
 * Only file metadata is ever read — dump contents can hold process memory and
 * are never opened, hashed, or uploaded.
 */

export interface CrashDumpRetentionPolicy {
  maxAgeMs: number;
  maxCount: number;
  maxBytes: number;
  /**
   * Dumps modified this recently are never deleted: Crashpad may still be
   * writing or moving them, and on Windows an in-progress report sits in the
   * same directory as finished ones.
   */
  activeWriteGraceMs: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const NATIVE_CRASH_DUMP_RETENTION: CrashDumpRetentionPolicy = {
  maxAgeMs: 30 * DAY_MS,
  maxCount: 20,
  maxBytes: 100 * 1024 * 1024,
  activeWriteGraceMs: 10 * 60 * 1000,
};

export interface CrashDumpRetentionResult {
  /** Finished dumps found in the managed directories. */
  count: number;
  bytes: number;
  oldestAgeMs: number | null;
  /** Dumps in `new/` — still being written or abandoned mid-write. Never deleted. */
  inProgressCount: number;
  inProgressBytes: number;
  deletedCount: number;
  deletedBytes: number;
  /** Dumps kept regardless of policy because they are recent or locked. */
  protectedCount: number;
  /** Failure counts keyed by `<operation>:<errno code>`. */
  failures: Record<string, number>;
  /** False where the layout is inventoried but never pruned (Windows). */
  deletionSupported: boolean;
}

// macOS (crash_report_database_mac.mm) and Linux (crash_report_database_generic.cc)
// move each report new/ → pending/ → completed/, so a file in pending/ or
// completed/ is always a finished write.
const POSIX_WRITE_DIR = "new";
const POSIX_MANAGED_DIRS = ["pending", "completed"];
// Windows (crash_report_database_win.cc) keeps every report, including ones
// still being written, in reports/ and tracks state in a shared `metadata`
// index this module cannot update. Those dumps are counted but never deleted.
const WINDOWS_REPORTS_DIR = "reports";

const DUMP_EXT = ".dmp";
const LOCK_EXT = ".lock";
const META_EXT = ".meta";

interface DumpEntry {
  path: string;
  size: number;
  mtimeMs: number;
}

// CrashRecoveryService classifies the previous session by looking for dumps
// newer than its start. Pruning before that inspection could erase the only
// evidence of a native crash, so callers must wait for this flag.
let recoveryInspectionComplete = false;

export function markCrashRecoveryInspectionComplete(): void {
  recoveryInspectionComplete = true;
}

export function isCrashRecoveryInspectionComplete(): boolean {
  return recoveryInspectionComplete;
}

export function _resetCrashRecoveryInspectionForTests(): void {
  recoveryInspectionComplete = false;
}

function errorCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : "UNKNOWN";
}

function recordFailure(failures: Record<string, number>, operation: string, err: unknown): void {
  const key = `${operation}:${errorCode(err)}`;
  failures[key] = (failures[key] ?? 0) + 1;
}

function sidecarPath(dumpPath: string, ext: string): string {
  return dumpPath.slice(0, -DUMP_EXT.length) + ext;
}

// Crashpad's POSIX database holds `<uuid>.lock` while a report is being read,
// written, or moved. Anything other than a definite ENOENT counts as locked.
async function isLocked(dumpPath: string): Promise<boolean> {
  try {
    await fsp.lstat(sidecarPath(dumpPath, LOCK_EXT));
    return true;
  } catch (err) {
    return errorCode(err) !== "ENOENT";
  }
}

async function listDumps(dir: string, failures: Record<string, number>): Promise<DumpEntry[]> {
  const dumps: DumpEntry[] = [];
  try {
    const handle = await fsp.opendir(dir);
    for await (const dirent of handle) {
      // Dirent types come from lstat, so symlinks and directories named
      // `*.dmp` are skipped rather than followed.
      if (!dirent.isFile() || !dirent.name.endsWith(DUMP_EXT)) continue;
      const filePath = path.join(dir, dirent.name);
      try {
        const stats = await fsp.lstat(filePath);
        dumps.push({ path: filePath, size: stats.size, mtimeMs: stats.mtimeMs });
      } catch (err) {
        // Crashpad moving the report between directories mid-scan is benign.
        if (errorCode(err) !== "ENOENT") recordFailure(failures, "stat", err);
      }
    }
  } catch (err) {
    if (errorCode(err) !== "ENOENT") recordFailure(failures, "scan", err);
  }
  return dumps;
}

function sumBytes(dumps: DumpEntry[]): number {
  return dumps.reduce((total, dump) => total + dump.size, 0);
}

/**
 * Applies `policy` to the Crashpad database at `dumpsDir`. The newest dump is
 * always kept unless it has aged out, so a crash earlier in the running
 * session still classifies the next launch as `native-crash`. Beyond that,
 * dumps are kept newest-first while they fit the count and byte budget; every
 * older dump, and anything past `maxAgeMs`, is deleted. Recent and locked
 * dumps are never deleted but still consume budget.
 *
 * Never throws — every filesystem failure is counted in `failures`.
 */
export async function pruneCrashDumps(
  dumpsDir: string,
  options: { policy?: CrashDumpRetentionPolicy; nowMs?: number; platform?: NodeJS.Platform } = {}
): Promise<CrashDumpRetentionResult> {
  const policy = options.policy ?? NATIVE_CRASH_DUMP_RETENTION;
  const nowMs = options.nowMs ?? Date.now();
  const deletionSupported = (options.platform ?? process.platform) !== "win32";
  const failures: Record<string, number> = {};

  const inProgress = deletionSupported
    ? await listDumps(path.join(dumpsDir, POSIX_WRITE_DIR), failures)
    : [];
  const dumps: DumpEntry[] = [];
  for (const dir of deletionSupported ? POSIX_MANAGED_DIRS : [WINDOWS_REPORTS_DIR]) {
    dumps.push(...(await listDumps(path.join(dumpsDir, dir), failures)));
  }

  const result: CrashDumpRetentionResult = {
    count: dumps.length,
    bytes: sumBytes(dumps),
    oldestAgeMs:
      dumps.length > 0
        ? nowMs - dumps.reduce((oldest, dump) => Math.min(oldest, dump.mtimeMs), Infinity)
        : null,
    inProgressCount: inProgress.length,
    inProgressBytes: sumBytes(inProgress),
    deletedCount: 0,
    deletedBytes: 0,
    protectedCount: 0,
    failures,
    deletionSupported,
  };
  if (!deletionSupported) return result;

  // Newest first; the path tiebreak keeps equal-mtime ordering deterministic.
  dumps.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));

  const toDelete: DumpEntry[] = [];
  let keptCount = 0;
  let keptBytes = 0;
  let budgetExhausted = false;
  for (const [index, dump] of dumps.entries()) {
    const ageMs = nowMs - dump.mtimeMs;
    // A negative age (clock skew, future mtime) lands here too.
    if (ageMs < policy.activeWriteGraceMs || (await isLocked(dump.path))) {
      result.protectedCount++;
      keptCount++;
      keptBytes += dump.size;
      continue;
    }
    if (ageMs > policy.maxAgeMs) {
      toDelete.push(dump);
      continue;
    }
    const fitsBudget =
      !budgetExhausted && keptCount < policy.maxCount && keptBytes + dump.size <= policy.maxBytes;
    if (index === 0 || fitsBudget) {
      keptCount++;
      keptBytes += dump.size;
    } else {
      // Keep a strict newest-first prefix: once one dump misses the budget,
      // a smaller older one must not slip back in ahead of it.
      budgetExhausted = true;
      toDelete.push(dump);
    }
  }

  for (const dump of toDelete) {
    // Crashpad may have picked the report up since the scan.
    if (await isLocked(dump.path)) {
      result.protectedCount++;
      continue;
    }
    try {
      await fsp.unlink(dump.path);
    } catch (err) {
      if (errorCode(err) !== "ENOENT") recordFailure(failures, "unlink", err);
      continue;
    }
    result.deletedCount++;
    result.deletedBytes += dump.size;
    // Linux keeps per-report metadata in a `.meta` sidecar (macOS stores it as
    // xattrs on the dump itself). Removed only once its dump is gone, so a
    // failed dump unlink never strands a report without its metadata.
    try {
      await fsp.unlink(sidecarPath(dump.path, META_EXT));
    } catch (err) {
      if (errorCode(err) !== "ENOENT") recordFailure(failures, "unlink-meta", err);
    }
  }

  return result;
}
