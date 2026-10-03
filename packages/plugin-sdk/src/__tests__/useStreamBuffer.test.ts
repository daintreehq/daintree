// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useStreamBuffer } from "../react/useStreamBuffer.js";

describe("useStreamBuffer", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"],
    });
  });
  afterEach(() => vi.useRealTimers());

  it("keeps every item pushed within a frame and commits them once", () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useStreamBuffer<number>();
    });
    const before = renders;
    for (let i = 0; i < 500; i++) result.current.push(i);
    expect(result.current.items).toEqual([]);
    act(() => vi.advanceTimersToNextFrame());
    expect(result.current.items).toHaveLength(500);
    expect(result.current.items[0]).toBe(0);
    expect(result.current.items[499]).toBe(499);
    expect(result.current.dropped).toBe(0);
    expect(renders - before).toBe(1);
  });

  it("drops the oldest beyond maxItems and counts them, across pushes and commits", () => {
    const { result } = renderHook(() => useStreamBuffer<number>({ maxItems: 3 }));
    for (let i = 0; i < 10; i++) result.current.push(i);
    act(() => vi.advanceTimersToNextFrame());
    expect(result.current.items).toEqual([7, 8, 9]);
    expect(result.current.dropped).toBe(7);

    result.current.pushMany([10, 11]);
    act(() => vi.advanceTimersToNextFrame());
    expect(result.current.items).toEqual([9, 10, 11]);
    expect(result.current.dropped).toBe(9);

    result.current.pushMany([12, 13, 14, 15, 16]);
    act(() => vi.advanceTimersToNextFrame());
    expect(result.current.items).toEqual([14, 15, 16]);
    expect(result.current.dropped).toBe(14);
  });

  it("never mutates an array it has committed", () => {
    const { result } = renderHook(() => useStreamBuffer<string>());
    result.current.push("a");
    act(() => vi.advanceTimersToNextFrame());
    const committed = result.current.items;
    result.current.push("b");
    expect(committed).toEqual(["a"]);
    act(() => vi.advanceTimersToNextFrame());
    expect(result.current.items).toEqual(["a", "b"]);
    expect(committed).toEqual(["a"]);
  });

  it("with a numeric flush, commits at most once per window", () => {
    const { result } = renderHook(() => useStreamBuffer<number>({ flush: 100 }));
    result.current.push(1);
    act(() => vi.advanceTimersByTime(50));
    result.current.push(2);
    expect(result.current.items).toEqual([]);
    act(() => vi.advanceTimersByTime(50));
    expect(result.current.items).toEqual([1, 2]);
  });

  it("clear() empties the buffer and the dropped count at once, dropping a pending commit", () => {
    const { result } = renderHook(() => useStreamBuffer<number>({ maxItems: 1 }));
    result.current.pushMany([1, 2, 3]);
    act(() => vi.advanceTimersToNextFrame());
    expect(result.current.dropped).toBe(2);
    result.current.push(4);
    act(() => result.current.clear());
    expect(result.current.items).toEqual([]);
    expect(result.current.dropped).toBe(0);
    act(() => vi.advanceTimersToNextFrame());
    expect(result.current.items).toEqual([]);
  });

  it("keeps stable function identities and ignores pushes after unmount", () => {
    const { result, rerender, unmount } = renderHook(() => useStreamBuffer<number>());
    const { push, pushMany, clear } = result.current;
    rerender();
    expect(result.current.push).toBe(push);
    expect(result.current.pushMany).toBe(pushMany);
    expect(result.current.clear).toBe(clear);
    unmount();
    push(1);
    expect(() => vi.advanceTimersToNextFrame()).not.toThrow();
  });
});

describe("useStreamBuffer option changes", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"],
    });
  });
  afterEach(() => vi.useRealTimers());

  it("trims to a lowered maxItems without waiting for another push", () => {
    const { result, rerender } = renderHook(
      ({ max }) => useStreamBuffer<number>({ maxItems: max }),
      {
        initialProps: { max: 10 },
      }
    );
    result.current.pushMany([1, 2, 3, 4, 5]);
    act(() => vi.advanceTimersToNextFrame());
    rerender({ max: 2 });
    act(() => vi.advanceTimersToNextFrame());
    expect(result.current.items).toEqual([4, 5]);
    expect(result.current.dropped).toBe(3);
  });

  it("re-times a pending commit when flush changes", () => {
    const { result, rerender } = renderHook(
      ({ flush }: { flush: "frame" | number }) => useStreamBuffer<number>({ flush }),
      { initialProps: { flush: 10_000 as "frame" | number } }
    );
    result.current.push(1);
    rerender({ flush: "frame" });
    act(() => vi.advanceTimersToNextFrame());
    expect(result.current.items).toEqual([1]);
  });
});
