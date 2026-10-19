import { SWAP_PRESSURE_STALE_MS } from "./systemSwapPressure.js";

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

let elevatedAt: number | null = null;

/**
 * `elevated` is null when a failed reading left the sample undecided: the
 * previous verdict stands, without its timestamp being refreshed.
 */
export function recordWatchdogMemoryPressure(
  elevated: boolean | null,
  sampledAt: number = Date.now()
): void {
  if (elevated === null) return;
  elevatedAt = elevated ? sampledAt : null;
}

/** A clock that stepped backwards is no evidence the reading is still fresh. */
export function isWatchdogMemoryPressureElevated(now: number = Date.now()): boolean {
  if (elevatedAt === null) return false;
  const ageMs = now - elevatedAt;
  if (ageMs >= 0 && ageMs <= WATCHDOG_PRESSURE_STALE_MS) return true;
  elevatedAt = null;
  return false;
}
