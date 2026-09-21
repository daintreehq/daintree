import { app } from "electron";
import { logDebug, logInfo, logWarn } from "../utils/logger.js";
import {
  isCrashRecoveryInspectionComplete,
  pruneCrashDumps,
  type CrashDumpRetentionResult,
} from "../utils/crashDumpRetention.js";

let inFlight: Promise<CrashDumpRetentionResult | null> | null = null;

/**
 * Prunes Crashpad's local native dumps under `app.getPath("crashDumps")` to
 * `NATIVE_CRASH_DUMP_RETENTION`. Startup, the periodic sweep, and the
 * disk-pressure edge share one in-flight pass. Resolves `null` when skipped
 * or failed; never rejects, so no trigger can take down startup.
 */
export function requestNativeCrashDumpPrune(): Promise<CrashDumpRetentionResult | null> {
  if (!inFlight) {
    inFlight = runPrune().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function runPrune(): Promise<CrashDumpRetentionResult | null> {
  if (!isCrashRecoveryInspectionComplete()) {
    logWarn("[CrashDumpRetention] Skipped: crash recovery has not inspected native dumps yet");
    return null;
  }
  try {
    const result = await pruneCrashDumps(app.getPath("crashDumps"));
    logResult(result);
    return result;
  } catch (err) {
    logWarn("[CrashDumpRetention] Native crash-dump prune failed", {
      code: (err as NodeJS.ErrnoException | null)?.code ?? "UNKNOWN",
    });
    return null;
  }
}

// Aggregates only — never paths or file names, which can carry the username.
function logResult(result: CrashDumpRetentionResult): void {
  const summary = {
    count: result.count,
    bytes: result.bytes,
    oldestAgeHours:
      result.oldestAgeMs === null ? null : Math.round(result.oldestAgeMs / (60 * 60 * 1000)),
    inProgressCount: result.inProgressCount,
    inProgressBytes: result.inProgressBytes,
    deletedCount: result.deletedCount,
    deletedBytes: result.deletedBytes,
    protectedCount: result.protectedCount,
    deletionSupported: result.deletionSupported,
  };
  if (Object.keys(result.failures).length > 0) {
    logWarn("[CrashDumpRetention] Native crash-dump prune finished with failures", {
      ...summary,
      failures: result.failures,
    });
  } else if (result.count === 0 && result.inProgressCount === 0) {
    logDebug("[CrashDumpRetention] No native crash dumps on disk");
  } else {
    logInfo("[CrashDumpRetention] Native crash dumps", summary);
  }
}

export function _resetCrashDumpRetentionForTests(): void {
  inFlight = null;
}
