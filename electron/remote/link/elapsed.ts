/** One moment on this machine's own clocks: wall time and a monotonic reading. */
export interface ElapsedStamp {
  wall: number;
  mono: number;
}

export function stampNow(): ElapsedStamp {
  return { wall: Date.now(), mono: performance.now() };
}

/**
 * Time between two moments on this machine, never less than really passed:
 * the monotonic clock stands still while the machine sleeps and the wall
 * clock can be stepped back, so the larger of the two is kept. A wall clock
 * stepped forward only overstates it, which makes a reading look older.
 */
export function elapsedSince(from: ElapsedStamp, to: ElapsedStamp): number {
  return Math.max(0, to.mono - from.mono, to.wall - from.wall);
}
