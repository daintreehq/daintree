// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useLayoutEffect, useState } from "react";
import { renderHook, render, act, cleanup } from "@testing-library/react";
import {
  keyBelongsToField,
  stepListboxCursor,
  useListboxCursor,
  type ListboxCursorKeyEvent,
} from "../useListboxCursor";

function keyEvent(
  key: string,
  {
    metaKey = false,
    ctrlKey = false,
    altKey = false,
    ...nativeEvent
  }: {
    isComposing?: boolean;
    keyCode?: number;
    metaKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
  } = {}
) {
  return {
    key,
    metaKey,
    ctrlKey,
    altKey,
    nativeEvent: { isComposing: false, keyCode: 0, ...nativeEvent },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } satisfies ListboxCursorKeyEvent;
}

interface CursorProps {
  itemCount: number;
  open?: boolean;
  initialIndex?: number;
  resetKey?: unknown;
}

function renderCursor(initial: CursorProps = { itemCount: 4 }) {
  const onSelect = vi.fn<(index: number) => void>();
  const onClose = vi.fn();
  const committed: Array<{ open: boolean; activeIndex: number }> = [];
  const view = renderHook(
    (props: CursorProps) => {
      const open = props.open ?? true;
      const cursor = useListboxCursor({
        itemCount: props.itemCount,
        open,
        initialIndex: props.initialIndex,
        resetKey: props.resetKey,
        onSelect,
        onClose,
      });
      // A layout effect only sees what was committed: the render-phase reset
      // throws its first pass away, so recording from the render body would
      // report a cursor the user never had.
      useLayoutEffect(() => {
        committed.push({ open, activeIndex: cursor.activeIndex });
      });
      return cursor;
    },
    { initialProps: initial }
  );
  return { ...view, onSelect, onClose, committed };
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

describe("useListboxCursor", () => {
  it("wraps in both directions and commits the row Enter is pointed at", () => {
    const { result, onSelect } = renderCursor({ itemCount: 3 });

    act(() => result.current.handleKeyDown(keyEvent("ArrowUp")));
    expect(result.current.activeIndex).toBe(2);

    act(() => result.current.handleKeyDown(keyEvent("ArrowDown")));
    expect(result.current.activeIndex).toBe(0);

    act(() => result.current.handleKeyDown(keyEvent("End")));
    act(() => result.current.handleKeyDown(keyEvent("Enter")));
    expect(onSelect).toHaveBeenCalledWith(2);
  });

  it("reports no row at all for an empty list rather than index 0", () => {
    const { result, onSelect } = renderCursor({ itemCount: 0 });

    expect(result.current.activeIndex).toBe(-1);
    act(() => result.current.handleKeyDown(keyEvent("Enter")));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("discards an out-of-range cursor instead of parking it for later", () => {
    const { result, rerender } = renderCursor({ itemCount: 10, resetKey: "" });

    act(() => result.current.setActiveIndex(8));
    expect(result.current.activeIndex).toBe(8);

    // A new result set: one row, so the clamp alone would report 0 while still
    // holding 8. Only an actual rewind keeps the cursor at the top once the
    // list widens again — otherwise it lands on an unrelated row.
    rerender({ itemCount: 1, resetKey: "narrow" });
    expect(result.current.activeIndex).toBe(0);

    rerender({ itemCount: 10, resetKey: "narrow" });
    expect(result.current.activeIndex).toBe(0);
  });

  it("keeps the cursor across a re-render that is not a new result set", () => {
    const { result, rerender } = renderCursor({ itemCount: 10, resetKey: "same" });

    act(() => result.current.setActiveIndex(4));
    rerender({ itemCount: 10, resetKey: "same" });

    expect(result.current.activeIndex).toBe(4);
  });

  it("starts each open session at the top", () => {
    const { result, rerender } = renderCursor({ itemCount: 5, open: true });

    act(() => result.current.setActiveIndex(3));
    rerender({ itemCount: 5, open: false });
    rerender({ itemCount: 5, open: true });

    expect(result.current.activeIndex).toBe(0);
  });

  it("starts each open session on the committed row and returns to it after wandering", () => {
    const { result, rerender, onSelect } = renderCursor({
      itemCount: 5,
      open: true,
      initialIndex: 3,
    });
    expect(result.current.activeIndex).toBe(3);

    act(() => result.current.handleKeyDown(keyEvent("Home")));
    rerender({ itemCount: 5, open: false, initialIndex: 3 });
    rerender({ itemCount: 5, open: true, initialIndex: 3 });
    expect(result.current.activeIndex).toBe(3);

    act(() => result.current.handleKeyDown(keyEvent("Enter")));
    expect(onSelect).toHaveBeenCalledWith(3);
  });

  it("never commits a frame on the last session's row when the committed row moved while closed", () => {
    const { rerender, committed } = renderCursor({ itemCount: 5, open: false, initialIndex: 1 });

    rerender({ itemCount: 5, open: false, initialIndex: 4 });
    rerender({ itemCount: 5, open: true, initialIndex: 4 });

    const opening = committed.filter((frame) => frame.open);
    expect(opening.length).toBeGreaterThan(0);
    expect(opening.every((frame) => frame.activeIndex === 4)).toBe(true);
  });

  it("leaves the cursor alone when the committed row or the list changes mid-session", () => {
    const { result, rerender } = renderCursor({ itemCount: 5, open: true, initialIndex: 1 });

    act(() => result.current.setActiveIndex(3));
    rerender({ itemCount: 6, open: true, initialIndex: 0 });

    expect(result.current.activeIndex).toBe(3);
  });

  it("starts at the first row when nothing is committed or the committed row is not in the list", () => {
    for (const initialIndex of [undefined, -1, 7]) {
      const { result, unmount } = renderCursor({ itemCount: 3, initialIndex });
      expect(result.current.activeIndex).toBe(0);
      unmount();
    }
  });

  it("does not park an out-of-range committed row for a later, longer list", () => {
    const { result, rerender } = renderCursor({ itemCount: 2, open: true, initialIndex: 6 });
    expect(result.current.activeIndex).toBe(0);

    rerender({ itemCount: 10, open: true, initialIndex: 6 });
    expect(result.current.activeIndex).toBe(0);
  });

  it("returns to the committed row, not the top, when the result set changes", () => {
    const { result, rerender } = renderCursor({
      itemCount: 5,
      initialIndex: 2,
      resetKey: "a",
    });
    act(() => result.current.setActiveIndex(4));

    rerender({ itemCount: 5, initialIndex: 2, resetKey: "b" });
    expect(result.current.activeIndex).toBe(2);
  });

  it("leaves a modified chord to whatever bound it", () => {
    const { result, onSelect } = renderCursor({ itemCount: 3 });

    const submit = keyEvent("Enter", { metaKey: true });
    act(() => result.current.handleKeyDown(submit));
    expect(onSelect).not.toHaveBeenCalled();
    expect(submit.preventDefault).not.toHaveBeenCalled();
    expect(submit.stopPropagation).not.toHaveBeenCalled();

    const ctrlSubmit = keyEvent("Enter", { ctrlKey: true });
    act(() => result.current.handleKeyDown(ctrlSubmit));
    expect(onSelect).not.toHaveBeenCalled();

    const altArrow = keyEvent("ArrowDown", { altKey: true });
    act(() => result.current.handleKeyDown(altArrow));
    expect(result.current.activeIndex).toBe(0);
    expect(altArrow.preventDefault).not.toHaveBeenCalled();
  });

  it("hands Escape to the caller and keeps it off the surface behind", () => {
    const { result, onClose } = renderCursor({ itemCount: 3 });

    const escape = keyEvent("Escape");
    act(() => result.current.handleKeyDown(escape));

    expect(onClose).toHaveBeenCalled();
    expect(escape.stopPropagation).toHaveBeenCalled();
  });

  it("closes on Escape even with nothing to select", () => {
    const { result, onClose } = renderCursor({ itemCount: 0 });

    act(() => result.current.handleKeyDown(keyEvent("Escape")));
    expect(onClose).toHaveBeenCalled();
  });

  it("leaves Enter to the IME while a candidate is being composed", () => {
    const { result, onSelect } = renderCursor({ itemCount: 3 });

    act(() => result.current.handleKeyDown(keyEvent("Enter", { isComposing: true })));
    // Chromium can emit 229 before `isComposing` flips.
    act(() => result.current.handleKeyDown(keyEvent("Enter", { keyCode: 229 })));

    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("useListboxCursor — scrolling the cursor row into view", () => {
  const scrolled: string[] = [];

  beforeEach(() => {
    scrolled.length = 0;
    Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
      scrolled.push(this.getAttribute("data-option-index") ?? "?");
    });
  });

  // The list mounts after the render that opens it, as a Radix popover's does.
  function Harness({ open, initialIndex, tick }: CursorProps & { tick?: number }) {
    const { listRef } = useListboxCursor({
      itemCount: 6,
      open,
      initialIndex,
      onSelect: vi.fn(),
      onClose: vi.fn(),
    });
    const [listMounted, setListMounted] = useState(false);
    useLayoutEffect(() => {
      setListMounted(open);
    }, [open]);
    return (
      <div data-tick={tick}>
        {listMounted && (
          <div ref={listRef} data-testid="list">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} data-option-index={i} />
            ))}
          </div>
        )}
      </div>
    );
  }

  it("scrolls the committed row into view once a late-mounting list appears", () => {
    const { rerender } = render(<Harness itemCount={6} open={false} initialIndex={4} />);
    expect(scrolled).toEqual([]);

    rerender(<Harness itemCount={6} open={true} initialIndex={4} />);
    expect(scrolled).toContain("4");
  });

  it("scrolls again when the list reopens on the row the cursor was already on", () => {
    const { rerender } = render(<Harness itemCount={6} open={true} initialIndex={4} />);
    rerender(<Harness itemCount={6} open={false} initialIndex={4} />);
    scrolled.length = 0;

    rerender(<Harness itemCount={6} open={true} initialIndex={4} />);
    expect(scrolled).toContain("4");
  });

  it("does not scroll a closed list, or re-scroll on an unrelated render", () => {
    const { rerender } = render(<Harness itemCount={6} open={true} initialIndex={2} tick={0} />);
    const afterOpen = scrolled.length;

    rerender(<Harness itemCount={6} open={true} initialIndex={2} tick={1} />);
    expect(scrolled).toHaveLength(afterOpen);

    rerender(<Harness itemCount={6} open={false} initialIndex={2} tick={1} />);
    expect(scrolled).toHaveLength(afterOpen);
  });
});

describe("stepListboxCursor", () => {
  const walk = (key: string, from: number, count: number, steps: number, options = {}) => {
    const seen: number[] = [];
    let index = from;
    for (let i = 0; i < steps; i++) {
      index = stepListboxCursor(key, index, count, options)!;
      seen.push(index);
    }
    return seen;
  };

  it("a wrapping list visits every row once per lap, in both directions", () => {
    for (const count of [1, 2, 5]) {
      const down = walk("ArrowDown", 0, count, count);
      expect(new Set(down).size).toBe(count);
      expect(down[count - 1]).toBe(0);
      const up = walk("ArrowUp", 0, count, count);
      expect(new Set(up).size).toBe(count);
      expect(up[count - 1]).toBe(0);
    }
  });

  it("Down past the last row and Up past the first go round to the other end", () => {
    expect(stepListboxCursor("ArrowDown", 4, 5)).toBe(0);
    expect(stepListboxCursor("ArrowUp", 0, 5)).toBe(4);
  });

  it("a list with a none position passes through it on the way round", () => {
    const lap = walk("ArrowDown", -1, 3, 4, { allowNone: true });
    expect(lap).toEqual([0, 1, 2, -1]);
    const back = walk("ArrowUp", -1, 3, 4, { allowNone: true });
    expect(back).toEqual([2, 1, 0, -1]);
  });

  it("a non-wrapping list holds at both ends", () => {
    expect(stepListboxCursor("ArrowDown", 4, 5, { wrap: false })).toBe(4);
    expect(stepListboxCursor("ArrowUp", 0, 5, { wrap: false })).toBe(0);
  });

  it("Home and End jump to the ends whatever the options", () => {
    for (const options of [{}, { wrap: false }, { allowNone: true }]) {
      for (const from of [-1, 0, 2, 4]) {
        expect(stepListboxCursor("Home", from, 5, options)).toBe(0);
        expect(stepListboxCursor("End", from, 5, options)).toBe(4);
      }
    }
  });

  it("an out-of-range cursor enters at the near end of travel", () => {
    expect(stepListboxCursor("ArrowDown", 9, 5)).toBe(0);
    expect(stepListboxCursor("ArrowUp", 9, 5)).toBe(4);
    expect(stepListboxCursor("ArrowUp", -1, 5, { wrap: false })).toBe(4);
  });

  it("leaves other keys and empty lists alone", () => {
    expect(stepListboxCursor("Enter", 0, 5)).toBeNull();
    expect(stepListboxCursor("PageDown", 0, 5)).toBeNull();
    expect(stepListboxCursor("ArrowDown", 0, 0)).toBeNull();
    expect(stepListboxCursor("Home", -1, 0)).toBeNull();
  });

  it("every result is a row or the none position the list allows", () => {
    for (const key of ["ArrowDown", "ArrowUp", "Home", "End"]) {
      for (const count of [1, 3]) {
        for (let from = -1; from <= count; from++) {
          for (const wrap of [true, false]) {
            const plain = stepListboxCursor(key, from, count, { wrap })!;
            expect(plain).toBeGreaterThanOrEqual(0);
            expect(plain).toBeLessThan(count);
            const withNone = stepListboxCursor(key, from, count, { wrap, allowNone: true })!;
            expect(withNone).toBeGreaterThanOrEqual(-1);
            expect(withNone).toBeLessThan(count);
          }
        }
      }
    }
  });
});

describe("keyBelongsToField", () => {
  const bare = { shiftKey: false, metaKey: false, ctrlKey: false, altKey: false };

  it("leaves a modified key to the field", () => {
    expect(keyBelongsToField(bare)).toBe(false);
    for (const k of ["shiftKey", "metaKey", "ctrlKey", "altKey"] as const) {
      expect(keyBelongsToField({ ...bare, [k]: true })).toBe(true);
    }
  });

  it("leaves a composing key to the IME, from a React or a native event", () => {
    expect(keyBelongsToField({ ...bare, nativeEvent: { isComposing: true, keyCode: 0 } })).toBe(
      true
    );
    expect(keyBelongsToField({ ...bare, nativeEvent: { isComposing: false, keyCode: 229 } })).toBe(
      true
    );
    expect(keyBelongsToField({ ...bare, isComposing: true })).toBe(true);
    expect(keyBelongsToField({ ...bare, nativeEvent: { isComposing: false, keyCode: 35 } })).toBe(
      false
    );
  });
});
