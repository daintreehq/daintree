import os from "os";
import type { ResourceProfile } from "../../shared/types/resourceProfile.js";

// Single source of truth for the WebGL-context budget (#11192).
//
// Chromium hard-caps active WebGL contexts per renderer process (default 16),
// silently evicting the oldest on overflow (webglcontextlost). Daintree raises
// that ceiling via the `max-active-webgl-contexts` command-line switch in
// electron/setup/environment.ts, scaled by system RAM. The whole-fleet
// WebGL->DOM flip thresholds (per resource profile) must track that raised
// ceiling — otherwise the fleet force-flips to the slower DOM renderer while
// the GPU still has room. Deriving both the switch value and the per-profile
// thresholds from this module keeps them from drifting apart.
//
// This module depends only on `node:os` (plus a type-only import) so
// environment.ts can pull `getMaxWebGLContextCeiling` into its early-boot path
// without dragging in the shared resource-profile table or anything heavier.

const EIGHT_GIB = 8 * 1024 ** 3;
const SIXTEEN_GIB = 16 * 1024 ** 3;

/**
 * Effective per-renderer active-WebGL-context ceiling, RAM-tiered on the same
 * breakpoints as the GPU tile-memory budget in environment.ts:
 * ≤8 GiB → 24, >8 and ≤16 GiB → 28, >16 GiB → 32. Each xterm WebGL context is
 * small (no 3D geometry, no MSAA) so this headroom is safe within the raised
 * tile budget. `totalMemBytes` defaults to `os.totalmem()` at call time (never
 * at module load) and is injectable for deterministic tests.
 */
export function getMaxWebGLContextCeiling(totalMemBytes: number = os.totalmem()): number {
  if (totalMemBytes <= EIGHT_GIB) return 24;
  if (totalMemBytes <= SIXTEEN_GIB) return 28;
  return 32;
}

/**
 * Per-profile fractions of the ceiling for the whole-fleet WebGL→DOM flip.
 * These reproduce the ratios the old flat thresholds already encoded against
 * the previous 16-context cap (performance 14/16 upper·12/16 lower, balanced
 * 12/16·10/16, efficiency 8/16·6/16), so the tuned headroom shape and the
 * profile ordering (efficiency < balanced < performance) are preserved as the
 * ceiling scales. The gap between upper and lower is the hysteresis band and
 * grows proportionally with the ceiling.
 */
export const WEBGL_THRESHOLD_RATIOS: Record<ResourceProfile, { upper: number; lower: number }> = {
  performance: { upper: 14 / 16, lower: 12 / 16 },
  balanced: { upper: 12 / 16, lower: 10 / 16 },
  efficiency: { upper: 8 / 16, lower: 6 / 16 },
};

// Minimum slots kept free below the ceiling for non-terminal in-renderer WebGL
// consumers (browser / dev-preview panels, devtools). Matches the tightest
// headroom the old policy left (performance held 14 of 16).
const MIN_HEADROOM = 2;
// Minimum hysteresis gap so a single panel toggling at the boundary cannot flap
// the whole fleet. Matches the old flat gap of 2.
const MIN_HYSTERESIS_GAP = 2;

export interface WebglThresholds {
  webglUpperThreshold: number;
  webglLowerThreshold: number;
}

/**
 * Resolve the whole-fleet flip thresholds for a profile against the effective
 * RAM-tiered ceiling. The ratio-derived values are rounded, then clamped
 * defensively so the result always leaves headroom below the ceiling and a
 * real hysteresis gap. The clamps never bind at the supported 24/28/32
 * ceilings — they only guard against a degenerate (very small) ceiling.
 */
export function resolveWebglThresholds(
  profile: ResourceProfile,
  ceiling: number = getMaxWebGLContextCeiling()
): WebglThresholds {
  const ratios = WEBGL_THRESHOLD_RATIOS[profile];
  const upper = Math.max(1, Math.min(Math.round(ceiling * ratios.upper), ceiling - MIN_HEADROOM));
  const lower = Math.max(
    0,
    Math.min(Math.round(ceiling * ratios.lower), upper - MIN_HYSTERESIS_GAP)
  );
  return { webglUpperThreshold: upper, webglLowerThreshold: lower };
}
