// Shared shutdown-timing constants. Kept in a side-effect-free module so the
// signal-handler in appLifecycle.ts (and tests) can import it without pulling
// in the full shutdown.ts service graph (ProjectStore, TelemetryService, etc).
export const CLEANUP_TIMEOUT_MS = 10_000;

// How long the quit chain waits for one project's graceful kill before taking
// whatever the pty-host has streamed back so far. Sits above the host's own
// per-terminal budget (GRACEFUL_KILL_TERMINAL_BUDGET_MS, 3250ms) with room for
// the RPC round-trip, and well inside CLEANUP_TIMEOUT_MS — the chain still has
// a database-worker drain and a maintenance drain to run after it, so this
// cannot grow much without risking the hard timeout and its dirty exit.
//
// Missing it is no longer all-or-nothing: the host reports each terminal as it
// settles and the timeout branch keeps those, so this bounds how long a project
// is waited on, not what survives (#12180).
export const PROJECT_GRACEFUL_KILL_TIMEOUT_MS = 4_000;

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
