/**
 * Startup + periodic auto-cleanup for stale scratch workspaces.
 *
 * A scratch becomes a cleanup candidate once its `lastOpened` predates
 * `now - SCRATCH_CLEANUP_TTL_MS`. Cleanup is a two-phase, tombstone-first
 * process spread across sweeps so that no directory is destroyed in the same
 * sweep it is first found stale, and so a scratch that still holds live work is
 * never touched:
 *
 *   Phase 1 (reap): rows tombstoned on a PRIOR sweep whose grace window
 *   (`SCRATCH_CLEANUP_GRACE_MS`) has elapsed have their directory removed and
 *   the row hard-deleted. This is also the recovery path for a `removeScratch`
 *   that crashed between tombstone and `fs.rm`.
 *
 *   Phase 2 (inspect + tombstone): each live stale candidate is inspected for
 *   signs of live work — uncommitted/untracked/unpushed git state, or recent
 *   external filesystem activity. Only a scratch that positively proves
 *   abandoned is tombstoned (its DB row marked `deleted_at`, hiding it from
 *   every renderer-facing query). Its directory is NOT removed here; that waits
 *   for a later sweep's reap phase past the grace window. Any uncertainty (git
 *   error/timeout, unreadable directory) fails closed => the scratch is left
 *   alone. Inspection is read-only.
 *
 * Tombstoning is unconditional with respect to disk-pressure write suppression
 * (#6271/#9537): the row must leave `getAllScratches()` the instant it is
 * chosen for deletion so the switcher never lists a scratch whose directory is
 * about to vanish. Only the reap phase's hard-delete is deferred while writes
 * are suppressed — the directory removal still runs, reclaiming space.
 *
 * The current scratch (per `app_state.currentScratchId`) is always excluded
 * from Phase 2 so an actively-open workspace can never disappear under the
 * user. A tombstoned row whose ID still matches `currentScratchId` is the
 * crash-recovery case and IS reaped.
 *
 * Known limitations (documented, not silently overstated): a clean git repo
 * holding only local unpushed commits with no configured upstream still looks
 * abandoned; the activity scan reads only top-level entry mtimes and does not
 * detect a content-only edit deep under an otherwise-old top-level directory.
 *
 * Mirrors the fire-and-forget pattern of `initializeTrashedPidCleanup`: never
 * awaited by production callers, never throws — a cleanup failure must not
 * block startup.
 */
import fs from "fs/promises";
import type { Dirent } from "node:fs";
import path from "path";
import PQueue from "p-queue";
import { scratchStore as defaultScratchStore } from "./ScratchStore.js";
import type { ScratchRow } from "./persistence/schema.js";
import { logError, logInfo } from "../utils/logger.js";
import {
  SCRATCH_CLEANUP_TTL_MS,
  SCRATCH_CLEANUP_GRACE_MS,
} from "../../shared/config/scratchCleanup.js";
import { getScratchDir, getScratchesRoot } from "./scratchStorePaths.js";
import { getWritesSuppressed } from "./diskPressureState.js";
import { createHardenedGit, GIT_BLOCK_TIMEOUT_MS } from "../utils/hardenedGit.js";

export interface ScratchCleanupResult {
  /** Total rows examined as candidates (live-stale plus already-tombstoned). */
  candidates: number;
  /** Rows tombstoned during this sweep (excludes pre-tombstoned rows). */
  tombstoned: number;
  /** Directories successfully removed (or already absent) during the reap phase. */
  directoriesRemoved: number;
  /** Directories that failed to remove (logged, not rethrown). */
  directoriesFailed: number;
  /** Live stale candidates left alone because inspection found live work or
   * could not prove the directory abandoned. */
  protectedCount: number;
}

/**
 * Outcome of inspecting one candidate directory. A discriminated union rather
 * than a bare boolean so a mis-wired call site cannot silently invert into
 * "delete" — the sweep only ever acts on an explicit `"safe"` disposition.
 */
export type ScratchCleanupSafetyDecision =
  { disposition: "safe"; reason: string } | { disposition: "protect"; reason: string };

/**
 * Injectable per-candidate safety classifier. Given the directory that would be
 * deleted, the activity cutoff (mtimes newer than this count as live), and an
 * abort signal, returns whether the directory is safe to tombstone. Injectable
 * so the sweep's orchestration can be tested without spawning real git.
 */
export type ScratchCleanupSafetyCheck = (
  directory: string,
  activityCutoffMs: number,
  signal: AbortSignal
) => Promise<ScratchCleanupSafetyDecision>;

interface InspectionOutcome {
  row: ScratchRow;
  decision: ScratchCleanupSafetyDecision;
}

/**
 * The slice of `ScratchStore` the sweep depends on. Declared as a narrow
 * interface (which `ScratchStore` satisfies structurally) so tests can inject a
 * lightweight fake without casting through the full store type.
 */
export interface ScratchCleanupStore {
  getCurrentScratchId(): string | null;
  getStaleScratchCandidates(cutoffMs: number): ScratchRow[];
  tombstoneScratch(scratchId: string, deletedAt: number): void;
  hardDeleteScratch(scratchId: string): void;
  clearCurrentScratch(): void;
}

/** Top-level directory names whose recency never counts as live work. */
const ACTIVITY_SCAN_IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".cache"]);

/**
 * Bound concurrent git-status spawns across ALL overlapping sweeps (boot,
 * periodic, disk-critical). Module-scoped on purpose: a per-run queue would let
 * each of the three invocations spawn its own three git processes. Mirrors
 * `WorkspaceService`'s shared poll queue.
 */
const inspectionQueue = new PQueue({ concurrency: 3 });

function safe(reason: string): ScratchCleanupSafetyDecision {
  return { disposition: "safe", reason };
}

function protect(reason: string): ScratchCleanupSafetyDecision {
  return { disposition: "protect", reason };
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/**
 * Default safety classifier. Fails CLOSED — every path that cannot positively
 * prove the directory abandoned returns `protect`, so uncertainty never leads
 * to deletion (issue #11353).
 */
export async function inspectScratchForCleanup(
  directory: string,
  activityCutoffMs: number,
  signal: AbortSignal
): Promise<ScratchCleanupSafetyDecision> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    // A directory that has already vanished has nothing left to protect.
    if (isNodeError(error) && error.code === "ENOENT") return safe("missing-directory");
    // Any other read failure (EACCES, EIO, …) is uncertainty => protect.
    return protect("readdir-failed");
  }

  // Only treat this as a git repo when it owns a top-level `.git` entry, so an
  // ancestor repo (via `checkIsRepo`'s upward walk) can't misclassify a plain
  // scratch, and non-git scratches never pay for a git spawn.
  if (entries.some((entry) => entry.name === ".git")) {
    try {
      const git = await createHardenedGit(directory, signal);
      if (await git.checkIsRepo()) {
        const status = await git.status();
        // Uncommitted or untracked changes are exactly the "work" #11353 exists
        // to protect; ahead-of-upstream commits are unpushed local work.
        if (status.files.length > 0) return protect("dirty-git");
        if (status.ahead > 0) return protect("unpushed-commits");
        return safe("clean-git");
      }
    } catch {
      // Git spawn failed, timed out, or the signal aborted — cannot prove
      // abandonment, so protect.
      return protect("git-check-failed");
    }
  }

  // Non-git scratch: fall back to a bounded top-level mtime scan for signs of
  // recent external activity. Directories that hold generated output only are
  // skipped so a stale `node_modules`/`dist` can't keep a dead scratch alive.
  for (const entry of entries) {
    if (signal.aborted) return protect("inspection-aborted");
    if (entry.isDirectory() && ACTIVITY_SCAN_IGNORED_DIRS.has(entry.name)) continue;
    try {
      const stat = await fs.lstat(path.join(directory, entry.name));
      if (stat.mtimeMs > activityCutoffMs) return protect("recent-activity");
    } catch {
      // A per-entry stat failure is uncertainty about that entry => protect.
      return protect("stat-failed");
    }
  }
  return safe("inactive-non-git");
}

/**
 * Stale-scratch sweep — see the module header for the two-phase design. Returns
 * a summary for tests; production callers use {@link initializeScratchCleanup}
 * which discards the result. `safetyCheck` is injectable so orchestration tests
 * never spawn real git.
 */
export async function runScratchCleanup(
  now: number = Date.now(),
  store: ScratchCleanupStore = defaultScratchStore,
  safetyCheck: ScratchCleanupSafetyCheck = inspectScratchForCleanup
): Promise<ScratchCleanupResult> {
  const result: ScratchCleanupResult = {
    candidates: 0,
    tombstoned: 0,
    directoriesRemoved: 0,
    directoriesFailed: 0,
    protectedCount: 0,
  };

  const staleCutoff = now - SCRATCH_CLEANUP_TTL_MS;
  const reapCutoff = now - SCRATCH_CLEANUP_GRACE_MS;
  const root = getScratchesRoot();
  const currentScratchId = store.getCurrentScratchId();

  const candidates = store.getStaleScratchCandidates(staleCutoff);
  result.candidates = candidates.length;

  // Rows tombstoned on a prior sweep, past the grace window — ready to reap.
  const readyToReap = candidates.filter(
    (row) => row.deletedAt != null && row.deletedAt < reapCutoff
  );
  // Live stale rows eligible for inspection. The current scratch is excluded so
  // an open workspace can never be tombstoned. Lesson #3721: a falsy
  // `lastOpened` on a live row is missing data, not maximal staleness — skip it.
  const liveStale = candidates.filter(
    (row) => row.deletedAt == null && !!row.lastOpened && row.id !== currentScratchId
  );

  // Phase 1: reclaim directories tombstoned on a prior sweep past the grace
  // window (and finish any `removeScratch` that crashed mid-flight). Reaping
  // runs first so a disk-critical sweep can promptly free mature tombstones.
  for (const row of readyToReap) {
    const dir = getScratchDir(root, row.id);
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
    // The directory delete already freed the disk space, so the hard-delete DB
    // write is safe to defer while writes are suppressed (#9537). The row stays
    // tombstoned (already hidden) and is finished on a later sweep once writes
    // resume. Re-read the flag here — a prior candidate's async `fs.rm` yields
    // the event loop, letting the disk monitor flip it mid-sweep.
    if (getWritesSuppressed()) continue;
    try {
      store.hardDeleteScratch(row.id);
      if (row.id === currentScratchId) store.clearCurrentScratch();
    } catch (error) {
      logError(`[ScratchCleanup] Failed to hard-delete scratch ${row.id}`, error);
    }
  }

  // Phase 2: inspect live stale candidates for signs of live work, bounded to
  // three concurrent git spawns via the shared queue. Inspection is read-only
  // and fails closed.
  const inspected = (
    await Promise.all(
      liveStale.map((row) =>
        inspectionQueue.add(async (): Promise<InspectionOutcome> => {
          const dir = getScratchDir(root, row.id);
          if (!dir) return { row, decision: protect("invalid-scratch-dir") };
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), GIT_BLOCK_TIMEOUT_MS);
          try {
            const decision = await safetyCheck(dir, staleCutoff, controller.signal);
            return { row, decision };
          } catch (error) {
            logError(`[ScratchCleanup] Safety inspection threw for ${row.id}`, error);
            return { row, decision: protect("inspection-error") };
          } finally {
            clearTimeout(timer);
          }
        })
      )
    )
  ).filter((outcome): outcome is InspectionOutcome => outcome != null);

  // Re-validate against a fresh snapshot: an in-app open during the async
  // inspection updates `lastOpened` and the current pointer, and must win over
  // a tombstone decision made moments earlier.
  const stillStale = new Set(
    store
      .getStaleScratchCandidates(staleCutoff)
      .filter((row) => row.deletedAt == null && !!row.lastOpened && row.lastOpened < staleCutoff)
      .map((row) => row.id)
  );
  const currentAfterInspect = store.getCurrentScratchId();

  for (const { row, decision } of inspected) {
    if (decision.disposition !== "safe") {
      result.protectedCount += 1;
      continue;
    }
    if (row.id === currentAfterInspect || !stillStale.has(row.id)) continue;
    try {
      // Unconditional with respect to disk-pressure suppression: the row must
      // leave getAllScratches() the instant it is chosen for deletion so the
      // switcher never lists a directory that is about to be reaped (#6271/#9537).
      store.tombstoneScratch(row.id, now);
      result.tombstoned += 1;
    } catch (error) {
      logError(`[ScratchCleanup] Failed to tombstone scratch ${row.id}`, error);
    }
  }

  if (
    result.tombstoned > 0 ||
    result.directoriesRemoved > 0 ||
    result.directoriesFailed > 0 ||
    result.protectedCount > 0
  ) {
    logInfo(
      `[ScratchCleanup] sweep complete: ${result.tombstoned} tombstoned, ` +
        `${result.directoriesRemoved} directories removed, ${result.directoriesFailed} failed, ` +
        `${result.protectedCount} protected`
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
