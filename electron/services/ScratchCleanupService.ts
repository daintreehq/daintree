/**
 * Startup auto-cleanup for stale scratch workspaces.
 *
 * A scratch whose `lastOpened` predates `now - SCRATCH_CLEANUP_TTL_MS` has
 * its filesystem directory removed and its DB row tombstoned (`deleted_at`
 * set). Tombstoned rows are filtered out of every renderer-facing query in
 * `ScratchStore`, so the renderer never sees them again. The current scratch
 * (per `app_state.currentScratchId`) is always excluded so an actively-open
 * workspace can never disappear under the user.
 *
 * Tombstoning is one-way — orphaned directories left by a failed `fs.rm`
 * stay on disk (logged, not retried). Accepting that orphan rate is
 * deliberate: the alternative (re-sweeping tombstoned rows) would require a
 * second query and could surprise users who manually re-create folders at
 * the same path.
 *
 * Mirrors the fire-and-forget pattern of `initializeTrashedPidCleanup`:
 * called once at app boot, never awaited, never throws — a cleanup failure
 * must not block startup.
 */
import fs from "fs/promises";
import { existsSync } from "fs";
import { scratchStore as defaultScratchStore } from "./ScratchStore.js";
import { logError, logInfo } from "../utils/logger.js";
import { SCRATCH_CLEANUP_TTL_MS } from "../../shared/config/scratchCleanup.js";

export { SCRATCH_CLEANUP_TTL_MS as SCRATCH_TTL_MS } from "../../shared/config/scratchCleanup.js";

export interface ScratchCleanupResult {
  /** Total rows examined as candidates (predate cutoff, not yet tombstoned). */
  candidates: number;
  /** Rows actually tombstoned during this sweep. */
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
  const candidates = store
    .getStaleScratchCandidates(cutoff)
    .filter((row) => row.id !== currentScratchId);
  result.candidates = candidates.length;

  for (const row of candidates) {
    // Lesson #3721: never treat a falsy `lastOpened` as maximally stale —
    // skip rather than tombstone. The schema declares NOT NULL, but a
    // hand-edited DB or a future migration could relax that, and we'd rather
    // skip a row than nuke it on bad data.
    if (!row.lastOpened) continue;

    try {
      store.tombstoneScratch(row.id, now);
      result.tombstoned += 1;
    } catch (error) {
      logError(`[ScratchCleanup] Failed to tombstone scratch ${row.id}`, error);
      continue;
    }

    if (!row.path) {
      result.directoriesRemoved += 1;
      continue;
    }

    if (!existsSync(row.path)) {
      result.directoriesRemoved += 1;
      continue;
    }

    try {
      await fs.rm(row.path, { recursive: true, force: true });
      result.directoriesRemoved += 1;
    } catch (error) {
      result.directoriesFailed += 1;
      logError(`[ScratchCleanup] Failed to remove scratch directory ${row.path}`, error);
    }
  }

  if (result.tombstoned > 0 || result.directoriesFailed > 0) {
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
