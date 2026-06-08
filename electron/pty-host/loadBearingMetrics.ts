/**
 * Reliabilty-metric types whose wire emission is required for UI correctness
 * (recovery affordances, Tier-3 escalations) and therefore MUST bypass the
 * `DAINTREE_TERMINAL_METRICS` opt-in flag. The flag is preserved for the
 * high-volume, per-tick gauges (throughput-rate, queue-depth-gauge,
 * pending-bytes-gauge, data-loss-count) that exist purely for diagnostic
 * telemetry — splitting the two keeps the user-facing recovery surfaces
 * live in production while leaving diagnostic noise opt-in.
 *
 * Add new metric types here only when the renderer needs them to surface
 * a recovery affordance. Diagnostic-only metrics stay gated.
 */
const LOAD_BEARING_RELIABILITY_METRICS = new Set<string>([
  "pause-start",
  "pause-end",
  "suspend",
  "pause-duration-gauge",
]);

export function isLoadBearingReliabilityMetric(metricType: string): boolean {
  return LOAD_BEARING_RELIABILITY_METRICS.has(metricType);
}
