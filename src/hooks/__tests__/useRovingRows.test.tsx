/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook } from "@testing-library/react";
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
    // Out of the tab order, but still able to hold focus parked on it.
    expect(result.current.containerProps.tabIndex).toBe(-1);
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

  // The folder listing's shape: the key handler on an outer group, the
  // container (where focus parks) one level in.
  function List({ mounted }: { mounted: string[] }) {
    const roving = useRovingRows({ keys: KEYS, windowed: true });
    return (
      <div role="group" onKeyDown={roving.onKeyDown}>
        <div data-testid="list" {...roving.containerProps}>
          {mounted.map((key) => (
            <button
              key={key}
              type="button"
              data-roving-row=""
              ref={roving.rowRef(key)}
              tabIndex={roving.tabStopKey === key ? 0 : -1}
              onFocus={() => roving.onRowFocus(key)}
            >
              {key}
            </button>
          ))}
        </div>
      </div>
    );
  }

  it("parks focus on the list when the focused row is windowed out, and keeps the arrows working", async () => {
    const { getByText, getByTestId, rerender } = render(<List mounted={["a", "b", "c"]} />);
    act(() => getByText("b").focus());

    // A plain re-render hands every row a fresh ref callback; that is not an
    // unmount and must leave focus where it is.
    rerender(<List mounted={["a", "b", "c"]} />);
    await act(async () => {});
    expect(document.activeElement).toBe(getByText("b"));

    // The window scrolls past the focused row.
    rerender(<List mounted={["c", "d"]} />);
    await act(async () => {});
    const list = getByTestId("list");
    expect(document.activeElement).toBe(list);

    // Arrows continue from the row that had focus, through the outer handler.
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(document.activeElement).toBe(getByText("c"));
  });

  it("hands focus back to the row when it scrolls back into the window", async () => {
    const { getByText, getByTestId, rerender } = render(<List mounted={["a", "b", "c"]} />);
    act(() => getByText("b").focus());
    rerender(<List mounted={["c", "d"]} />);
    await act(async () => {});
    expect(document.activeElement).toBe(getByTestId("list"));

    rerender(<List mounted={["a", "b", "c"]} />);
    await act(async () => {});
    expect(document.activeElement).toBe(getByText("b"));
  });

  it("never pulls focus into the list when a row scrolls out while focus is elsewhere", async () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    const { getByText, rerender } = render(<List mounted={["a", "b", "c"]} />);
    act(() => getByText("b").focus());
    // Focus leaves for a control outside the list, then drops to the page.
    act(() => outside.focus());
    act(() => outside.blur());
    rerender(<List mounted={["c", "d"]} />);
    await act(async () => {});
    expect(document.activeElement).toBe(document.body);
    outside.remove();
  });

  it("does not park for a row that never had focus", async () => {
    const { rerender } = render(<List mounted={["a", "b", "c"]} />);
    rerender(<List mounted={["c", "d"]} />);
    await act(async () => {});
    expect(document.activeElement).toBe(document.body);
  });
});
