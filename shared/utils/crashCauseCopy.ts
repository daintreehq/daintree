import type { CrashCause } from "../types/ipc/crashRecovery.js";

export interface CrashCauseCopy {
  /** Short, sentence-case title (no trailing period). Shown in the recovery dialog headline. */
  title: string;
  /** One-sentence sub-line shown under the dialog headline. Sentence case, may end in a period. */
  description: string;
  /** Short label used in the GitHub report's `**Cause**:` line. Sentence case, no trailing period. */
  reportLabel: string;
}

/**
 * Per-cause copy. Each entry surfaces a single, user-facing interpretation of
 * the heuristic `crashCause` classification in the recovery dialog and the
 * GitHub crash report. The classification itself is heuristic-only and
 * complements the precise `cause: "watchdog-deadlock"` annotation.
 *
 * `unknown` mirrors the V1 log fallback (no cause) so older crash logs read
 * back through `readCrashLog`'s permissive parse and a user who upgrades then
 * re-crashes see the same generic headline.
 */
export const CRASH_CAUSE_COPY: Record<CrashCause, CrashCauseCopy> = {
  "uncaught-exception": {
    title: "Daintree hit an error",
    description: "An unhandled error ended the previous session.",
    reportLabel: "Uncaught JavaScript exception",
  },
  "native-crash": {
    title: "Daintree crashed unexpectedly",
    description: "A native crash ended the previous session, often a segfault or GPU fault.",
    reportLabel: "Native crash (Crashpad minidump)",
  },
  "suspended-then-lost": {
    title: "Daintree didn't come back from sleep",
    description: "Daintree was suspended and never resumed cleanly.",
    reportLabel: "Suspended and never resumed",
  },
  "power-loss": {
    title: "Power was interrupted",
    description: "The system lost power or rebooted while Daintree was running.",
    reportLabel: "Power loss or system reboot",
  },
  "external-kill": {
    title: "Daintree was forced to close",
    description:
      "Daintree was killed by the OS, the system running low on memory, or another external process.",
    reportLabel: "External kill (SIGKILL, OOM killer, or force-quit)",
  },
  unknown: {
    title: "Daintree closed unexpectedly",
    description: "The previous session ended unexpectedly.",
    reportLabel: "Unknown",
  },
};

/** Dialog headline title for the given `crashCause`. Falls back to the V1 generic for `undefined`. */
export function getCrashCauseTitle(cause: CrashCause | undefined): string {
  return CRASH_CAUSE_COPY[cause ?? "unknown"].title;
}

/** Dialog sub-line description for the given `crashCause`. Falls back to the V1 generic for `undefined`. */
export function getCrashCauseDescription(cause: CrashCause | undefined): string {
  return CRASH_CAUSE_COPY[cause ?? "unknown"].description;
}

/** Short label for the GitHub report's `**Cause**:` line. */
export function getCrashCauseReportLabel(cause: CrashCause | undefined): string {
  return CRASH_CAUSE_COPY[cause ?? "unknown"].reportLabel;
}
