// eager-import-allow: wraps the sync fs primitives used across the main process
import { dirname } from "path";
import {
  access,
  chmod as fsChmod,
  constants as fsConstants,
  open,
  unlink as fsUnlink,
} from "fs/promises";
import { chmodSync, closeSync, fsyncSync, openSync, unlinkSync, writeFileSync } from "fs";
import stubbornFs from "stubborn-fs";

// Wall-clock retry budgets for transient file-locking errors (EPERM/EBUSY/EACCES).
// IMPORTANT: stubborn-fs computes the deadline at the time options are passed, so
// these must be called per-invocation — not pre-bound at module init.
const RETRY_TIMEOUT_MS = 10_000;
// Sync retries spin-block the event loop; keep the budget short
const RETRY_TIMEOUT_SYNC_MS = 500;

/**
 * stubborn-fs treats EACCES/EPERM as retriable because on Windows those codes
 * stand in for transient lock contention (AV scanners, the search indexer). On
 * POSIX they mean the permission bits genuinely deny the write, which no amount
 * of waiting fixes — so the full budget is spent hammering the syscall in a
 * near-busy loop before surfacing an error the caller had to handle anyway.
 *
 * Probe the destination directory first. When it is plainly not writable, hand
 * stubborn-fs a zero budget so it takes exactly one attempt and rethrows the
 * authentic errno immediately. Transient codes (EMFILE/ENFILE/EAGAIN/EBUSY)
 * keep the full budget, and Windows is left entirely alone.
 */
async function writeRetryBudgetFor(filePath: string): Promise<number> {
  if (process.platform === "win32") return RETRY_TIMEOUT_MS;
  try {
    await access(dirname(filePath), fsConstants.W_OK);
    return RETRY_TIMEOUT_MS;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    // Only a definitive "permission denied" short-circuits. ENOENT and friends
    // fall through to the normal path so callers that create the directory as
    // part of the write still get the retry budget.
    return code === "EACCES" || code === "EPERM" ? 0 : RETRY_TIMEOUT_MS;
  }
}

/**
 * Rename with retry for transient file-locking errors (EPERM/EBUSY/EACCES).
 * Uses stubborn-fs for cross-platform resilience.
 */
export async function resilientRename(src: string, dest: string): Promise<void> {
  await stubbornFs.retry.rename({ timeout: RETRY_TIMEOUT_MS })(src, dest);
}

/**
 * Synchronous rename with retry. Retry budget is kept short (500ms) to
 * limit event-loop blocking during terminal disposal on Windows.
 */
export function resilientRenameSync(src: string, dest: string): void {
  stubbornFs.retry.renameSync({ timeout: RETRY_TIMEOUT_SYNC_MS })(src, dest);
}

/**
 * Direct (non-atomic) writeFile with retry for transient file-locking errors.
 * Uses stubborn-fs for cross-platform resilience.
 *
 * WARNING: This writes directly to the target path. If the process crashes
 * mid-write the file may be left corrupted. For important data, use
 * {@link resilientAtomicWriteFile} instead.
 */
export async function resilientDirectWriteFile(
  filePath: string,
  data: string,
  encoding: BufferEncoding = "utf-8"
): Promise<void> {
  const retryTimeout = await writeRetryBudgetFor(filePath);
  await stubbornFs.retry.writeFile({ timeout: retryTimeout })(filePath, data, encoding);
}

function generateTempPath(filePath: string): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `${filePath}.${suffix}.tmp`;
}

function isUnsupportedDirectorySyncError(error: unknown): boolean {
  const code =
    error != null && typeof error === "object" && "code" in error
      ? (error as NodeJS.ErrnoException).code
      : undefined;
  return code === "EPERM" || code === "EINVAL";
}

async function syncParentDirectory(filePath: string): Promise<void> {
  if (process.platform === "win32") return;
  const dirPath = dirname(filePath);
  let dirHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    dirHandle = await open(dirPath, "r");
    try {
      await dirHandle.sync();
    } catch (error) {
      if (!isUnsupportedDirectorySyncError(error)) throw error;
    }
  } finally {
    try {
      await dirHandle?.close();
    } catch {
      // Suppress close errors; sync failure (if any) is the primary error
    }
  }
}

function syncParentDirectorySync(filePath: string): void {
  if (process.platform === "win32") return;
  const dirPath = dirname(filePath);
  let fd: number | undefined;
  try {
    fd = openSync(dirPath, "r");
    try {
      fsyncSync(fd);
    } catch (error) {
      if (!isUnsupportedDirectorySyncError(error)) throw error;
    }
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Suppress close errors
      }
    }
  }
}

/**
 * Atomic writeFile: writes to a temp file with flush, then renames to the
 * target path. If any step fails the temp file is cleaned up best-effort.
 * Accepts strings (encoded with `encoding`) or binary buffers.
 *
 * `mode` (POSIX only) is applied both when the temp file is first created and
 * again before rename, so the file is never observable at the umask default —
 * not during the write, and not at the destination path. A crash mid-write
 * therefore can't strand a world-readable temp with sensitive contents.
 * Silently skipped on Windows.
 */
export async function resilientAtomicWriteFile(
  filePath: string,
  data: string | Buffer | Uint8Array,
  encoding: BufferEncoding = "utf-8",
  options?: { mode?: number }
): Promise<void> {
  const tempPath = generateTempPath(filePath);
  const applyMode = options?.mode !== undefined && process.platform !== "win32";
  const baseWriteOptions = typeof data === "string" ? { encoding, flush: true } : { flush: true };
  const writeOptions = (
    applyMode ? { ...baseWriteOptions, mode: options!.mode } : baseWriteOptions
  ) as Parameters<typeof writeFileSync>[2];
  const retryTimeout = await writeRetryBudgetFor(filePath);
  try {
    await stubbornFs.retry.writeFile({ timeout: retryTimeout })(tempPath, data, writeOptions);
    // Re-assert after write: writeFile's mode only applies on creation and is
    // masked by umask, so chmod guarantees exact bits even if the temp existed.
    if (applyMode) {
      await fsChmod(tempPath, options!.mode!);
    }
    await resilientRename(tempPath, filePath);
    await syncParentDirectory(filePath);
  } catch (error) {
    fsUnlink(tempPath).catch(() => {});
    throw error;
  }
}

/**
 * Synchronous atomic writeFile: writes to a temp file with flush, then
 * renames to the target path. Keeps retry budget short to limit
 * event-loop blocking.
 */
export function resilientAtomicWriteFileSync(
  filePath: string,
  data: string,
  encoding: BufferEncoding = "utf-8",
  options?: { mode?: number }
): void {
  const tempPath = generateTempPath(filePath);
  const applyMode = options?.mode !== undefined && process.platform !== "win32";
  try {
    writeFileSync(tempPath, data, {
      encoding,
      flush: true,
      ...(applyMode ? { mode: options!.mode } : {}),
    } as Parameters<typeof writeFileSync>[2]);
    // Re-assert after write: writeFileSync's mode only applies on creation and
    // is masked by umask, so chmod guarantees exact bits.
    if (applyMode) {
      chmodSync(tempPath, options!.mode!);
    }
    resilientRenameSync(tempPath, filePath);
    syncParentDirectorySync(filePath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // best-effort cleanup
    }
    throw error;
  }
}

// Owner-only permission bits for persisted runtime data (POSIX). Files land at
// 0o600 (rw-------), directories at 0o700 (rwx------) so nothing durable is
// left world-readable at the umask default on shared macOS/Linux machines.
export const OWNER_RW_FILE_MODE = 0o600;
export const OWNER_RWX_DIR_MODE = 0o700;

function isMissingPathError(error: unknown): boolean {
  return (
    error != null &&
    typeof error === "object" &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * chmod a file to owner-only read/write (0o600). POSIX-only — a no-op on Windows
 * (which ignores mode bits) and on missing paths. Best-effort: a chmod failure
 * warns and returns rather than throwing, so hardening never breaks a boot or a
 * write path. Use for retroactively tightening files an earlier app version
 * created at the umask default; new atomic writes should pass `{ mode }` instead.
 */
export function tightenFilePermissionsSync(filePath: string): void {
  if (process.platform === "win32" || !filePath) return;
  try {
    chmodSync(filePath, OWNER_RW_FILE_MODE);
  } catch (error) {
    if (isMissingPathError(error)) return;
    console.warn("[fs] Failed to tighten file permissions:", filePath, error);
  }
}

/**
 * chmod a directory to owner-only (0o700), POSIX-only, best-effort.
 *
 * `mkdir(dir, { recursive: true, mode })` only applies `mode` to segments it
 * newly creates — a pre-existing directory (every install upgrading from a
 * version that wrote it at 0o755) is left untouched. Call this unconditionally
 * after such an mkdir to tighten the directory in place regardless of age.
 */
export function tightenDirPermissionsSync(dirPath: string): void {
  if (process.platform === "win32" || !dirPath) return;
  try {
    chmodSync(dirPath, OWNER_RWX_DIR_MODE);
  } catch (error) {
    if (isMissingPathError(error)) return;
    console.warn("[fs] Failed to tighten directory permissions:", dirPath, error);
  }
}

/** Async counterpart to {@link tightenDirPermissionsSync}. */
export async function tightenDirPermissions(dirPath: string): Promise<void> {
  if (process.platform === "win32" || !dirPath) return;
  try {
    await fsChmod(dirPath, OWNER_RWX_DIR_MODE);
  } catch (error) {
    if (isMissingPathError(error)) return;
    console.warn("[fs] Failed to tighten directory permissions:", dirPath, error);
  }
}

// stubborn-fs only provides attempt.unlink (swallows all errors), not retry.unlink.
// We need retry-and-throw for callers that must know about ENOENT/permission failures.
const TRANSIENT_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

/**
 * unlink with retry for transient file-locking errors. Throws on ENOENT and
 * other non-transient errors. Uses exponential backoff up to 10s.
 */
export async function resilientUnlink(filePath: string): Promise<void> {
  let delay = 50;
  for (let attempt = 0; attempt <= 8; attempt++) {
    try {
      await fsUnlink(filePath);
      return;
    } catch (error) {
      const code =
        error != null && typeof error === "object" && "code" in error
          ? (error as NodeJS.ErrnoException).code
          : undefined;
      if (typeof code !== "string" || !TRANSIENT_CODES.has(code) || attempt === 8) throw error;
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
}

/**
 * Configuration for path existence polling
 */
interface WaitForPathOptions {
  /**
   * Initial check delay in milliseconds (default: 0 - check immediately)
   */
  initialDelayMs?: number;

  /**
   * Maximum total wait time in milliseconds (default: 5000)
   */
  timeoutMs?: number;

  /**
   * Backoff multiplier for retry delays (default: 2)
   */
  backoffMultiplier?: number;

  /**
   * Initial retry delay in milliseconds (default: 50)
   */
  initialRetryDelayMs?: number;

  /**
   * Maximum retry delay in milliseconds (default: 800)
   */
  maxRetryDelayMs?: number;
}

/**
 * Waits for a filesystem path to become accessible with exponential backoff.
 *
 * This utility handles race conditions where git operations complete before
 * the filesystem has flushed directory creation to disk. It's particularly
 * useful for worktree creation where node-pty requires the cwd to exist.
 *
 * @param path - The filesystem path to check
 * @param options - Configuration for polling behavior
 * @returns Promise that resolves when the path exists
 * @throws Error if the path doesn't exist within the timeout period
 *
 * @example
 * // Wait for worktree directory to exist before spawning terminals
 * await waitForPathExists('/path/to/worktree', { timeoutMs: 500 });
 */
export async function waitForPathExists(
  path: string,
  options: WaitForPathOptions = {}
): Promise<void> {
  const {
    initialDelayMs = 0,
    timeoutMs = 5000,
    backoffMultiplier = 2,
    initialRetryDelayMs = 50,
    maxRetryDelayMs = 800,
  } = options;

  const startTime = Date.now();
  let retryDelayMs = initialRetryDelayMs;
  let timerId: NodeJS.Timeout | undefined;

  // Helper to check if path exists
  const checkExists = async (): Promise<boolean> => {
    try {
      await access(path);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Only retry on ENOENT (path doesn't exist yet)
      // Fail fast on permission errors (EACCES, EPERM) or ENOTDIR
      if (code && code !== "ENOENT") {
        throw new Error(`Cannot access path: ${path} (${code}: ${(error as Error).message})`);
      }
      return false;
    }
  };

  // Helper to sleep with cleanup
  const sleep = (ms: number): Promise<void> => {
    return new Promise((resolve) => {
      timerId = setTimeout(() => {
        timerId = undefined;
        resolve();
      }, ms);
      // Unref timer to avoid keeping process alive during shutdown
      if (timerId && typeof timerId === "object" && "unref" in timerId) {
        (timerId as any).unref();
      }
    });
  };

  try {
    // Initial delay if specified
    if (initialDelayMs > 0) {
      await sleep(initialDelayMs);
    }

    // Poll until path exists or timeout. Ordering matters here: checkExists()
    // runs before the timeout check so that a path appearing right at the
    // timeout boundary (e.g. t≈500ms under a 500ms budget) is still observed.
    // Reversing the order throws on the final wakeup without a last check —
    // benign on a 5s budget, actively flaky on 500ms.
    while (true) {
      if (await checkExists()) {
        return;
      }

      const elapsed = Date.now() - startTime;
      if (elapsed >= timeoutMs) {
        throw new Error(`Timeout waiting for path to exist: ${path} (waited ${elapsed}ms)`);
      }

      // Calculate next retry delay with backoff
      const nextDelay = Math.min(retryDelayMs, maxRetryDelayMs);

      // Ensure we don't exceed timeout on next attempt
      const remainingTime = timeoutMs - elapsed;
      const actualDelay = Math.min(nextDelay, remainingTime);

      if (actualDelay <= 0) {
        throw new Error(`Timeout waiting for path to exist: ${path} (waited ${elapsed}ms)`);
      }

      // Wait before next attempt
      await sleep(actualDelay);

      // Increase delay for next iteration
      retryDelayMs = Math.floor(retryDelayMs * backoffMultiplier);
    }
  } finally {
    // Clean up any pending timer
    if (timerId !== undefined) {
      clearTimeout(timerId);
    }
  }
}
