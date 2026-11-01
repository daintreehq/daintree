// Pure launch classification for the OS job that runs due schedules (#15989).
// Read by main.ts at module load and by the scheduler, so it stays free of
// Electron and store imports.

/**
 * An OS job asking Daintree to run what's due: a Daintree already running
 * looks at its schedules at once; otherwise this launch starts the backend
 * with no window to run them. A switch, so it's never read as a path to open.
 */
export const RUN_DUE_SCHEDULES_FLAG = "--run-due-schedules";

/** A launch with the flag on a platform that can't start windowless for it. */
export const DUE_SCHEDULES_UNSUPPORTED_EXIT_CODE = 4;

export function isDueScheduleCheckRequested(argv: readonly string[]): boolean {
  return argv.includes(RUN_DUE_SCHEDULES_FLAG);
}

/**
 * Whether this launch starts with no window to run due schedules. macOS and
 * Linux only for now: Windows' windowless start is #15992, and until then a
 * launch there with the flag exits rather than open the app.
 */
export function startsWindowlessForDueSchedules(input: {
  platform: NodeJS.Platform;
  argv: readonly string[];
}): boolean {
  return input.platform !== "win32" && isDueScheduleCheckRequested(input.argv);
}
