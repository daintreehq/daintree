import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  PluginDebouncedCallback,
  UseDebouncedCallbackOptions,
} from "@shared/types/plugin-sdk-react";

const DEFAULT_DELAY_MS = 300;

function delayOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_DELAY_MS;
}

function readOptions(options: unknown): UseDebouncedCallbackOptions {
  if (typeof options !== "object" || options === null) return {};
  const maxWait: unknown = Reflect.get(options, "maxWait");
  return {
    leading: Reflect.get(options, "leading") === true,
    maxWait: typeof maxWait === "number" ? maxWait : undefined,
  };
}

/**
 * `value`, once it has stopped changing for `delayMs` (300 by default): a
 * search box's text, say, so the filter runs when the user pauses rather than
 * on every key.
 */
export function useDebouncedValue<T>(value: T, delayMs?: number): T {
  const [settled, setSettled] = useState(value);
  const delay = delayOf(delayMs);
  useEffect(() => {
    if (Object.is(value, settled)) return;
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay, settled]);
  return settled;
}

/**
 * `callback`, run once calls stop for `delayMs` (300 by default), with the
 * last call's arguments. `leading` also runs the first call of a burst at
 * once; `maxWait` caps how long a steady stream can hold it back. The latest
 * `callback` is always the one run; a pending call is dropped on unmount.
 */
export function useDebouncedCallback<A extends unknown[]>(
  callback: (...args: A) => void,
  delayMs?: number,
  options?: UseDebouncedCallbackOptions
): PluginDebouncedCallback<A> {
  // The debounced function is built once and reads its refs when called, not
  // while rendering; the compiler cannot tell a lazy initializer's closures
  // from render-time reads, so this hook opts out, as the SDK's throttle does.
  "use no memo";
  const latest = useRef({ callback, delay: delayOf(delayMs), options: readOptions(options) });
  // Layout effects, so a call from a child's layout effect on mount (which
  // runs before any passive effect) is already live.
  useLayoutEffect(() => {
    latest.current = { callback, delay: delayOf(delayMs), options: readOptions(options) };
  });

  const timing = useRef<{
    args: A | null;
    timer: ReturnType<typeof setTimeout> | null;
    /** The last call, to tell a pause (a new burst) from a steady stream. */
    lastCall: number | null;
    /** Where the current `maxWait` window began. */
    windowStart: number;
    mounted: boolean;
  }>({ args: null, timer: null, lastCall: null, windowStart: 0, mounted: false });

  const [debounced] = useState(() => {
    const run = () => {
      const t = timing.current;
      const args = t.args;
      t.args = null;
      const target = latest.current.callback;
      if (args && t.mounted && typeof target === "function") target(...args);
    };
    const settle = () => {
      const t = timing.current;
      t.timer = null;
      // A stream still arriving keeps its burst; the next maxWait starts now.
      t.windowStart = Date.now();
      run();
    };
    const call = (...args: A): void => {
      const t = timing.current;
      if (!t.mounted) return;
      const { delay, options: opts } = latest.current;
      const now = Date.now();
      const startsBurst = t.lastCall === null || now - t.lastCall >= delay;
      t.lastCall = now;
      if (startsBurst) t.windowStart = now;
      t.args = args;
      if (startsBurst && opts.leading === true) run();
      if (t.timer !== null) clearTimeout(t.timer);
      const maxWait =
        typeof opts.maxWait === "number" && Number.isFinite(opts.maxWait) && opts.maxWait >= 0
          ? opts.maxWait
          : Number.POSITIVE_INFINITY;
      const wait = Math.max(0, Math.min(delay, t.windowStart + maxWait - now));
      t.timer = setTimeout(settle, wait);
    };
    const cancel = () => {
      const t = timing.current;
      if (t.timer !== null) clearTimeout(t.timer);
      t.timer = null;
      t.args = null;
      t.lastCall = null;
    };
    const flush = () => {
      const t = timing.current;
      if (t.timer !== null) clearTimeout(t.timer);
      t.timer = null;
      t.windowStart = Date.now();
      run();
    };
    return Object.assign(call, {
      cancel,
      flush,
      isPending: () => timing.current.args !== null,
    });
  });

  // Set in setup, not at creation, so StrictMode's simulated unmount and
  // remount leaves the function live.
  useLayoutEffect(() => {
    const t = timing.current;
    t.mounted = true;
    return () => {
      t.mounted = false;
      debounced.cancel();
    };
  }, [debounced]);
  return debounced;
}
