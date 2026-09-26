// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { PROGRESSIVE_INITIAL_ROWS, useProgressiveRenderLimit } from "../useProgressiveRenderLimit";

async function flushExpansion(): Promise<void> {
  await act(async () => {
    vi.advanceTimersToNextFrame();
    vi.runOnlyPendingTimers();
  });
}

describe("useProgressiveRenderLimit", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the first screenful, then the whole list after a frame", async () => {
    const { result } = renderHook(() => useProgressiveRenderLimit(240, "open"));
    expect(result.current).toBe(PROGRESSIVE_INITIAL_ROWS);

    await flushExpansion();
    expect(result.current).toBe(240);
  });

  it("never renders fewer rows than the selection needs", () => {
    const { result } = renderHook(() => useProgressiveRenderLimit(240, "open", 99));
    expect(result.current).toBe(100);
  });

  it("does not cap a list shorter than the budget", () => {
    const { result } = renderHook(() => useProgressiveRenderLimit(7, "open"));
    expect(result.current).toBe(7);
  });

  it("starts over when a list that emptied on close reopens under its old key", async () => {
    const { result, rerender } = renderHook(
      ({ total, key }) => useProgressiveRenderLimit(total, key),
      { initialProps: { total: 240, key: "true|" } }
    );
    await flushExpansion();
    expect(result.current).toBe(240);

    // Closed: the palette's list empties.
    rerender({ total: 0, key: "false|" });
    await flushExpansion();

    // Reopened under the key it last expanded with.
    rerender({ total: 240, key: "true|" });
    expect(result.current).toBe(PROGRESSIVE_INITIAL_ROWS);

    await flushExpansion();
    expect(result.current).toBe(240);
  });

  it("starts over after a short result set returns to the key it expanded under", async () => {
    const { result, rerender } = renderHook(
      ({ total, key }) => useProgressiveRenderLimit(total, key),
      { initialProps: { total: 240, key: "true|" } }
    );
    await flushExpansion();
    expect(result.current).toBe(240);

    // A narrow search: fewer rows than the budget.
    rerender({ total: 20, key: "true|ab" });
    await flushExpansion();
    expect(result.current).toBe(20);

    // Clearing the search returns to the browse key.
    rerender({ total: 240, key: "true|" });
    expect(result.current).toBe(PROGRESSIVE_INITIAL_ROWS);
  });

  it("restarts the budget when the query changes", async () => {
    const { result, rerender } = renderHook(({ key }) => useProgressiveRenderLimit(240, key), {
      initialProps: { key: "true|a" },
    });
    await flushExpansion();
    expect(result.current).toBe(240);

    rerender({ key: "true|ab" });
    expect(result.current).toBe(PROGRESSIVE_INITIAL_ROWS);
  });
});
