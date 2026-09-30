import { useSyncExternalStore } from "react";
import { subscribeViewIdle } from "./hostBridge.js";

export interface NowOptions {
  /**
   * How often the value moves on, in ms. Default 60 000, which suits "5m ago".
   * Values below 1000 (and non-finite ones) are treated as 1000; for anything
   * that moves every frame use `useAnimationFrame`.
   */
  intervalMs?: number;
  /**
   * Tick on multiples of `intervalMs` since the epoch (whole minutes for the
   * default) rather than `intervalMs` after the first subscriber mounted, so
   * every "5m ago" on screen turns over together and in step with the wall
   * clock. Default true.
   */
  align?: boolean;
}

const MIN_INTERVAL_MS = 1000;

interface Clock {
  now: number;
  listeners: Set<() => void>;
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => number;
  refreshIfUnwatched: () => void;
}

// One clock per interval and alignment, shared by every subscriber in the
// view's document: a hundred rows showing "5m ago" run one timer, not a hundred.
const clocks = new Map<string, Clock>();

function createClock(intervalMs: number, align: boolean): Clock {
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let idle: ReturnType<typeof subscribeViewIdle> | null = null;

  const delay = (): number => (align ? intervalMs - (Date.now() % intervalMs) : intervalMs);

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const tick = (): void => {
    timer = null;
    clock.now = Date.now();
    notify();
    if (listeners.size > 0 && !idle?.isIdle()) timer = setTimeout(tick, delay());
  };

  const stopTimer = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  // Paused while nobody can see the view; on the way back the time it spent
  // away is already stale, so it catches up at once rather than at the next tick.
  const sync = (): void => {
    if (listeners.size === 0) return;
    if (idle?.isIdle()) stopTimer();
    else if (timer === null) tick();
  };

  const clock: Clock = {
    now: Date.now(),
    listeners,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        idle = subscribeViewIdle(sync);
        if (!idle.isIdle()) {
          // Whatever the first render read may be a tick old by now.
          if (isStale()) tick();
          else timer = setTimeout(tick, delay());
        }
      }
      return () => {
        if (!listeners.delete(listener) || listeners.size > 0) return;
        stopTimer();
        idle?.dispose();
        idle = null;
      };
    },
    getSnapshot: () => clock.now,
    refreshIfUnwatched() {
      // Nobody is subscribed, so nobody can tear: an unwatched clock that has
      // fallen behind catches up before the render that is about to read it.
      if (listeners.size === 0 && isStale()) clock.now = Date.now();
    },
  };

  // Whether `now` is a tick behind the wall clock: a whole interval old, or
  // (aligned) taken before the boundary that has since passed. A wall clock
  // set backwards makes it stale too.
  function isStale(): boolean {
    const age = Date.now() - clock.now;
    if (age < 0) return true;
    return age >= (align ? intervalMs - (clock.now % intervalMs) : intervalMs);
  }

  return clock;
}

function getClock(intervalMs: number, align: boolean): Clock {
  const key = `${intervalMs}:${align ? "a" : "f"}`;
  let clock = clocks.get(key);
  if (!clock) {
    clock = createClock(intervalMs, align);
    clocks.set(key, clock);
  }
  return clock;
}

function normaliseInterval(value: number | undefined): number {
  const ms = value ?? 60_000;
  if (!Number.isFinite(ms)) return MIN_INTERVAL_MS;
  return Math.max(MIN_INTERVAL_MS, Math.floor(ms));
}

/**
 * The current time (`Date.now()`), re-rendering the component when it moves
 * on by `intervalMs` — the hook for "5m ago", "due in 2h" and other text that
 * changes only as time passes, where a `setInterval` in the view would poll.
 *
 * Every component asking for the same `intervalMs` and `align` shares one
 * timer and one value, so they all turn over in the same commit. The timer
 * stops while the document is hidden or the project view is cached, and when
 * the view comes back the value catches up at once. It stops entirely when
 * the last subscriber unmounts.
 *
 * ```tsx
 * // formatTimeAgo is the kit's, from @daintreehq/plugin-ui
 * const now = useNow();
 * return <span>{formatTimeAgo(entry.createdAt, now)}</span>;
 * ```
 *
 * On the server, and in a render before the first subscription, it reads the
 * clock once and returns that.
 */
export function useNow(options: NowOptions = {}): number {
  const intervalMs = normaliseInterval(options.intervalMs);
  const align = options.align ?? true;
  const clock = getClock(intervalMs, align);
  clock.refreshIfUnwatched();
  return useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot);
}
