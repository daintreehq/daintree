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

const CLI_PATH_FLAG = "--cli-path";
const CLI_PATH_PREFIX = `${CLI_PATH_FLAG}=`;

/**
 * The inverse of the argv half of {@link resolveLaunchIntent}: an argv with
 * every targeting token removed, so the launch it describes classifies as
 * `"cold"` (#12320).
 *
 * Lives here, beside the classifier, because the two are one contract read in
 * opposite directions — a token added to `resolveLaunchIntent` and not to this
 * is a token that survives an app-initiated relaunch and quietly reduces the
 * next launch to a single window.
 *
 * Why that matters: `app.relaunch()` hands the child process the parent's argv
 * verbatim, so a session started with `--cli-path` or a Linux "Open in
 * Daintree" still carries it hours later. Restarting after a GPU reset or an
 * app-state reset would then read as "the user launched us to open this one
 * folder" and abandon the fleet they actually had.
 *
 * Deliberately conservative: only the tokens the classifier reads as targeting
 * are dropped, so switches Chromium or the user added — `--disable-gpu`,
 * `--reset-data`, `--e2e` — survive. The in-process `pendingOpenDirPaths` /
 * `pendingOpenFilePaths` queues need no equivalent: they do not cross a
 * process boundary.
 */
export function stripLaunchTargets(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === CLI_PATH_FLAG) {
      // Skip the operand too. Leaving it behind would turn a directory path
      // into a bare positional argument, which is how a `.dntr` plugin archive
      // is recognised — a folder named `x.dntr` would then be routed to the
      // plugin installer on the very launch meant to restore a session.
      i++;
      continue;
    }
    if (arg.startsWith(CLI_PATH_PREFIX)) continue;
    if (arg.startsWith("file://")) continue;
    out.push(arg);
  }
  return out;
}
