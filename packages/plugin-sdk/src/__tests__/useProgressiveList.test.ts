// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useProgressiveList, type ProgressiveListOptions } from "../react/useProgressiveList.js";

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

async function flushStep(): Promise<void> {
  await act(async () => {
    vi.advanceTimersToNextFrame();
    vi.runOnlyPendingTimers();
  });
}

describe("useProgressiveList", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"],
    });
  });
  afterEach(() => vi.useRealTimers());

  it("renders the first 30, then the rest after a frame", async () => {
    const items = range(240);
    const { result } = renderHook(() => useProgressiveList(items));
    expect(result.current.visible).toHaveLength(30);
    expect(result.current.isComplete).toBe(false);

    await flushStep();
    expect(result.current.visible).toBe(items);
    expect(result.current.isComplete).toBe(true);
  });

  it("grows by `step` per frame when given one", async () => {
    const items = range(100);
    const { result } = renderHook(() => useProgressiveList(items, { initial: 10, step: 40 }));
    expect(result.current.visible).toHaveLength(10);
    await flushStep();
    expect(result.current.visible).toHaveLength(50);
    await flushStep();
    expect(result.current.visible).toHaveLength(90);
    await flushStep();
    expect(result.current.isComplete).toBe(true);
  });

  it("always covers minIndex and never caps a short list", () => {
    const { result: selected } = renderHook(() => useProgressiveList(range(240), { minIndex: 99 }));
    expect(selected.current.visible).toHaveLength(100);
    const { result: short } = renderHook(() => useProgressiveList(range(7)));
    expect(short.current.isComplete).toBe(true);
  });

  it("keeps the visible array stable across renders with the same items", () => {
    const items = range(240);
    const { result, rerender } = renderHook(() => useProgressiveList(items));
    const first = result.current.visible;
    rerender();
    expect(result.current.visible).toBe(first);
  });

  it("restarts on a new resetKey, including a return to a key it once expanded under", async () => {
    const big = range(240);
    const { result, rerender } = renderHook(
      ({ items, opts }: { items: number[]; opts: ProgressiveListOptions }) =>
        useProgressiveList(items, opts),
      { initialProps: { items: big, opts: { resetKey: "browse" } } }
    );
    await flushStep();
    expect(result.current.isComplete).toBe(true);

    rerender({ items: range(20), opts: { resetKey: "search" } });
    await flushStep();
    expect(result.current.visible).toHaveLength(20);

    rerender({ items: big, opts: { resetKey: "browse" } });
    expect(result.current.visible).toHaveLength(30);
  });

  it("keeps its budget when the items update under the same key", async () => {
    const { result, rerender } = renderHook(({ items }) => useProgressiveList(items), {
      initialProps: { items: range(240) },
    });
    await flushStep();
    rerender({ items: range(241) });
    expect(result.current.visible).toHaveLength(241);
  });

  it("stops growing once minIndex already covers the list", async () => {
    let renders = 0;
    renderHook(() => {
      renders++;
      return useProgressiveList(range(1000), { initial: 10, step: 1, minIndex: 999 });
    });
    const base = renders;
    await flushStep();
    await flushStep();
    expect(renders).toBe(base);
  });
});
