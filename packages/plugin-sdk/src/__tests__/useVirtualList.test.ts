// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useVirtualList, type VirtualListOptions } from "../react/useVirtualList.js";

function scroller(height: number): HTMLDivElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "clientHeight", { configurable: true, value: height });
  return el;
}

function scrollTo(el: HTMLElement, top: number): void {
  act(() => {
    el.scrollTop = top;
    el.dispatchEvent(new Event("scroll"));
  });
}

describe("useVirtualList", () => {
  it("mounts only the rows in view plus overscan for fixed-height rows", () => {
    const el = scroller(100);
    const getScrollElement = () => el;
    const { result } = renderHook(() =>
      useVirtualList({ count: 10_000, estimateSize: 20, overscan: 2, getScrollElement })
    );
    expect(result.current.totalSize).toBe(200_000);
    expect(result.current.rows.map((r) => r.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

    scrollTo(el, 1000);
    const rows = result.current.rows;
    expect(rows[0]).toEqual({ index: 48, start: 960, size: 20 });
    expect(rows.at(-1)?.index).toBe(57);
  });

  it("does not re-render for scrolls that keep the same range", () => {
    const el = scroller(100);
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useVirtualList({
        count: 1000,
        estimateSize: 20,
        overscan: 0,
        getScrollElement: () => el,
      });
    });
    scrollTo(el, 200);
    const afterFirst = renders;
    const rows = result.current.rows;
    scrollTo(el, 205);
    scrollTo(el, 210);
    expect(renders).toBe(afterFirst);
    expect(result.current.rows).toBe(rows);
  });

  it("lays out variable heights from an index function", () => {
    const el = scroller(50);
    const estimateSize = (i: number) => (i % 2 === 0 ? 10 : 30);
    const { result } = renderHook(() =>
      useVirtualList({ count: 100, estimateSize, overscan: 0, getScrollElement: () => el })
    );
    expect(result.current.totalSize).toBe(2000);
    scrollTo(el, 45);
    // Rows start at 0, 10, 40, 50, 80, 90: offset 45 is inside row 2, 95 inside row 5.
    expect(result.current.rows.map((r) => [r.index, r.start])).toEqual([
      [2, 40],
      [3, 50],
      [4, 80],
      [5, 90],
    ]);
  });

  it("clamps to a shrinking count and handles an empty list", () => {
    const el = scroller(100);
    const { result, rerender } = renderHook(
      ({ count }: Pick<VirtualListOptions, "count">) =>
        useVirtualList({ count, estimateSize: 20, getScrollElement: () => el }),
      { initialProps: { count: 50 } }
    );
    scrollTo(el, 600);
    rerender({ count: 3 });
    expect(result.current.rows.every((r) => r.index < 3)).toBe(true);
    rerender({ count: 0 });
    expect(result.current.rows).toEqual([]);
    expect(result.current.totalSize).toBe(0);
  });

  it("scrollToIndex aligns the row to the start or end of the viewport", () => {
    const el = scroller(100);
    const { result } = renderHook(() =>
      useVirtualList({ count: 100, estimateSize: 20, getScrollElement: () => el })
    );
    result.current.scrollToIndex(10);
    expect(el.scrollTop).toBe(200);
    result.current.scrollToIndex(10, "end");
    expect(el.scrollTop).toBe(120);
  });

  it("renders rows as soon as an empty list gains items", () => {
    const el = scroller(100);
    const { result, rerender } = renderHook(
      ({ count }: Pick<VirtualListOptions, "count">) =>
        useVirtualList({ count, estimateSize: 20, overscan: 0, getScrollElement: () => el }),
      { initialProps: { count: 0 } }
    );
    expect(result.current.rows).toEqual([]);
    rerender({ count: 100 });
    expect(result.current.rows.map((r) => r.index)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
