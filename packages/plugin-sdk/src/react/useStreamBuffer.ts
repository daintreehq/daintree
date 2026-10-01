import { useEffect, useRef, useState } from "react";

export interface StreamBufferOptions {
  /**
   * How many items to keep. Beyond it the oldest are dropped and counted in
   * `dropped`. Default 1000. Values below 1 are treated as 1.
   */
  maxItems?: number;
  /**
   * When state updates: `"frame"` (default) commits at most once per animation
   * frame; a number commits at most once per that many ms. Items pushed in
   * between are all kept, just committed together.
   */
  flush?: "frame" | number;
}

export interface StreamBufferResult<T> {
  /** The newest `maxItems` items, oldest first. A new array on every commit; treat it as immutable. */
  items: readonly T[];
  /** Items dropped off the front since mount or the last `clear()`. */
  dropped: number;
  /** Append one item. Stable identity. */
  push: (item: T) => void;
  /** Append several items in order. Stable identity. */
  pushMany: (items: readonly T[]) => void;
  /** Drop everything, including the `dropped` count, and commit the empty buffer. Stable identity. */
  clear: () => void;
}

interface BufferState<T> {
  items: readonly T[];
  dropped: number;
}

interface Buffer<T> {
  items: T[];
  dropped: number;
  /** True once `items` has been committed to React state and must not be mutated. */
  shared: boolean;
  cancel: (() => void) | null;
  mounted: boolean;
  max: number;
  flush: "frame" | number;
}

function schedule(flush: "frame" | number, run: () => void): () => void {
  if (flush === "frame" && typeof requestAnimationFrame === "function") {
    const id = requestAnimationFrame(run);
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(run, flush === "frame" ? 16 : Math.max(0, flush));
  return () => clearTimeout(id);
}

/**
 * A bounded, lossless buffer for streamed items — log lines, progress lines,
 * events — that commits to React state at most once per frame.
 *
 * Every pushed item is kept until `maxItems` is exceeded; then the oldest go,
 * and `dropped` says how many. That is the difference from
 * {@link useThrottledCallback}, which keeps only the latest arguments and is
 * right for replaceable values, not for streams. Appending with
 * `setLines((prev) => [...prev, line])` per push is the other trap: it copies
 * the whole array on every line and schedules one update per push.
 *
 * ```tsx
 * const log = useStreamBuffer<string>({ maxItems: 5000 });
 * usePluginEvent<string>(pluginId, "build-output", log.push);
 * // render log.items with useVirtualList
 * ```
 *
 * Pushes after unmount are ignored.
 */
export function useStreamBuffer<T>(options: StreamBufferOptions = {}): StreamBufferResult<T> {
  const { maxItems = 1000, flush = "frame" } = options;
  const max = Math.max(1, Math.floor(Number.isFinite(maxItems) ? maxItems : 1000));

  const [state, setState] = useState<BufferState<T>>(() => ({ items: [], dropped: 0 }));

  const bufferRef = useRef<Buffer<T>>({
    items: [],
    dropped: 0,
    shared: true,
    cancel: null,
    mounted: false,
    max,
    flush,
  });
  const [api] = useState(() => {
    const trim = (b: Buffer<T>): void => {
      const excess = b.items.length - b.max;
      if (excess <= 0) return;
      b.items = b.items.slice(excess);
      b.shared = false;
      b.dropped += excess;
    };

    const commit = (): void => {
      const b = bufferRef.current;
      b.cancel = null;
      if (!b.mounted) return;
      trim(b);
      b.shared = true;
      setState({ items: b.items, dropped: b.dropped });
    };

    const writable = (b: Buffer<T>): T[] => {
      // Copy on the first write after a commit, so the array React holds is never mutated.
      if (b.shared) {
        b.items = b.items.slice();
        b.shared = false;
      }
      return b.items;
    };

    const afterWrite = (b: Buffer<T>): void => {
      // Compact at twice the bound so trimming stays amortised O(1) per item.
      if (b.items.length > b.max * 2) trim(b);
      if (!b.cancel) b.cancel = schedule(b.flush, commit);
    };

    const push = (item: T): void => {
      const b = bufferRef.current;
      if (!b.mounted) return;
      writable(b).push(item);
      afterWrite(b);
    };

    const pushMany = (items: readonly T[]): void => {
      const b = bufferRef.current;
      if (!b.mounted || items.length === 0) return;
      const target = writable(b);
      // Only the tail can survive; skip copying what would be trimmed at once.
      const start = Math.max(0, items.length - b.max);
      b.dropped += start;
      if (start > 0) {
        b.dropped += target.length;
        target.length = 0;
      }
      for (let i = start; i < items.length; i++) target.push(items[i]!);
      afterWrite(b);
    };

    const clear = (): void => {
      const b = bufferRef.current;
      b.cancel?.();
      b.cancel = null;
      b.items = [];
      b.dropped = 0;
      b.shared = true;
      if (b.mounted) setState({ items: b.items, dropped: 0 });
    };

    // A pending commit is cancelled on unmount; StrictMode's remount picks it up again.
    const resume = (): void => {
      const b = bufferRef.current;
      if (!b.shared && !b.cancel) b.cancel = schedule(b.flush, commit);
    };

    // A new bound or cadence applies to what is already buffered: a lower
    // `maxItems` trims on the next commit, and a pending commit is re-timed.
    const reconfigure = (nextMax: number, nextFlush: "frame" | number): void => {
      const b = bufferRef.current;
      if (b.max === nextMax && b.flush === nextFlush) return;
      b.max = nextMax;
      b.flush = nextFlush;
      if (!b.mounted) return;
      if (b.cancel || b.items.length > b.max) {
        b.cancel?.();
        b.cancel = schedule(b.flush, commit);
      }
    };

    return { push, pushMany, clear, resume, reconfigure };
  });

  useEffect(() => {
    api.reconfigure(max, flush);
  }, [api, max, flush]);

  // Set in setup (not at creation) so StrictMode's simulated unmount and
  // remount leaves the buffer live.
  useEffect(() => {
    const b = bufferRef.current;
    b.mounted = true;
    api.resume();
    return () => {
      b.mounted = false;
      b.cancel?.();
      b.cancel = null;
    };
  }, [api]);

  return {
    items: state.items,
    dropped: state.dropped,
    push: api.push,
    pushMany: api.pushMany,
    clear: api.clear,
  };
}
