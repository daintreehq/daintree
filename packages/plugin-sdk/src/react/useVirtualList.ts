import { useCallback, useLayoutEffect, useMemo, useState } from "react";

export interface VirtualListOptions {
  /** Number of rows. */
  count: number;
  /**
   * Row height in pixels: a number for fixed-height rows (constant-time
   * layout), or a function of the index for rows whose heights are known up
   * front. Heights are not measured from the DOM. Keep a function's identity
   * stable — a new one rebuilds the offset table, which costs O(count).
   */
  estimateSize: number | ((index: number) => number);
  /** Rows rendered beyond each edge of the viewport. Default 4. */
  overscan?: number;
  /**
   * Returns the scrolling element. Rows are assumed to start at the top of its
   * content. Called after each commit, so reading a ref here is fine.
   */
  getScrollElement: () => HTMLElement | null;
}

export interface VirtualRow {
  index: number;
  /** Offset from the top of the scroll content, for `transform: translateY(...)` or `top`. */
  start: number;
  size: number;
}

export interface VirtualListResult {
  /** The rows to mount, in order. */
  rows: readonly VirtualRow[];
  /** Height to give the inner spacer so the scrollbar reflects every row. */
  totalSize: number;
  /** Scroll so row `index` sits at the top (or bottom, with `"end"`) of the viewport. */
  scrollToIndex: (index: number, align?: "start" | "end") => void;
}

interface Layout {
  offsetOf(index: number): number;
  sizeOf(index: number): number;
  indexAt(offset: number): number;
  total: number;
}

// Rows mounted before the scroll element has been measured.
const UNMEASURED_ROWS = 30;

function buildLayout(count: number, estimateSize: VirtualListOptions["estimateSize"]): Layout {
  if (typeof estimateSize === "number") {
    const size = Math.max(1, estimateSize);
    return {
      offsetOf: (i) => i * size,
      sizeOf: () => size,
      indexAt: (offset) => Math.min(count - 1, Math.max(0, Math.floor(offset / size))),
      total: count * size,
    };
  }
  const offsets = new Float64Array(count + 1);
  for (let i = 0; i < count; i++) offsets[i + 1] = offsets[i]! + Math.max(0, estimateSize(i));
  return {
    offsetOf: (i) => offsets[i]!,
    sizeOf: (i) => offsets[i + 1]! - offsets[i]!,
    indexAt(offset) {
      // Last row whose start is at or before `offset`.
      let lo = 0;
      let hi = count - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >>> 1;
        if (offsets[mid]! <= offset) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    },
    total: offsets[count]!,
  };
}

/**
 * Window a long list so only the rows in view (plus `overscan`) are mounted.
 * Re-renders only when the range of visible rows changes, not on every scroll
 * event. Deliberately minimal and dependency-free: row heights come from
 * `estimateSize` rather than DOM measurement, and there is no horizontal or
 * grid mode.
 *
 * ```tsx
 * const scrollRef = useRef<HTMLDivElement>(null);
 * const { rows, totalSize } = useVirtualList({
 *   count: items.length, estimateSize: 28, getScrollElement: () => scrollRef.current,
 * });
 * <div ref={scrollRef} style={{ overflow: "auto", height: "100%" }}>
 *   <div style={{ height: totalSize, position: "relative" }}>
 *     {rows.map((r) => (
 *       <div key={r.index} style={{ position: "absolute", top: r.start, height: r.size, width: "100%" }}>
 *         {items[r.index].name}
 *       </div>
 *     ))}
 *   </div>
 * </div>
 * ```
 */
export function useVirtualList(options: VirtualListOptions): VirtualListResult {
  const { count, estimateSize, getScrollElement } = options;
  const overscan = Math.max(0, options.overscan ?? 4);
  const layout = useMemo(() => buildLayout(count, estimateSize), [count, estimateSize]);
  const [range, setRange] = useState<{ first: number; last: number } | null>(null);

  // A layout effect so a range computed for an older count or layout is
  // replaced before the browser paints it.
  useLayoutEffect(() => {
    const el = getScrollElement();
    if (!el) return;
    const update = (): void => {
      if (count === 0) {
        setRange((prev) =>
          prev && prev.first === 0 && prev.last === -1 ? prev : { first: 0, last: -1 }
        );
        return;
      }
      const top = el.scrollTop;
      const first = Math.max(0, layout.indexAt(top) - overscan);
      const last = Math.min(count - 1, layout.indexAt(top + el.clientHeight) + overscan);
      setRange((prev) =>
        prev && prev.first === first && prev.last === last ? prev : { first, last }
      );
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [getScrollElement, layout, count, overscan]);

  const first = range ? Math.min(range.first, Math.max(0, count - 1)) : 0;
  const last = range
    ? Math.min(range.last, count - 1)
    : Math.min(count - 1, UNMEASURED_ROWS + overscan - 1);

  const rows = useMemo(() => {
    const out: VirtualRow[] = [];
    for (let i = first; i <= last; i++) {
      out.push({ index: i, start: layout.offsetOf(i), size: layout.sizeOf(i) });
    }
    return out;
  }, [first, last, layout]);

  const scrollToIndex = useCallback(
    (index: number, align: "start" | "end" = "start") => {
      const el = getScrollElement();
      if (!el || count === 0) return;
      const i = Math.min(count - 1, Math.max(0, index));
      const start = layout.offsetOf(i);
      el.scrollTop = align === "end" ? start + layout.sizeOf(i) - el.clientHeight : start;
    },
    [getScrollElement, layout, count]
  );

  return { rows, totalSize: layout.total, scrollToIndex };
}
