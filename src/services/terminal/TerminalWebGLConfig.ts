// Mode-switch thresholds for the WebGL pool. Held in a tiny module isolated
// from xterm imports so the eager renderer chunk can update them (via
// useResourceProfile) without pulling @xterm/addon-webgl into the entry bundle.
//
// The manager runs in one of two modes based on how many terminals currently
// want WebGL. When count exceeds `upperThreshold` it flips to DOM mode and
// releases every active context. When count drops back to `lowerThreshold` or
// below it flips back and re-attaches every want via a rAF-staggered drain.
// The gap between the two values is hysteresis: opening/closing a single panel
// at the boundary will not flap the whole fleet.
//
// Chromium silently evicts the oldest active WebGL context on overflow
// (webglcontextlost), so the upper threshold must stay a headroom margin below
// the effective per-renderer ceiling to leave room for devtools, OffscreenCanvas,
// and any non-terminal WebGL consumer. That ceiling is raised above Chromium's
// default 16 and RAM-tiered (see electron/setup/environment.ts), and the live
// thresholds are resolved from it and pushed in via useResourceProfile (#11192).
//
// Bootstrap defaults only — used until the first resource-profile push/pull
// resolves the real RAM-tiered values on mount. They are NOT the balanced
// profile's source of truth. Sized to the balanced profile at the guaranteed
// minimum ceiling of 24 (resolveWebglThresholds("balanced", 24) → 18/15,
// electron/utils/webglContextBudget.ts): cold start is always balanced (the
// efficiency profile only latches after sustained runtime pressure), and every
// machine gets a ceiling ≥ 24 from the max-active-webgl-contexts switch, so 18
// is always within budget. Keeping these in step with the resolved cold-start
// value stops a large restored fleet from flipping to DOM under the old stale
// 12-upper and then being stranded there — DOM→WebGL only re-flips once the
// count falls back to the lower threshold (#11192).

let upperThreshold = 18;
let lowerThreshold = 15;

export function getWebglUpperThreshold(): number {
  return upperThreshold;
}

export function getWebglLowerThreshold(): number {
  return lowerThreshold;
}

export function setWebglUpperThreshold(n: number): void {
  upperThreshold = Math.max(1, n);
  if (lowerThreshold > upperThreshold) {
    lowerThreshold = upperThreshold;
  }
}

export function setWebglLowerThreshold(n: number): void {
  lowerThreshold = Math.max(0, Math.min(n, upperThreshold));
}

// Atomically set both. Order matters: setting upper first lets the lower
// setter clamp against the new upper without flipping through an intermediate
// invalid state where lower > upper.
export function setWebglThresholds(upper: number, lower: number): void {
  setWebglUpperThreshold(upper);
  setWebglLowerThreshold(lower);
}
