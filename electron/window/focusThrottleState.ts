// Leaf module: zero runtime imports, safe to import from any process-global
// service. Shared between powerMonitor's window-focus throttle (the writer)
// and ResourceProfileService (a concurrent writer of the same polling knobs)
// so a profile transition landing mid-blur keeps the throttle multiplier
// applied instead of silently un-throttling the pollers (last-writer-wins at
// each consumer).
export const FOCUS_THROTTLE_MULTIPLIER = 5;

let throttled = false;

export function setFocusThrottled(v: boolean): void {
  throttled = v;
}

export function isFocusThrottled(): boolean {
  return throttled;
}

export function getFocusThrottlePollMultiplier(): number {
  return throttled ? FOCUS_THROTTLE_MULTIPLIER : 1;
}
