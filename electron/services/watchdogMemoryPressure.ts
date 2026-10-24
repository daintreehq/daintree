import { isSwapPressureConfirmed, SWAP_PRESSURE_STALE_MS } from "./systemSwapPressure.js";

/**
 * Main's latest read of system memory pressure, carried on every watchdog ping
 * so the watchdog gives a stalled main longer before killing it (#13528). Main
 * stalled on page-ins usually recovers by itself; a kill takes the pty-host and
 * every agent down with it.
 *
 * Looser than the confirmed verdict in `systemSwapPressure` on purpose: a false
 * "elevated" only stretches the deadlock deadline, while a false "clear" lets
 * the watchdog kill a main that is waiting on memory. Ages out on the same
 * clock, for the same reason — nobody refreshes it while the app-metrics poll
 * is throttled or suspended.
 */
export const WATCHDOG_PRESSURE_STALE_MS = SWAP_PRESSURE_STALE_MS;

let reading: { elevated: boolean; sampledAt: number } | null = null;

/**
 * `elevated` is null when a failed reading left the sample undecided: the
 * previous verdict stands, without its timestamp being refreshed.
 */
export function recordWatchdogMemoryPressure(
  elevated: boolean | null,
  sampledAt: number = Date.now()
): void {
  if (elevated === null) return;
  reading = { elevated, sampledAt };
}

/**
 * The fresh verdict, or null when there is none: no sample yet (boot, or E2E,
 * where the monitor never runs), or the last one has gone stale. A clock that
 * stepped backwards is no evidence the reading is still fresh.
 */
export function readWatchdogMemoryPressure(now: number = Date.now()): boolean | null {
  if (reading === null) return null;
  const ageMs = now - reading.sampledAt;
  if (ageMs >= 0 && ageMs <= WATCHDOG_PRESSURE_STALE_MS) return reading.elevated;
  reading = null;
  return null;
}

/**
 * Below this share of physical memory, Daintree's own processes can't be what
 * is pushing the machine into swap (#14367). On the incident host they held
 * about 0.5 GB of 36 GB while agent tool trees held the rest.
 */
export const EXTERNAL_PRESSURE_MAX_OWN_MEMORY_RATIO = 0.25;

export interface OwnMemoryReading {
  ownMb: number;
  /** Wall-clock time of the sweep the figure came from. */
  sampledAt: number;
}

/**
 * True when kernel-plus-swap pressure is confirmed and a fresh reading puts
 * Daintree's own footprint under {@link EXTERNAL_PRESSURE_MAX_OWN_MEMORY_RATIO}
 * of physical memory: pressure that nothing in the reclaim ladder can relieve.
 * `readOwnMemory` is only called once pressure is confirmed, and returns null
 * when there is no figure it trusts.
 */
export function isMemoryPressureExternal(
  readOwnMemory: () => OwnMemoryReading | null,
  totalMemoryMb: number,
  now: number = Date.now()
): boolean {
  if (!isSwapPressureConfirmed(now)) return false;
  if (!(totalMemoryMb > 0)) return false;
  const own = readOwnMemory();
  if (own === null || !Number.isFinite(own.ownMb) || own.ownMb < 0) return false;
  const ageMs = now - own.sampledAt;
  if (!(ageMs >= 0 && ageMs <= WATCHDOG_PRESSURE_STALE_MS)) return false;
  return own.ownMb / totalMemoryMb < EXTERNAL_PRESSURE_MAX_OWN_MEMORY_RATIO;
}
