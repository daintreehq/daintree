// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
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

function renderCursor(
  initial: { itemCount: number; open?: boolean; resetKey?: unknown } = {
    itemCount: 4,
  }
) {
  const onSelect = vi.fn<(index: number) => void>();
  const onClose = vi.fn();
  const view = renderHook(
    (props: { itemCount: number; open?: boolean; resetKey?: unknown }) =>
      useListboxCursor({
        itemCount: props.itemCount,
        open: props.open ?? true,
        resetKey: props.resetKey,
        onSelect,
        onClose,
      }),
    { initialProps: initial }
  );
  return { ...view, onSelect, onClose };
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

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
