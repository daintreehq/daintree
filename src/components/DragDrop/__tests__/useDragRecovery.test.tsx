// @vitest-environment jsdom
// Tests for the lost-mouseup drag watchdog (#11291). A mouseup swallowed by a
// webview OOPIF never reaches the host document, leaving dnd-kit's internal
// active lock held and every future drag silently ignored. The hook recovers
// by dispatching a synthetic Escape keydown (dnd-kit's pointer sensors match
// on `event.code`), and stamps the data-dragging webview shield synchronously
// at drag start — before React commits — to close the frame-late gap.
import {
  DndContext,
  MouseSensor,
  useDraggable,
  useSensor,
  useSensors,
  type DragStartEvent,
} from "@dnd-kit/core";
import { act, fireEvent, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DRAG_RECOVERY_GRACE_MS, useDragRecovery } from "../useDragRecovery";

const keydowns: KeyboardEvent[] = [];

function captureKeydown(event: KeyboardEvent) {
  keydowns.push(event);
}

function escapeCodes(): string[] {
  return keydowns.map((event) => event.code);
}

function mouseActivator(): MouseEvent {
  return new MouseEvent("mousedown", { bubbles: true });
}

function dispatchMouseOut(relatedTarget: EventTarget | null) {
  document.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget }));
}

function dispatchMouseMove(buttons: number) {
  document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, buttons }));
}

describe("useDragRecovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    keydowns.length = 0;
    document.addEventListener("keydown", captureKeydown);
  });

  afterEach(() => {
    document.removeEventListener("keydown", captureKeydown);
    vi.useRealTimers();
    delete document.documentElement.dataset.dragging;
  });

  describe("data-dragging shield", () => {
    it("stamps data-dragging synchronously on beginDrag, before any commit", () => {
      const { result } = renderHook(() => useDragRecovery());
      result.current.beginDrag(mouseActivator());
      expect(document.documentElement.dataset.dragging).toBe("true");
    });

    it("leaves data-dragging in place on finishDrag for the activeId effect to remove", () => {
      // A synchronous delete would drop the shield mid-event: the global
      // escape dispatcher reads it during the same keydown propagation to
      // keep a drag-canceling Escape from also popping the escape stack.
      const { result } = renderHook(() => useDragRecovery());
      result.current.beginDrag(mouseActivator());
      result.current.finishDrag();
      expect(document.documentElement.dataset.dragging).toBe("true");
    });

    it("stamps the shield for non-mouse drags too", () => {
      const { result } = renderHook(() => useDragRecovery());
      result.current.beginDrag(new KeyboardEvent("keydown", { code: "Enter" }));
      expect(document.documentElement.dataset.dragging).toBe("true");
    });

    it("removes data-dragging when the hook unmounts mid-drag", () => {
      const { result, unmount } = renderHook(() => useDragRecovery());
      result.current.beginDrag(mouseActivator());
      act(() => unmount());
      expect(document.documentElement.dataset.dragging).toBeUndefined();
    });
  });

  describe("pointer-left-document grace timer", () => {
    it("dispatches exactly one Element-targeted, code-only Escape after the grace period", () => {
      const { result } = renderHook(() => useDragRecovery());
      result.current.beginDrag(mouseActivator());
      dispatchMouseOut(null);

      vi.advanceTimersByTime(DRAG_RECOVERY_GRACE_MS - 1);
      expect(keydowns).toHaveLength(0);

      vi.advanceTimersByTime(1);
      expect(escapeCodes()).toEqual(["Escape"]);
      // Element target: capture-phase key handlers cast event.target to
      // HTMLElement and call .closest, which a Document target would break.
      expect(keydowns[0]?.target).toBe(document.body);
      // Code-only: app handlers matching event.key must not see this event.
      expect(keydowns[0]?.key).toBe("");
    });

    it("does not stack timers across repeated boundary crossings", () => {
      const { result } = renderHook(() => useDragRecovery());
      result.current.beginDrag(mouseActivator());
      dispatchMouseOut(null);
      dispatchMouseOut(null);

      vi.advanceTimersByTime(DRAG_RECOVERY_GRACE_MS * 2);
      expect(keydowns).toHaveLength(1);
    });

    it("recovers again after an unheard Escape (retry is not blocked)", () => {
      const { result } = renderHook(() => useDragRecovery());
      result.current.beginDrag(mouseActivator());
      dispatchMouseOut(null);
      vi.advanceTimersByTime(DRAG_RECOVERY_GRACE_MS);
      dispatchMouseOut(null);
      vi.advanceTimersByTime(DRAG_RECOVERY_GRACE_MS);

      expect(escapeCodes()).toEqual(["Escape", "Escape"]);
    });

    it("ignores mouseout within the document (non-null relatedTarget)", () => {
      const { result } = renderHook(() => useDragRecovery());
      result.current.beginDrag(mouseActivator());
      dispatchMouseOut(document.createElement("div"));

      vi.advanceTimersByTime(DRAG_RECOVERY_GRACE_MS);
      expect(keydowns).toHaveLength(0);
    });

    it("does not fire once the drag ended normally", () => {
      const { result } = renderHook(() => useDragRecovery());
      result.current.beginDrag(mouseActivator());
      dispatchMouseOut(null);
      result.current.finishDrag();

      vi.advanceTimersByTime(DRAG_RECOVERY_GRACE_MS);
      expect(keydowns).toHaveLength(0);
    });

    it("is defused by re-entry with the button still held", () => {
      const { result } = renderHook(() => useDragRecovery());
      result.current.beginDrag(mouseActivator());
      dispatchMouseOut(null);
      dispatchMouseMove(1);

      vi.advanceTimersByTime(DRAG_RECOVERY_GRACE_MS);
      expect(keydowns).toHaveLength(0);
    });

    it("is cleared by a new drag starting while the timer is pending", () => {
      // The second drag is mouse-activated on purpose: were the stale timer
      // left armed, its callback would still see a live mouse drag and fire.
      const { result } = renderHook(() => useDragRecovery());
      result.current.beginDrag(mouseActivator());
      dispatchMouseOut(null);
      result.current.beginDrag(mouseActivator());

      vi.advanceTimersByTime(DRAG_RECOVERY_GRACE_MS);
      expect(keydowns).toHaveLength(0);
    });

    it("does not fire after unmount", () => {
      const { result, unmount } = renderHook(() => useDragRecovery());
      result.current.beginDrag(mouseActivator());
      dispatchMouseOut(null);
      act(() => unmount());

      vi.advanceTimersByTime(DRAG_RECOVERY_GRACE_MS);
      expect(keydowns).toHaveLength(0);
    });
  });

  describe("released-elsewhere buttons check", () => {
    it("recovers immediately when a mousemove reports no buttons during a live mouse drag", () => {
      const { result } = renderHook(() => useDragRecovery());
      result.current.beginDrag(mouseActivator());
      dispatchMouseMove(0);

      expect(escapeCodes()).toEqual(["Escape"]);
    });

    it("does nothing on mousemove with buttons held", () => {
      const { result } = renderHook(() => useDragRecovery());
      result.current.beginDrag(mouseActivator());
      dispatchMouseMove(1);
      expect(keydowns).toHaveLength(0);
    });

    it("does nothing when no drag is live", () => {
      renderHook(() => useDragRecovery());
      dispatchMouseMove(0);
      dispatchMouseOut(null);
      vi.advanceTimersByTime(DRAG_RECOVERY_GRACE_MS);
      expect(keydowns).toHaveLength(0);
    });

    it("ignores mouse signals during keyboard-activated drags", () => {
      const { result } = renderHook(() => useDragRecovery());
      result.current.beginDrag(new KeyboardEvent("keydown", { code: "Enter" }));
      dispatchMouseMove(0);
      dispatchMouseOut(null);
      vi.advanceTimersByTime(DRAG_RECOVERY_GRACE_MS);
      expect(keydowns).toHaveLength(0);
    });
  });
});

// End-to-end contract with a real dnd-kit DndContext + MouseSensor: the
// watchdog's synthetic Escape must ride dnd-kit's own cancel path, release
// its internal active lock, and let the NEXT drag activate — the app-wide
// wedge #11291 describes is exactly this lock never being released.
describe("useDragRecovery + dnd-kit integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete document.documentElement.dataset.dragging;
  });

  function DraggableBox() {
    const { setNodeRef, listeners, attributes } = useDraggable({ id: "drag-1" });
    return <div ref={setNodeRef} {...listeners} {...attributes} data-testid="draggable" />;
  }

  function Harness({ onStart, onCancel }: { onStart: () => void; onCancel: () => void }) {
    const { beginDrag, finishDrag } = useDragRecovery();
    const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 8 } }));
    return (
      <DndContext
        sensors={sensors}
        onDragStart={(event: DragStartEvent) => {
          beginDrag(event.activatorEvent);
          onStart();
        }}
        onDragEnd={finishDrag}
        onDragCancel={() => {
          finishDrag();
          onCancel();
        }}
      >
        <DraggableBox />
      </DndContext>
    );
  }

  function startMouseDrag(node: HTMLElement) {
    fireEvent.mouseDown(node, { clientX: 10, clientY: 10, button: 0 });
    fireEvent.mouseMove(document, { clientX: 40, clientY: 40 });
  }

  it("recovers a lost-mouseup drag and lets the next drag activate", () => {
    const onStart = vi.fn();
    const onCancel = vi.fn();
    const { getByTestId } = render(<Harness onStart={onStart} onCancel={onCancel} />);
    const node = getByTestId("draggable");

    startMouseDrag(node);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(document.documentElement.dataset.dragging).toBe("true");

    // The mouseup lands in a webview OOPIF: the host document sees the
    // pointer leave and then nothing else.
    act(() => {
      document.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: null }));
      vi.advanceTimersByTime(DRAG_RECOVERY_GRACE_MS);
    });
    expect(onCancel).toHaveBeenCalledTimes(1);

    // The lock is released: a second drag activates.
    startMouseDrag(node);
    expect(onStart).toHaveBeenCalledTimes(2);
  });
});
