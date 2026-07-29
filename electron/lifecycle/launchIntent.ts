/**
 * One answer to "why did this launch happen", read once before the window
 * restore decision (#11492).
 *
 * The signals already existed, scattered: `hasCliPathFlag()` and
 * `extractDirectoryPaths()` in appLifecycle.ts, the pre-window `open-file` /
 * folder queues in setup/environment.ts, and safe-mode / pending-crash on the
 * crash services. Nothing combined them, so the restore loop had nothing to ask
 * — and a `--cli-path` launch or a Finder folder-open would otherwise reopen
 * every window from the last session on top of the one thing the user asked for.
 *
 * Pure, with every signal injected, so the matrix is testable without argv,
 * Electron, or a crash service.
 */

export type LaunchIntent =
  /** Plain cold launch — nothing specific was asked for. Restores the fleet. */
  | "cold"
  /** The user launched us to open a specific thing. One window, that thing. */
  | "targeted"
  /** Safe mode or an unresolved crash. One window, and the manifest is left alone. */
  | "recovery";

export interface LaunchIntentSignals {
  /** Raw process argv (or the second-instance command line). */
  argv: string[];
  /** True when argv carries `--cli-path`, resolvable or not. */
  hasCliPathFlag: (argv: string[]) => boolean;
  /** Folder paths handed over as `file://` URIs (Linux "Open in Daintree"). */
  extractDirectoryPaths: (argv: string[]) => string[];
  /** macOS Finder folder drops queued before a window existed. */
  pendingOpenDirPaths: string[];
  /** `.dntr` plugin archives queued before the installer was activated. */
  pendingOpenFilePaths: string[];
  isSafeMode: boolean;
  hasPendingCrash: boolean;
}

/**
 * Recovery outranks targeted, which outranks cold.
 *
 * Recovery wins outright because restoring a fleet is how one bad launch
 * becomes the crash loop CrashLoopGuard exists to break — and the caller must
 * also stop *writing* the manifest in this mode, or a one-window safe-mode
 * session would overwrite the user's real fleet.
 */
export function resolveLaunchIntent(signals: LaunchIntentSignals): LaunchIntent {
  if (signals.isSafeMode || signals.hasPendingCrash) return "recovery";

  if (signals.hasCliPathFlag(signals.argv)) return "targeted";
  if (signals.extractDirectoryPaths(signals.argv).length > 0) return "targeted";
  if (signals.pendingOpenDirPaths.length > 0) return "targeted";
  // A double-clicked `.dntr` archive is still "I launched you to do this one
  // thing". Treating it as targeted keeps today's single-window behaviour for
  // every launch that names something, which is the conservative default.
  if (signals.pendingOpenFilePaths.length > 0) return "targeted";

  return "cold";
}

/** Only a plain cold launch rebuilds the whole window set. */
export function shouldRestoreWindowFleet(intent: LaunchIntent): boolean {
  return intent === "cold";
}
