/**
 * Whether the kernel reports memory pressure at its critical level right now
 * (#13530), for the paths that add load — agent launches, cold project views,
 * background view restores — to wait on. Leaf module with no runtime imports,
 * for the same reason as `systemSwapPressure.ts`: the monitor is created long
 * after the handlers and managers that read this.
 *
 * Critical latches on a single reading: level 4 is entered quickly and the
 * cost of admitting one more agent there is the app dying. It clears only after
 * {@link KERNEL_CRITICAL_CLEAR_READINGS} consecutive readings below it, since
 * the level falls back unevenly and each release lets new load in.
 *
 * A verdict nobody has refreshed for {@link KERNEL_PRESSURE_STALE_MS} ages out,
 * so a probe that starts failing mid-episode cannot hold launches forever.
 */
export const KERNEL_CRITICAL_CLEAR_READINGS = 2;
export const KERNEL_PRESSURE_STALE_MS = 180_000;

/** `kern.memorystatus_vm_pressure_level` as XNU defines it: 1 normal, 2 warn, 4 critical. */
const KERNEL_LEVEL_CRITICAL = 4;

let critical = false;
let clearStreak = 0;
let lastReadingAt: number | null = null;

export function recordKernelPressureLevel(level: 1 | 2 | 4 | null, now: number = Date.now()): void {
  if (level === null) return;
  lastReadingAt = now;
  if (level === KERNEL_LEVEL_CRITICAL) {
    critical = true;
    clearStreak = 0;
    return;
  }
  if (!critical) return;
  clearStreak++;
  if (clearStreak >= KERNEL_CRITICAL_CLEAR_READINGS) {
    critical = false;
    clearStreak = 0;
  }
}

/** When the last valid reading was recorded; null before the first. */
export function getLastKernelPressureReadingAt(): number | null {
  return lastReadingAt;
}

/** A clock that stepped backwards is no evidence the verdict is still fresh. */
export function isKernelPressureCritical(now: number = Date.now()): boolean {
  if (!critical || lastReadingAt === null) return false;
  const ageMs = now - lastReadingAt;
  if (ageMs >= 0 && ageMs <= KERNEL_PRESSURE_STALE_MS) return true;
  critical = false;
  clearStreak = 0;
  return false;
}

export function resetKernelPressureForTesting(): void {
  critical = false;
  clearStreak = 0;
  lastReadingAt = null;
}
