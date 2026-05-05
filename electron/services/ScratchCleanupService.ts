/**
 * Startup auto-cleanup for stale scratch workspaces.
 *
 * A scratch whose `lastOpened` predates `now - SCRATCH_TTL_MS` has its
 * filesystem directory removed; the SQLite row is preserved as a tombstone
 * (`deleted_at` set) so a partial delete left by a crash can be retried
 * idempotently on the next boot. Tombstoned rows are filtered out of every
 * renderer-facing query in `ScratchStore`, so the renderer never sees them.
 *
 * Mirrors the fire-and-forget pattern of `initializeTrashedPidCleanup`:
 * called once at app boot, never awaited, never throws — a cleanup failure
 * must not block startup.
 */
import fs from "fs/promises";
import { existsSync } from "fs";
import { scratchStore as defaultScratchStore } from "./ScratchStore.js";
import { logError, logInfo } from "../utils/logger.js";

export const SCRATCH_TTL_DAYS = 30;
export const SCRATCH_TTL_MS = SCRATCH_TTL_DAYS * 24 * 60 * 60 * 1000;

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

  const cutoff = now - SCRATCH_TTL_MS;
  const candidates = store.getStaleScratchCandidates(cutoff);
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
