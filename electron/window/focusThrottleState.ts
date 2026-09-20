// Leaf module: zero runtime imports, safe to import from any process-global
// service. Shared between powerMonitor's power-policy polling throttle (the
// only writer) and ResourceProfileService (a concurrent writer of the same
// polling knobs) so a profile transition landing mid-throttle keeps the
// multiplier applied instead of silently un-throttling the pollers
// (last-writer-wins at each consumer).
let throttled = false;
let multiplier = 1;

/**
 * Record the throttle powerMonitor just applied. `throttled` means no user can
 * be looking at a window (blurred, hidden, or locked); the multiplier can be
 * above 1 without it — battery alone slows the pollers while the user watches.
 */
export function setPollThrottle(state: { throttled: boolean; multiplier: number }): void {
  throttled = state.throttled;
  multiplier = state.multiplier;
}

export function isFocusThrottled(): boolean {
  return throttled;
}

export function getFocusThrottlePollMultiplier(): number {
  return multiplier;
}
