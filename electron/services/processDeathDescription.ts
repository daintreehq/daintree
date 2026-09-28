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

export function isSignalKill(reason: string): boolean {
  return reason === "killed";
}

export function describeProcessDeath(
  reason: string,
  exitCode: number,
  platform: NodeJS.Platform = process.platform
): string {
  switch (reason) {
    case "killed": {
      if (platform === "win32") {
        return `was terminated from outside the process (exit code ${exitCode}), not a crash`;
      }
      const signal = POSIX_SIGNAL_NAMES[exitCode] ?? `signal ${exitCode}`;
      return `was terminated by ${signal} from outside the process, not a crash`;
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
