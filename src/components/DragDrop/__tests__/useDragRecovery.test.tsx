// @vitest-environment jsdom
// Tests for the lost-mouseup drag watchdog (#11291). A mouseup swallowed by a
// webview OOPIF never reaches the host document, leaving dnd-kit's internal
// active lock held and every future drag silently ignored. The hook recovers
// by dispatching a synthetic Escape keydown (dnd-kit's pointer sensors match
// on `event.code`), and stamps the data-dragging webview shield synchronously
// at drag start — before React commits — to close the frame-late gap.
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DRAG_RECOVERY_GRACE_MS, useDragRecovery } from "../useDragRecovery";

const escapes: KeyboardEvent[] = [];

function captureEscape(event: KeyboardEvent) {
  if (event.code === "Escape") escapes.push(event);
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
    escapes.length = 0;
    document.addEventListener("keydown", captureEscape);
  });

  afterEach(() => {
    document.removeEventListener("keydown", captureEscape);
    vi.useRealTimers();
    delete document.documentElement.dataset.dragging;
  });

  describe("data-dragging shield", () => {
    it("stamps data-dragging synchronously on beginDrag, before any commit", () => {
      const { result } = renderHook(() => useDragRecovery());
      result.current.beginDrag(mouseActivator());
      expect(document.documentElement.dataset.dragging).toBe("true");
    });

    it("removes data-dragging on finishDrag", () => {
      const { result } = renderHook(() => useDragRecovery());
      result.current.beginDrag(mouseActivator());
      result.current.finishDrag();
      expect(document.documentElement.dataset.dragging).toBeUndefined();
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
    it("dispatches exactly one code-Escape keydown after the grace period", () => {
      const { result } = renderHook(() => useDragRecovery());
      result.current.beginDrag(mouseActivator());
      dispatchMouseOut(null);

      vi.advanceTimersByTime(DRAG_RECOVERY_GRACE_MS - 1);
      expect(escapes).toHaveLength(0);

      vi.advanceTimersByTime(1);
      expect(escapes).toHaveLength(1);
      expect(escapes[0]?.code).toBe("Escape");
    });

    it("does not stack timers across repeated boundary crossings", () => {
      const { result } = renderHook(() => useDragRecovery());
      result.current.beginDrag(mouseActivator());
      dispatchMouseOut(null);
      dispatchMouseOut(null);

      vi.advanceTimersByTime(DRAG_RECOVERY_GRACE_MS * 2);
      expect(escapes).toHaveLength(1);
    });

    it("ignores mouseout within the document (non-null relatedTarget)", () => {
      const { result } = renderHook(() => useDragRecovery());
      result.current.beginDrag(mouseActivator());
      dispatchMouseOut(document.createElement("div"));

      vi.advanceTimersByTime(DRAG_RECOVERY_GRACE_MS);
      expect(escapes).toHaveLength(0);
    });

    it("does not fire once the drag ended normally", () => {
      const { result } = renderHook(() => useDragRecovery());
      result.current.beginDrag(mouseActivator());
      dispatchMouseOut(null);
      result.current.finishDrag();

      vi.advanceTimersByTime(DRAG_RECOVERY_GRACE_MS);
      expect(escapes).toHaveLength(0);
    });

    it("is defused by re-entry with the button still held", () => {
      const { result } = renderHook(() => useDragRecovery());
      result.current.beginDrag(mouseActivator());
      dispatchMouseOut(null);
      dispatchMouseMove(1);

      vi.advanceTimersByTime(DRAG_RECOVERY_GRACE_MS);
      expect(escapes).toHaveLength(0);
    });

    it("does not fire after unmount", () => {
      const { result, unmount } = renderHook(() => useDragRecovery());
      result.current.beginDrag(mouseActivator());
      dispatchMouseOut(null);
      act(() => unmount());

      vi.advanceTimersByTime(DRAG_RECOVERY_GRACE_MS);
      expect(escapes).toHaveLength(0);
    });
  });

  describe("released-elsewhere buttons check", () => {
    it("recovers immediately when a mousemove reports no buttons during a live mouse drag", () => {
      const { result } = renderHook(() => useDragRecovery());
      result.current.beginDrag(mouseActivator());
      dispatchMouseMove(0);

      expect(escapes).toHaveLength(1);
      expect(escapes[0]?.code).toBe("Escape");
    });

    it("does nothing on mousemove with buttons held", () => {
      const { result } = renderHook(() => useDragRecovery());
      result.current.beginDrag(mouseActivator());
      dispatchMouseMove(1);
      expect(escapes).toHaveLength(0);
    });

    it("does nothing when no drag is live", () => {
      renderHook(() => useDragRecovery());
      dispatchMouseMove(0);
      dispatchMouseOut(null);
      vi.advanceTimersByTime(DRAG_RECOVERY_GRACE_MS);
      expect(escapes).toHaveLength(0);
    });

    it("ignores mouse signals during keyboard-activated drags", () => {
      const { result } = renderHook(() => useDragRecovery());
      result.current.beginDrag(new KeyboardEvent("keydown", { code: "Enter" }));
      dispatchMouseMove(0);
      dispatchMouseOut(null);
      vi.advanceTimersByTime(DRAG_RECOVERY_GRACE_MS);
      expect(escapes).toHaveLength(0);
    });
  });
});
