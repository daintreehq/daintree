import { defineIpcNamespace, opValidated } from "../define.js";
import { checkRateLimit } from "../utils.js";
import { FILE_WATCH_METHOD_CHANNELS } from "./fileWatch.preload.js";
import { FileWatchFingerprintPayloadSchema } from "../../schemas/ipc.js";
import { fingerprintPaths } from "../../services/pathFingerprint.js";
import type {
  FileWatchFingerprintPayload,
  FileWatchFingerprintResult,
} from "../../../shared/types/ipc/fileWatch.js";

/**
 * Sized against the polling cadence the file surfaces actually use, not a
 * guess. Each visible pane with no worktree behind it samples roughly every two
 * seconds, so a window showing a dozen such panes sits near 60 calls per ten
 * seconds. The headroom above that absorbs a burst of panes becoming visible at
 * once (a project switch revealing a saved layout) without letting a refresh
 * loop run unbounded. The budget is shared across windows, matching the other
 * file-browser limits.
 */
const FINGERPRINT_MAX_CALLS = 400;
const FINGERPRINT_WINDOW_MS = 10_000;

export function buildFileWatchNamespace() {
  const handleFingerprint = async (
    payload: FileWatchFingerprintPayload
  ): Promise<FileWatchFingerprintResult> => {
    checkRateLimit(
      FILE_WATCH_METHOD_CHANNELS.fingerprint,
      FINGERPRINT_MAX_CALLS,
      FINGERPRINT_WINDOW_MS
    );

    // Filesystem trouble never throws from here: the caller polls on a timer and
    // compares successive answers, so an unreadable root or a path that escaped
    // it comes back as `null` fingerprints rather than an error the renderer
    // would have to tell apart from "nothing changed". Schema validation and the
    // rate limiter above still reject — those are transport failures, and the
    // caller treats them as a skipped sample.
    return fingerprintPaths(payload.rootPath, payload.paths);
  };

  return defineIpcNamespace({
    name: "fileWatch",
    ops: {
      fingerprint: opValidated(
        FILE_WATCH_METHOD_CHANNELS.fingerprint,
        FileWatchFingerprintPayloadSchema,
        handleFingerprint
      ),
    },
  });
}

export function registerFileWatchHandlers(): () => void {
  return buildFileWatchNamespace().register();
}
