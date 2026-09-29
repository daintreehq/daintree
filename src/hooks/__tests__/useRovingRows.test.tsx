/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useRovingRows } from "../useRovingRows";

const KEYS = ["a", "b", "c", "d"];

const focusEvent = (target: HTMLElement) => ({ target, currentTarget: target });

describe("useRovingRows", () => {
  it("rests the stop on the preferred row, and falls back when that row is filtered away", () => {
    const { result, rerender } = renderHook(
      ({ keys }) => useRovingRows({ keys, preferredKey: "c" }),
      {
        initialProps: { keys: KEYS },
      }
    );
    expect(result.current.tabStopKey).toBe("c");
    rerender({ keys: ["a", "b", "d"] });
    expect(result.current.tabStopKey).toBe("a");
    rerender({ keys: [] });
    expect(result.current.tabStopKey).toBeNull();
  });

  it("never gives an unwindowed list's container a tab stop", () => {
    const { result } = renderHook(() => useRovingRows({ keys: KEYS }));
    expect(result.current.containerProps.tabIndex).toBeUndefined();
  });

  it("gives a windowed list's container the stop only while the stop's row is out of the DOM", () => {
    const { result } = renderHook(() => useRovingRows({ keys: KEYS, windowed: true }));
    // Nothing has reported yet: no row is known to hold the stop.
    expect(result.current.containerProps.tabIndex).toBe(0);
    act(() => result.current.reportTabStopMounted(true));
    expect(result.current.containerProps.tabIndex).toBeUndefined();
    act(() => result.current.reportTabStopMounted(false));
    expect(result.current.containerProps.tabIndex).toBe(0);
  });

  it("forwards focus that lands on the container to the stop's row, revealing it first", () => {
    const reveal = vi.fn();
    const { result } = renderHook(() =>
      useRovingRows({ keys: KEYS, preferredKey: "d", windowed: true, reveal })
    );
    const container = document.createElement("div");
    act(() => result.current.containerProps.onFocus(focusEvent(container)));
    expect(reveal).toHaveBeenCalledWith(3);

    // The row mounts after the reveal and takes focus as it does.
    const row = document.createElement("button");
    document.body.append(row);
    act(() => result.current.rowRef("d")(row));
    expect(document.activeElement).toBe(row);
    row.remove();
  });

  it("ignores focus that bubbles up from a row", () => {
    const reveal = vi.fn();
    const { result } = renderHook(() => useRovingRows({ keys: KEYS, windowed: true, reveal }));
    const container = document.createElement("div");
    const row = document.createElement("button");
    container.append(row);
    act(() => result.current.containerProps.onFocus({ target: row, currentTarget: container }));
    expect(reveal).not.toHaveBeenCalled();
  });
});
