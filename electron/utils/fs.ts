import { access, unlink as fsUnlink } from "fs/promises";
import { unlinkSync, writeFileSync } from "fs";
import stubbornFs from "stubborn-fs";

// Wall-clock retry budgets for transient file-locking errors (EPERM/EBUSY/EACCES).
// IMPORTANT: stubborn-fs computes the deadline at the time options are passed, so
// these must be called per-invocation — not pre-bound at module init.
const RETRY_TIMEOUT_MS = 10_000;
// Sync retries spin-block the event loop; keep the budget short
const RETRY_TIMEOUT_SYNC_MS = 500;

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
  await stubbornFs.retry.writeFile({ timeout: RETRY_TIMEOUT_MS })(filePath, data, encoding);
}

function generateTempPath(filePath: string): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `${filePath}.${suffix}.tmp`;
}

/**
 * Atomic writeFile: writes to a temp file with flush, then renames to the
 * target path. If any step fails the temp file is cleaned up best-effort.
 */
export async function resilientAtomicWriteFile(
  filePath: string,
  data: string,
  encoding: BufferEncoding = "utf-8"
): Promise<void> {
  const tempPath = generateTempPath(filePath);
  try {
    await stubbornFs.retry.writeFile({ timeout: RETRY_TIMEOUT_MS })(tempPath, data, {
      encoding,
      flush: true,
    } as Parameters<typeof writeFileSync>[2]);
    await resilientRename(tempPath, filePath);
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
  encoding: BufferEncoding = "utf-8"
): void {
  const tempPath = generateTempPath(filePath);
  try {
    writeFileSync(tempPath, data, { encoding, flush: true } as Parameters<typeof writeFileSync>[2]);
    resilientRenameSync(tempPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // best-effort cleanup
    }
    throw error;
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
