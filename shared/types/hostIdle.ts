/**
 * How long a host goes without seeing work before its idle time ends, in
 * minutes (#17357). Kept on the host, so it is judged there with no Shell
 * attached. The bounds are what the host stores, not what a Shell reads: a
 * summary's field takes any whole number of minutes, so a later build may
 * widen them without failing an older Shell's whole summary.
 */
export const HOST_IDLE_MINUTES = { min: 5, max: 1440 } as const;

export const DEFAULT_HOST_IDLE_MINUTES = 30;

/** The idle times offered on a cloud host's details. */
export const HOST_IDLE_MINUTE_CHOICES: readonly number[] = [15, 30, 60, 120, 240, 480];

export function isHostIdleMinutes(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= HOST_IDLE_MINUTES.min &&
    value <= HOST_IDLE_MINUTES.max
  );
}

/** The stored idle time, or the default for one never set or edited by hand out of bounds. */
export function hostIdleMinutesOf(value: unknown): number {
  return isHostIdleMinutes(value) ? value : DEFAULT_HOST_IDLE_MINUTES;
}

/**
 * What a host has seen of its own use. Work is an agent working, waiting or
 * directing, one whose state can't be read, or a Shell with a window open on
 * the host. Times are the host's own clock.
 */
export interface HostIdleObservation {
  /** The idle time set on the host. */
  idleAfterMinutes: number;
  /** When the host last saw work: its latest check while busy. */
  lastWorkAt: number;
  /** Whether its latest check saw work. */
  busy: boolean;
  /** When the idle time ends, or ended; null while busy. */
  idleEndsAt: number | null;
  /**
   * The host holds a key to stop its own machine once the idle time ends
   * (#17361). Absent from a host that can't, or from before it could.
   */
  stopsWhenIdle?: boolean;
}
