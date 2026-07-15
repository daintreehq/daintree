// Shared shutdown-timing constants. Kept in a side-effect-free module so the
// signal-handler in appLifecycle.ts (and tests) can import it without pulling
// in the full shutdown.ts service graph (ProjectStore, TelemetryService, etc).
export const CLEANUP_TIMEOUT_MS = 10_000;

// Bounds the post-cleanup tail — the telemetry flush and perf-trace flush that run
// AFTER the cleanup race resolves and are therefore NOT covered by
// CLEANUP_TIMEOUT_MS. Sized for the worst-case closeTelemetry(): the Sentry
// init-wait cap (500ms) followed by Sentry.close(2000), whose client-drain and
// transport-flush waits each get that timeout in sequence — plus slack for
// contentTracing.stopRecording(), which has no internal cap at all.
export const SHUTDOWN_TAIL_TIMEOUT_MS = 5_000;

// Absolute deadline for an entire shutdown run, backstopping every budget above.
// A run that never settles is not merely slow: once a chain is cleaning, the
// before-quit listener holds off every subsequent quit so nothing can tear the
// process down mid-cleanup. A single unbounded await anywhere in that ~540-line
// chain would therefore leave the app impossible to quit at all. This guarantees
// the terminal action — app.exit(), or the update install — always fires.
export const SHUTDOWN_DEADLINE_MS = CLEANUP_TIMEOUT_MS + SHUTDOWN_TAIL_TIMEOUT_MS + 2_000;

// Safety-belt timer for the signal handler. Must strictly outlast every budget it
// backstops (lesson #7151) — otherwise it fires mid-cleanup and clobbers the exit
// code the chain was about to set.
export const SAFETY_BELT_TIMEOUT_MS = SHUTDOWN_DEADLINE_MS + 3_000;
