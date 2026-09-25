/**
 * Bring the rest of the window set back after a single crash (#12801).
 *
 * A recovery launch opens one window on purpose: rebuilding the fleet that just
 * crashed is how one bad exit becomes a loop (#11492). That stays true for safe
 * mode and repeated crashes. After one crash, though, a user who restores the
 * session (from the dialog, or automatically) expects every window back — not a
 * single window now and the rest on the next clean relaunch.
 *
 * The restore runs behind the recovery window, through the same paced queue a
 * cold launch uses (#12800), because right after an out-of-memory crash is
 * exactly when opening every window at once hurts most.
 */

import type { OpenWindowRecord } from "../services/persistence/windowManifest.js";
import { restoreWindowFleet, type RestoreWindowFleetDeps } from "./windowRestore.js";

/**
 * The crash counts that still get the full window set. Matches the renderer's
 * own loop line (`crashCount >= 2` is a loop in the dialog and disables auto
 * restore); safe mode, at the guard's higher threshold, is excluded separately.
 */
export function isFleetRestoreEligible(guard: {
  isSafeMode: () => boolean;
  getCrashCount: () => number;
}): boolean {
  return !guard.isSafeMode() && guard.getCrashCount() < 2;
}

export interface CrashFleetRestoreDeps extends Pick<
  RestoreWindowFleetDeps,
  "createWindow" | "suppressSaves" | "resumeSaves" | "onBackgroundWindowFailed" | "isProjectOwned"
> {
  /**
   * The startup restore. Awaited first: save suppression is a flag, not a
   * counter, so two restores overlapping would release it early.
   */
  startupRestore: Promise<unknown>;
  /** Resolves once the window that asked for recovery has hydrated, or gave up. */
  waitForRequesterHydrated: () => Promise<unknown>;
  readManifest: () => { hadManifest: boolean; records: OpenWindowRecord[] };
  /** The user's session-restore setting — whether windows get their background projects. */
  restoreLiveProjects: boolean;
  /** Lifts the recovery launch's read-only manifest hold. */
  enableSaves: () => void;
  isShuttingDown: () => boolean;
}

export async function restoreFleetAfterCrash(deps: CrashFleetRestoreDeps): Promise<void> {
  // Whatever became of the startup window, it is no longer restoring.
  await deps.startupRestore.catch(() => {});
  // The recovery window is the one the user is looking at; let it restore its
  // panels before the rest of the fleet competes with it.
  await deps.waitForRequesterHydrated();
  if (deps.isShuttingDown()) return;

  const { hadManifest, records } = deps.readManifest();
  if (!hadManifest) return;

  // Picker windows have nothing to restore, and the recovery window already
  // gives the user one.
  const fleetRecords = records
    .filter((record) => record.projectId !== null)
    .map((record) => (deps.restoreLiveProjects ? record : { projectId: record.projectId }));

  await restoreWindowFleet({
    records: fleetRecords,
    hadManifest,
    fallbackProjectId: undefined,
    primaryAlreadyOpen: true,
    createWindow: deps.createWindow,
    suppressSaves: deps.suppressSaves,
    resumeSaves: (restoredCleanly) => {
      // Only a fleet that fully came back may overwrite the manifest. Anything
      // less leaves the launch read-only, so the next clean launch still has
      // the complete set on disk.
      const writable = restoredCleanly && !deps.isShuttingDown();
      if (writable) deps.enableSaves();
      deps.resumeSaves(writable);
    },
    onBackgroundWindowFailed: deps.onBackgroundWindowFailed,
    isProjectOwned: deps.isProjectOwned,
    isShuttingDown: deps.isShuttingDown,
  });
}

type CrashFleetRestorer = (requesterWebContentsId: number) => Promise<void>;

let restorer: CrashFleetRestorer | null = null;
let requested = false;

/** Installed by main.ts on a recovery launch. */
export function setCrashFleetRestorer(fn: CrashFleetRestorer | null): void {
  restorer = fn;
}

/**
 * Start the fleet restore without waiting for it. The renderer awaits the
 * recovery IPC before it hydrates, and the restore waits for that hydration, so
 * awaiting here would stall both until the timeout.
 *
 * Once per process: a view re-fires its boot after LRU eviction (#10810), and
 * a second pass must not start while the first is still pacing windows.
 */
export function requestCrashFleetRestore(requesterWebContentsId: number): void {
  if (requested || !restorer) return;
  requested = true;
  const run = restorer;
  void Promise.resolve()
    .then(() => run(requesterWebContentsId))
    .catch((error: unknown) => {
      console.error("[CrashRecovery] Restoring the window set failed:", error);
    });
}

/** Test-only: the module singleton outlives tests that don't reset modules. */
export function resetCrashFleetRestoreForTests(): void {
  restorer = null;
  requested = false;
}
