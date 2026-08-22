// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, createEvent, act } from "@testing-library/react";
import { useDockLaunchHoverSelection } from "../useDockLaunchHoverSelection";

interface Row {
  rowKey: string;
}

const ROWS: Row[] = [{ rowKey: "a" }, { rowKey: "b" }, { rowKey: "c" }];

function Harness({
  results,
  setSelectedIndex,
  open = true,
}: {
  results: readonly Row[];
  setSelectedIndex: (index: number) => void;
  open?: boolean;
}) {
  const { listboxRef, onHover, notifyKeyboardSelection } = useDockLaunchHoverSelection({
    open,
    results,
    setSelectedIndex,
  });
  return (
    <div>
      <div ref={listboxRef} data-testid="listbox">
        {results.map((row, index) => (
          <button
            key={row.rowKey}
            data-testid={`row-${row.rowKey}`}
            onPointerEnter={(event) => onHover(index, row.rowKey, event.pointerType)}
          >
            {row.rowKey}
          </button>
        ))}
      </div>
      <button data-testid="navigate" onClick={notifyKeyboardSelection}>
        navigate
      </button>
    </div>
  );
}

function setup(results: readonly Row[] = ROWS) {
  const setSelectedIndex = vi.fn();
  const view = render(<Harness results={results} setSelectedIndex={setSelectedIndex} />);
  return { ...view, setSelectedIndex };
}

/** jsdom defaults pointerType to "", and timeStamp is not settable through init. */
function fireMouse(
  target: Element,
  type: "pointermove" | "pointerleave" | "pointerover",
  { x, y, t }: { x: number; y: number; t: number }
): void {
  const factory = {
    pointermove: createEvent.pointerMove,
    pointerleave: createEvent.pointerLeave,
    pointerover: createEvent.pointerOver,
  }[type];
  const event = factory(target, { pointerType: "mouse", clientX: x, clientY: y });
  Object.defineProperty(event, "timeStamp", { value: t, configurable: true });
  fireEvent(target, event);
}

/** React synthesises onPointerEnter from pointerover, never from pointerenter. */
function enterRow(row: Element, sample: { x: number; y: number; t: number }): void {
  fireMouse(row, "pointerover", sample);
}

function startSweep(listbox: Element): void {
  fireMouse(listbox, "pointermove", { x: 0, y: 0, t: 0 });
  fireMouse(listbox, "pointermove", { x: 0, y: 30, t: 10 });
}

/** Comes to rest well past the minimum-suppression floor. */
function settlePointer(listbox: Element): void {
  fireMouse(listbox, "pointermove", { x: 0, y: 30, t: 400 });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("useDockLaunchHoverSelection", () => {
  it("passes an unsuppressed mouse hover straight through", () => {
    const { getByTestId, setSelectedIndex } = setup();
    enterRow(getByTestId("row-b"), { x: 0, y: 32, t: 0 });
    expect(setSelectedIndex).toHaveBeenCalledWith(1);
  });

  it.each(["touch", "pen"])("never gates %s, which has no hover to protect", (pointerType) => {
    const { getByTestId, setSelectedIndex } = setup();
    const listbox = getByTestId("listbox");
    startSweep(listbox);

    const row = getByTestId("row-c");
    const event = createEvent.pointerOver(row, { pointerType, clientX: 0, clientY: 64 });
    fireEvent(row, event);
    expect(setSelectedIndex).toHaveBeenCalledWith(2);
  });

  it("swallows the rows a sweep crosses and spends only the last one", () => {
    const { getByTestId, setSelectedIndex } = setup();
    const listbox = getByTestId("listbox");
    startSweep(listbox);

    enterRow(getByTestId("row-b"), { x: 0, y: 32, t: 12 });
    enterRow(getByTestId("row-c"), { x: 0, y: 64, t: 14 });
    expect(setSelectedIndex).not.toHaveBeenCalled();

    settlePointer(listbox);
    expect(setSelectedIndex).toHaveBeenCalledTimes(1);
    expect(setSelectedIndex).toHaveBeenCalledWith(2);
  });

  it("spends the row it tracked at the index that row now holds", () => {
    const { getByTestId, rerender, setSelectedIndex } = setup();
    const listbox = getByTestId("listbox");
    startSweep(listbox);
    enterRow(getByTestId("row-c"), { x: 0, y: 64, t: 12 });

    // The list reshuffles under the suppressed sweep: "c" is still there, but
    // the index it was hovered at now belongs to a different row.
    const reshuffled: Row[] = [{ rowKey: "c" }, { rowKey: "a" }];
    rerender(<Harness results={reshuffled} setSelectedIndex={setSelectedIndex} />);

    settlePointer(listbox);
    expect(setSelectedIndex).toHaveBeenCalledWith(0);
  });

  it("spends nothing when the row it tracked is filtered away", () => {
    const { getByTestId, rerender, setSelectedIndex } = setup();
    const listbox = getByTestId("listbox");
    startSweep(listbox);
    enterRow(getByTestId("row-c"), { x: 0, y: 64, t: 12 });

    rerender(<Harness results={[{ rowKey: "a" }]} setSelectedIndex={setSelectedIndex} />);

    settlePointer(listbox);
    expect(setSelectedIndex).not.toHaveBeenCalled();
  });

  it("never spends a row when the gesture that ends is the list moving", () => {
    vi.useFakeTimers();
    const { getByTestId, setSelectedIndex } = setup();
    const listbox = getByTestId("listbox");

    // A pointer gesture is already suppressed with a row recorded, and then the
    // list moves. Spending that row on the scroll's settle is the bug itself.
    startSweep(listbox);
    enterRow(getByTestId("row-c"), { x: 0, y: 64, t: 12 });
    fireEvent.scroll(listbox);
    enterRow(getByTestId("row-b"), { x: 0, y: 32, t: 14 });

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(setSelectedIndex).not.toHaveBeenCalled();
  });

  it("ignores a scroll that cannot have moved its own rows", () => {
    const { getByTestId, setSelectedIndex } = setup();
    // A sibling scroller — a terminal streaming output — must not stand the
    // launcher's hover down.
    fireEvent.scroll(getByTestId("navigate"));
    enterRow(getByTestId("row-b"), { x: 0, y: 32, t: 0 });
    expect(setSelectedIndex).toHaveBeenCalledWith(1);
  });

  it("drops a sweep's pending row when the keyboard makes a choice first", () => {
    vi.useFakeTimers();
    const { getByTestId, setSelectedIndex } = setup();
    const listbox = getByTestId("listbox");
    startSweep(listbox);
    enterRow(getByTestId("row-c"), { x: 0, y: 64, t: 12 });

    fireEvent.click(getByTestId("navigate"));

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(setSelectedIndex).not.toHaveBeenCalled();
  });

  it("drops a sweep's pending row when the pointer leaves the list", () => {
    vi.useFakeTimers();
    const { getByTestId, setSelectedIndex } = setup();
    const listbox = getByTestId("listbox");
    startSweep(listbox);
    enterRow(getByTestId("row-c"), { x: 0, y: 64, t: 12 });
    fireMouse(listbox, "pointerleave", { x: 0, y: 400, t: 20 });

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(setSelectedIndex).not.toHaveBeenCalled();
  });

  it("suppresses again after the pointer leaves and comes back", () => {
    const { getByTestId, setSelectedIndex } = setup();
    const listbox = getByTestId("listbox");
    startSweep(listbox);
    fireMouse(listbox, "pointerleave", { x: 0, y: 400, t: 20 });

    // A fresh gesture: the sampler was cleared, so these two samples are the
    // whole window and must engage on their own.
    fireMouse(listbox, "pointermove", { x: 0, y: 0, t: 100 });
    fireMouse(listbox, "pointermove", { x: 0, y: 30, t: 110 });
    enterRow(getByTestId("row-b"), { x: 0, y: 32, t: 112 });
    expect(setSelectedIndex).not.toHaveBeenCalled();
  });

  it("takes an armed gesture down with the component, timer and all", () => {
    vi.useFakeTimers();
    const { getByTestId, setSelectedIndex, unmount } = setup();
    const listbox = getByTestId("listbox");
    startSweep(listbox);
    enterRow(getByTestId("row-c"), { x: 0, y: 64, t: 12 });

    unmount();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(setSelectedIndex).not.toHaveBeenCalled();
  });

  it("stays out of the way entirely while the launcher is closed", () => {
    const setSelectedIndex = vi.fn();
    const { getByTestId } = render(
      <Harness results={ROWS} setSelectedIndex={setSelectedIndex} open={false} />
    );
    startSweep(getByTestId("listbox"));
    enterRow(getByTestId("row-c"), { x: 0, y: 64, t: 12 });
    expect(setSelectedIndex).toHaveBeenCalledWith(2);
  });
});
