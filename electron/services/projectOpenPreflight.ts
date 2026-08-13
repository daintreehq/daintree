import fs from "fs/promises";
import path from "path";
import { constants as fsConstants } from "fs";
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
const inFlightProbes = new Map<string, Promise<DirectoryProbe>>();

interface DirectoryProbe {
  isDirectory: boolean;
}

/**
 * Stat the path and, when it is a directory, confirm we can actually read and
 * traverse it.
 *
 * Both syscalls live behind one shared entry so a dead mount can occupy at most
 * one worker per path, and so they share a single deadline rather than each
 * getting their own.
 */
function probeOnce(directoryPath: string): Promise<DirectoryProbe> {
  const pending = inFlightProbes.get(directoryPath);
  if (pending) return pending;

  const started = (async (): Promise<DirectoryProbe> => {
    const stats = await fs.stat(directoryPath);
    if (!stats.isDirectory()) return { isDirectory: false };
    // A successful stat says nothing about our access to the directory itself —
    // it only needs execute permission on the *parent*. A folder with its own
    // permission bits cleared stats fine and then fails when git tries to enter
    // it, which is precisely the "permission denied" case this classifier owes
    // an answer for.
    await fs.access(directoryPath, fsConstants.R_OK | fsConstants.X_OK);
    return { isDirectory: true };
  })().finally(() => {
    releaseProbe(directoryPath, started);
  });

  inFlightProbes.set(directoryPath, started);
  return started;
}

/**
 * Drop `promise` from the in-flight map, but only if it's still the entry
 * there — a later attempt may have already replaced it, and evicting that one
 * would let a third caller start yet another syscall against the same path.
 */
function releaseProbe(directoryPath: string, promise: Promise<DirectoryProbe>): void {
  if (inFlightProbes.get(directoryPath) === promise) {
    inFlightProbes.delete(directoryPath);
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
  const pending = probeOnce(directoryPath);

  let probe: DirectoryProbe;
  try {
    probe = await withTimeout(
      pending,
      PROJECT_DIRECTORY_STAT_TIMEOUT_MS,
      `Timed out reading ${directoryPath}`
    );
  } catch (error) {
    // A timed-out call never settles, so nothing else will clear it.
    if (error instanceof TimeoutError) releaseProbe(directoryPath, pending);
    throw classifyStatFailure(directoryPath, error);
  }

  if (!probe.isDirectory) {
    throw new AppError({
      code: "NOT_A_DIRECTORY",
      message: `Not a directory: ${directoryPath}`,
      context: { directoryPath },
    });
  }
}

/**
 * Whether a project root still carries a `.git` marker.
 *
 * Tri-state on purpose. `"unknown"` is not a soft `"missing"`: only a proven
 * absence may lead anywhere near demoting a row that claims a repository, so a
 * dead mount, a permissions blip or a slow first touch all have to be
 * distinguishable from a folder whose `.git` is genuinely gone.
 */
export type GitMarkerProbe = "present" | "missing" | "unknown";

/**
 * Bounded far tighter than {@link PROJECT_DIRECTORY_STAT_TIMEOUT_MS}: this runs
 * on every project switch, not on a user-initiated open, so it has to fail open
 * fast rather than hold a switch behind a dying mount. Overshooting merely
 * yields `"unknown"`, which preserves today's behavior.
 */
export const GIT_MARKER_STAT_TIMEOUT_MS = 1_000;

const inFlightMarkerProbes = new Map<string, Promise<boolean>>();

/**
 * Report whether `projectRoot` still has a `.git` entry, without ever blocking
 * a switch on a hung filesystem.
 *
 * Existence only — `.git` is a directory in a normal clone and a *file* in a
 * linked worktree or submodule, and both mean "git still owns this folder".
 * ENOENT/ENOTDIR are the only proofs of absence; every other errno, and the
 * timeout, answer `"unknown"` so the caller leaves the row alone.
 *
 * `lstat`, not `stat`: the question is whether the entry is there, not whether
 * it resolves. `stat` follows symlinks, so a `.git` symlinked onto a detached
 * volume would report ENOENT — "missing" for a marker plainly sitting in the
 * folder, which is precisely the false positive this tri-state exists to avoid.
 *
 * This is a cheap pre-gate, not a classifier: `"missing"` only earns the caller
 * the right to run the real classification, never a decision on its own.
 */
export async function probeGitMarker(projectRoot: string): Promise<GitMarkerProbe> {
  const markerPath = path.join(projectRoot, ".git");

  // Shared for the same reason as `probeOnce`: two windows restoring the same
  // dead share must not each pin a libuv worker to it.
  let pending = inFlightMarkerProbes.get(markerPath);
  if (!pending) {
    const started = fs
      .lstat(markerPath)
      .then(() => true)
      .finally(() => {
        if (inFlightMarkerProbes.get(markerPath) === started) {
          inFlightMarkerProbes.delete(markerPath);
        }
      });
    inFlightMarkerProbes.set(markerPath, started);
    pending = started;
  }

  try {
    await withTimeout(pending, GIT_MARKER_STAT_TIMEOUT_MS, `Timed out reading ${markerPath}`);
    return "present";
  } catch (error) {
    if (error instanceof TimeoutError) {
      // Never settles, so nothing else will clear it.
      if (inFlightMarkerProbes.get(markerPath) === pending) {
        inFlightMarkerProbes.delete(markerPath);
      }
      return "unknown";
    }
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unknown";
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
 * Re-exported so this module stays the single project-open guard surface its
 * callers and tests import from. The detection itself lives in `shared/` because
 * `classifyGitError` needs the same predicate and can't import from `electron/`
 * — a missing Git binary should be recognized once, not guessed at separately
 * by every site that sees the error (#11764).
 *
 * Callers reach it only after {@link assertProjectDirectory} has confirmed the
 * directory exists and is enterable, so a spawn ENOENT can no longer mean the
 * working directory — it's the git binary.
 */
export { isMissingGitExecutableError } from "../../shared/utils/gitOperationErrors.js";
