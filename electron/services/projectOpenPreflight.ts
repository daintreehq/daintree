import fs from "fs/promises";
import type { Stats } from "fs";
import { AppError } from "../utils/errorTypes.js";
import { TimeoutError, withTimeout } from "../utils/withTimeout.js";

/**
 * Pre-flight validation for a folder the user is trying to open as a project
 * (#11409).
 *
 * simple-git decides whether it can run *before* it ever spawns git, using a
 * synchronous `statSync` it interprets itself: ENOENT and "the path is a file"
 * both collapse into one `GitConstructError` carrying no errno, while every
 * other errno escapes unwrapped. Nothing downstream can tell those apart, which
 * is why three separate layers ended up substring-matching error text and all
 * three missed. Classifying the path here — before git is constructed — is the
 * only place the distinction still exists.
 */

/**
 * A dead SMB/AFP mount can block `stat` in the kernel for a minute or more
 * rather than failing, so the open flow needs its own bound. Long enough that a
 * merely-slow spinning disk or first-touch network mount still resolves.
 */
export const PROJECT_DIRECTORY_STAT_TIMEOUT_MS = 5_000;

/**
 * In-flight `stat` calls keyed by path, so simultaneous opens of the same
 * folder — two windows restoring the same dead share at launch, say — cost one
 * syscall rather than one each.
 *
 * `stat` takes no AbortSignal, so a timed-out call keeps its libuv worker (a
 * 4-thread pool) until the OS gives up on the mount. Sharing bounds that. The
 * share is deliberately dropped once a call times out, though: holding it would
 * pin every later attempt to the same doomed promise, so remounting the drive
 * would never take effect and the path would stay broken until the app
 * restarted.
 */
const inFlightStats = new Map<string, Promise<Stats>>();

function statOnce(directoryPath: string): Promise<Stats> {
  const pending = inFlightStats.get(directoryPath);
  if (pending) return pending;

  const started = fs.stat(directoryPath).finally(() => {
    releaseStat(directoryPath, started);
  });
  inFlightStats.set(directoryPath, started);
  return started;
}

/**
 * Drop `promise` from the in-flight map, but only if it's still the entry
 * there — a later attempt may have already replaced it, and evicting that one
 * would let a third caller start yet another syscall against the same path.
 */
function releaseStat(directoryPath: string, promise: Promise<Stats>): void {
  if (inFlightStats.get(directoryPath) === promise) {
    inFlightStats.delete(directoryPath);
  }
}

/**
 * Throw a classified {@link AppError} if `directoryPath` isn't a readable
 * directory. Resolves silently when it is.
 *
 * Codes are derived from the errno, never from message text. Anything we can't
 * positively identify — a timeout, ESTALE from a yanked volume, EIO from a
 * failing disk — becomes `PROJECT_OPEN_FAILED` rather than `NOT_FOUND`: those
 * prove the path is unreachable, not that it's gone, and callers offer
 * destructive recovery ("remove from recent") off `NOT_FOUND`.
 */
export async function assertProjectDirectory(directoryPath: string): Promise<void> {
  const pending = statOnce(directoryPath);

  let stats: Stats;
  try {
    stats = await withTimeout(
      pending,
      PROJECT_DIRECTORY_STAT_TIMEOUT_MS,
      `Timed out reading ${directoryPath}`
    );
  } catch (error) {
    // A timed-out call never settles, so nothing else will clear it.
    if (error instanceof TimeoutError) releaseStat(directoryPath, pending);
    throw classifyStatFailure(directoryPath, error);
  }

  if (!stats.isDirectory()) {
    throw new AppError({
      code: "NOT_A_DIRECTORY",
      message: `Not a directory: ${directoryPath}`,
      context: { directoryPath },
    });
  }
}

function classifyStatFailure(directoryPath: string, error: unknown): AppError {
  const cause = error instanceof Error ? error : undefined;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const context = { directoryPath, errno: code };

  // ENOTDIR here means a *parent* segment is a file, so the path can't exist —
  // absent, same as ENOENT. A path whose final segment is a file stats fine and
  // is caught by the isDirectory() check instead.
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new AppError({
      code: "NOT_FOUND",
      message: `Project directory not found: ${directoryPath}`,
      context,
      cause,
    });
  }

  // The path itself is malformed rather than the target being unavailable.
  // Kept distinct so the copy doesn't blame a disconnected drive for what is
  // really a symlink loop or an over-long path.
  if (code === "ELOOP" || code === "ENAMETOOLONG") {
    return new AppError({
      code: "INVALID_PATH",
      message: `Unusable project path: ${directoryPath}`,
      context,
      cause,
    });
  }

  if (code === "EACCES" || code === "EPERM") {
    return new AppError({
      code: "PERMISSION",
      message: `Permission denied reading: ${directoryPath}`,
      context,
      cause,
    });
  }

  return new AppError({
    code: "PROJECT_OPEN_FAILED",
    message:
      error instanceof TimeoutError
        ? `Timed out reading: ${directoryPath}`
        : `Couldn't read: ${directoryPath}`,
    context,
    cause,
  });
}

/**
 * True when `error` (or anything on its cause chain) is a failed *spawn* of a
 * missing executable.
 *
 * Callers reach this only after {@link assertProjectDirectory} has confirmed the
 * directory exists, so a spawn ENOENT can no longer mean the working directory
 * — it's the git binary. Walking the chain rather than probing with
 * `git --version` keeps the failure path free of a subprocess, and the signal is
 * strictly better: it's the actual failure, not a re-enactment of it.
 *
 * The chain walk is required because `GitService.handleGitOperation` rewraps
 * this as a `WorktreeRemovedError` — its ENOENT text match can't tell a missing
 * binary from a missing worktree — but it does preserve the original as `cause`.
 */
export function isMissingExecutableError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const errno = current as NodeJS.ErrnoException;
    if (errno.code === "ENOENT" && errno.syscall?.startsWith("spawn")) return true;
    current = (current as { cause?: unknown }).cause;
  }

  return false;
}
