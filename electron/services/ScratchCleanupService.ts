/**
 * Startup auto-cleanup for stale scratch workspaces.
 *
 * A scratch whose `lastOpened` predates `now - SCRATCH_CLEANUP_TTL_MS` has
 * its filesystem directory removed and its DB row tombstoned (`deleted_at`
 * set), then hard-deleted once `fs.rm` succeeds. Tombstoned rows are
 * filtered out of every renderer-facing query in `ScratchStore`, so the
 * renderer never sees them again. The current scratch (per
 * `app_state.currentScratchId`) is always excluded so an actively-open
 * workspace can never disappear under the user.
 *
 * The sweep also retries already-tombstoned rows whose directory is still
 * present — this is the recovery path for a `removeScratch` that crashed
 * between tombstone and `fs.rm`. The row is hard-deleted once the directory
 * is gone.
 *
 * Mirrors the fire-and-forget pattern of `initializeTrashedPidCleanup`:
 * called once at app boot, never awaited, never throws — a cleanup failure
 * must not block startup.
 */
import fs from "fs/promises";
import { scratchStore as defaultScratchStore } from "./ScratchStore.js";
import { logError, logInfo } from "../utils/logger.js";
import { SCRATCH_CLEANUP_TTL_MS } from "../../shared/config/scratchCleanup.js";
import { getScratchDir, getScratchesRoot } from "./scratchStorePaths.js";
import { getWritesSuppressed } from "./diskPressureState.js";

export interface ScratchCleanupResult {
  /** Total rows examined as candidates (live-stale plus already-tombstoned). */
  candidates: number;
  /** Rows actually tombstoned during this sweep (excludes pre-tombstoned rows). */
  tombstoned: number;
  /** Directories successfully removed (or already absent). */
  directoriesRemoved: number;
  /** Directories that failed to remove (logged, not rethrown). */
  directoriesFailed: number;
}

/**
 * Stale-scratch sweep — runs synchronously against the DB then asynchronously
 * for the filesystem deletes. Returns a summary for tests; production callers
 * use {@link initializeScratchCleanup} which discards the result.
 */
export async function runScratchCleanup(
  now: number = Date.now(),
  store = defaultScratchStore
): Promise<ScratchCleanupResult> {
  const result: ScratchCleanupResult = {
    candidates: 0,
    tombstoned: 0,
    directoriesRemoved: 0,
    directoriesFailed: 0,
  };

  const cutoff = now - SCRATCH_CLEANUP_TTL_MS;
  const currentScratchId = store.getCurrentScratchId();
  // Only protect the live current scratch — a tombstoned row whose ID still
  // matches `currentScratchId` is the exact crash-recovery case (tombstone
  // succeeded, `clearCurrentScratch` didn't), and the sweep must finish it.
  const candidates = store
    .getStaleScratchCandidates(cutoff)
    .filter((row) => !(row.id === currentScratchId && row.deletedAt == null));
  result.candidates = candidates.length;

  for (const row of candidates) {
    // Lesson #3721: never treat a falsy `lastOpened` on a live row as
    // maximally stale — skip rather than tombstone. Tombstoned rows aren't
    // subject to this check; they've already been chosen for deletion.
    if (!row.lastOpened && row.deletedAt == null) continue;

    if (row.deletedAt == null) {
      // Under disk-pressure write suppression (#9537), skip the tombstone DB
      // write but still fall through to the `fs.rm` below — reclaiming the
      // directory is the whole point of running cleanup while suppressed.
      // `getWritesSuppressed()` is re-read here (not cached at function entry)
      // because the async `fs.rm` of a prior candidate yields the event loop,
      // letting the disk monitor flip the flag mid-sweep. The live row stays a
      // candidate and is finished on a later sweep once writes resume.
      if (!getWritesSuppressed()) {
        try {
          store.tombstoneScratch(row.id, now);
          result.tombstoned += 1;
        } catch (error) {
          logError(`[ScratchCleanup] Failed to tombstone scratch ${row.id}`, error);
          continue;
        }
      }
    }

    const dir = getScratchDir(getScratchesRoot(), row.id);
    if (dir) {
      try {
        await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch (error) {
        result.directoriesFailed += 1;
        logError(`[ScratchCleanup] Failed to remove scratch directory ${dir}`, error);
        continue;
      }
    }

    result.directoriesRemoved += 1;
    // Same suppression guard as the tombstone above: the directory delete has
    // already freed the disk space, so skip the hard-delete DB write while
    // suppressed. The row is reclaimed on a later sweep once writes resume.
    if (getWritesSuppressed()) continue;
    try {
      store.hardDeleteScratch(row.id);
      if (row.id === currentScratchId) {
        store.clearCurrentScratch();
      }
    } catch (error) {
      logError(`[ScratchCleanup] Failed to hard-delete scratch ${row.id}`, error);
    }
  }

  if (result.tombstoned > 0 || result.directoriesRemoved > 0 || result.directoriesFailed > 0) {
    logInfo(
      `[ScratchCleanup] sweep complete: ${result.tombstoned} tombstoned, ` +
        `${result.directoriesRemoved} directories removed, ${result.directoriesFailed} failed`
    );
  }

  return result;
}

/**
 * Fire-and-forget entry point invoked from `electron/main.ts` at startup.
 * Errors are caught and logged; never propagate to the boot path.
 */
export function initializeScratchCleanup(): void {
  runScratchCleanup().catch((err) => {
    logError("[ScratchCleanup] sweep threw", err);
  });
}
