// Electron's `child-process-gone` / `render-process-gone` report the raw
// signal number as `exitCode` for a POSIX `killed` reason (15, not 143).
// Never feed a utility `exit` event code (128 + N convention) through this.
const POSIX_SIGNAL_NAMES: Record<number, string> = {
  1: "SIGHUP",
  2: "SIGINT",
  3: "SIGQUIT",
  6: "SIGABRT",
  9: "SIGKILL",
  15: "SIGTERM",
};

/** A signal kill Daintree did not ask for. */
export function isExternalKill(reason: string, intent: string | null | undefined): boolean {
  return reason === "killed" && !intent;
}

function signalName(exitCode: number): string {
  if (POSIX_SIGNAL_NAMES[exitCode]) return POSIX_SIGNAL_NAMES[exitCode];
  return Number.isInteger(exitCode) && exitCode > 0 ? `signal ${exitCode}` : "a signal";
}

export interface DescribeDeathOptions {
  /** Why Daintree terminated the process itself, from processTerminationIntent. */
  intent?: string | null;
  platform?: NodeJS.Platform;
}

export function describeProcessDeath(
  reason: string,
  exitCode: number,
  { intent = null, platform = process.platform }: DescribeDeathOptions = {}
): string {
  switch (reason) {
    case "killed": {
      const how = platform === "win32" ? `(exit code ${exitCode})` : `by ${signalName(exitCode)}`;
      if (intent) return `was terminated ${how} by Daintree (${intent})`;
      return platform === "win32"
        ? `was terminated from outside the process ${how}, not a crash`
        : `was terminated ${how} from outside the process, not a crash`;
    }
    case "crashed":
      return `crashed (exit code ${exitCode})`;
    case "oom":
      return "ran out of memory";
    case "abnormal-exit":
      return `exited abnormally (exit code ${exitCode})`;
    case "launch-failed":
      return `failed to launch (exit code ${exitCode})`;
    case "integrity-failure":
      return "failed a code integrity check";
    case "memory-eviction":
      return "was evicted to reclaim memory";
    default:
      return `exited (reason ${reason}, exit code ${exitCode})`;
  }
}
