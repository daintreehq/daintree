// Shared shutdown-timing constants. Kept in a side-effect-free module so the
// signal-handler in appLifecycle.ts (and tests) can import it without pulling
// in the full shutdown.ts service graph (ProjectStore, TelemetryService, etc).
export const CLEANUP_TIMEOUT_MS = 10_000;

// Safety-belt timer for the signal handler. Must outlast the full cleanup chain:
// CLEANUP_TIMEOUT_MS (graceful cleanup race) + 3000ms historical buffer + 2500ms
// worst-case closeTelemetry() (Sentry init-wait cap 500ms + close timeout 2000ms,
// see TelemetryService.ts). Without the telemetry budget the belt could fire
// mid-`await closeTelemetry()` and clobber the intended app.exit(1) on the dirty path.
export const SAFETY_BELT_TIMEOUT_MS = CLEANUP_TIMEOUT_MS + 3_000 + 2_500;
