/**
 * Whether `SystemMemoryPressureMonitor` currently confirms kernel-plus-swap
 * pressure (#13223), for the cached-view reclaim ladder to read. Leaf module
 * with no runtime imports: the monitor is created in a deferred task long after
 * every ProjectViewManager exists, so the managers read this rather than hold
 * a reference to the monitor.
 *
 * A confirmation ages out on its own. The monitor rides the app-metrics poll,
 * which stretches to 150s while focus-throttled and stops entirely on suspend,
 * so a verdict nobody has refreshed for longer than that is no evidence.
 */
export const SWAP_PRESSURE_STALE_MS = 180_000;

let confirmedAt: number | null = null;

export function recordSwapPressure(confirmed: boolean, now: number = Date.now()): void {
  confirmedAt = confirmed ? now : null;
}

/** A clock that stepped backwards is no evidence the verdict is still fresh. */
export function isSwapPressureConfirmed(now: number = Date.now()): boolean {
  if (confirmedAt === null) return false;
  const ageMs = now - confirmedAt;
  if (ageMs >= 0 && ageMs <= SWAP_PRESSURE_STALE_MS) return true;
  confirmedAt = null;
  return false;
}
