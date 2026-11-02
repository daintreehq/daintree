// @vitest-environment jsdom
// A drag a nested DndContext owns (a pane's tab strip) never reaches
// DndProvider, so the strip raises the webview shield and recovers a release a
// webview swallowed on its own, without disturbing the provider's flag.
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DRAG_RECOVERY_GRACE_MS } from "../useDragRecovery";
import { useNestedDragGuard } from "../useNestedDragGuard";

// Each Escape the guard sends, as type:code, in order.
const escapes: string[] = [];
const captureKey = (event: KeyboardEvent) => {
  if (event.code === "Escape") escapes.push(event.type);
};
const RECOVERED = ["keydown", "keyup"];

const mouseActivator = () => new MouseEvent("mousedown", { bubbles: true });
const keyboardActivator = () => new KeyboardEvent("keydown", { code: "Space" });
const flag = () => document.documentElement.dataset.dragging;

function mouseMove(buttons: number) {
  document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, buttons }));
}

function mouseOut(relatedTarget: EventTarget | null) {
  document.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget }));
}

describe("useNestedDragGuard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    escapes.length = 0;
    document.addEventListener("keydown", captureKey);
    document.addEventListener("keyup", captureKey);
  });

  afterEach(() => {
    // Unmounting releases every hold, which the guard counts across strips.
    cleanup();
    document.removeEventListener("keydown", captureKey);
    document.removeEventListener("keyup", captureKey);
    vi.useRealTimers();
    delete document.documentElement.dataset.dragging;
  });

  it("raises the shield as the drag starts and lowers it once the ending event is over", () => {
    const { result } = renderHook(() => useNestedDragGuard());
    result.current.beginDrag(mouseActivator());
    expect(flag()).toBe("true");

    result.current.finishDrag();
    // Still up for the rest of the event, where the Escape dispatcher reads it.
    expect(flag()).toBe("true");
    act(() => {
      vi.runAllTimers();
    });
    expect(flag()).toBeUndefined();
  });

  it("keeps a shield DndProvider raised, at the end of the drag and on unmount", () => {
    document.documentElement.dataset.dragging = "true";
    const { result, unmount } = renderHook(() => useNestedDragGuard());
    result.current.beginDrag(mouseActivator());
    result.current.finishDrag();
    act(() => {
      vi.runAllTimers();
    });
    expect(flag()).toBe("true");

    result.current.beginDrag(mouseActivator());
    unmount();
    expect(flag()).toBe("true");
  });

  it("lowers its own shield when the strip unmounts mid-drag", () => {
    const { result, unmount } = renderHook(() => useNestedDragGuard());
    result.current.beginDrag(mouseActivator());
    unmount();
    expect(flag()).toBeUndefined();
  });

  it("keeps the shield up for a drag that starts before the last one's has come down", () => {
    const { result } = renderHook(() => useNestedDragGuard());
    result.current.beginDrag(mouseActivator());
    result.current.finishDrag();
    result.current.beginDrag(mouseActivator());
    act(() => {
      vi.runAllTimers();
    });
    expect(flag()).toBe("true");
  });

  it.each([
    ["the first", 0],
    ["the second", 1],
  ] as const)(
    "keeps the shield up while two strips overlap, whichever ends first (%s)",
    (_label, firstToEnd) => {
      const strips = [
        renderHook(() => useNestedDragGuard()).result,
        renderHook(() => useNestedDragGuard()).result,
      ];
      strips[0]!.current.beginDrag(keyboardActivator());
      strips[1]!.current.beginDrag(mouseActivator());

      strips[firstToEnd]!.current.finishDrag();
      act(() => {
        vi.runAllTimers();
      });
      expect(flag()).toBe("true");

      strips[1 - firstToEnd]!.current.finishDrag();
      act(() => {
        vi.runAllTimers();
      });
      expect(flag()).toBeUndefined();
    }
  );

  it("cancels a mouse drag whose release the host never saw", () => {
    const { result } = renderHook(() => useNestedDragGuard());
    result.current.beginDrag(mouseActivator());
    mouseMove(1);
    expect(escapes).toEqual([]);

    mouseMove(0);
    expect(escapes).toEqual(RECOVERED);
  });

  it("cancels a mouse drag that leaves the document for longer than the grace period", () => {
    const { result } = renderHook(() => useNestedDragGuard());
    result.current.beginDrag(mouseActivator());
    mouseOut(document.body);
    act(() => {
      vi.advanceTimersByTime(DRAG_RECOVERY_GRACE_MS);
    });
    expect(escapes).toEqual([]);

    mouseOut(null);
    act(() => {
      vi.advanceTimersByTime(DRAG_RECOVERY_GRACE_MS - 1);
    });
    mouseMove(1);
    act(() => {
      vi.advanceTimersByTime(DRAG_RECOVERY_GRACE_MS);
    });
    expect(escapes).toEqual([]);

    mouseOut(null);
    act(() => {
      vi.advanceTimersByTime(DRAG_RECOVERY_GRACE_MS);
    });
    expect(escapes).toEqual(RECOVERED);
  });

  it("stops listening once the drag ends, and never listens for a keyboard drag", () => {
    const { result } = renderHook(() => useNestedDragGuard());
    result.current.beginDrag(mouseActivator());
    mouseOut(null);
    result.current.finishDrag();
    mouseMove(0);
    act(() => {
      vi.advanceTimersByTime(DRAG_RECOVERY_GRACE_MS);
    });
    expect(escapes).toEqual([]);

    result.current.beginDrag(keyboardActivator());
    mouseMove(0);
    expect(escapes).toEqual([]);
    expect(flag()).toBe("true");
  });

  it("stops listening when the strip unmounts mid-drag", () => {
    const { result, unmount } = renderHook(() => useNestedDragGuard());
    result.current.beginDrag(mouseActivator());
    mouseOut(null);
    unmount();
    mouseMove(0);
    act(() => {
      vi.advanceTimersByTime(DRAG_RECOVERY_GRACE_MS);
    });
    expect(escapes).toEqual([]);
  });
});
