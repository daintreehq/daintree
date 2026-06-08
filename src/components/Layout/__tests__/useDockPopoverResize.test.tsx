// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";

// Keep persistence IPC out of the unit under test.
vi.mock("@/clients", () => ({
  appClient: { setState: vi.fn().mockResolvedValue(undefined) },
}));

import { useDockPopoverResize } from "../useDockPopoverResize";
import {
  useDockStore,
  POPOVER_DEFAULT_HEIGHT,
  POPOVER_MIN_HEIGHT,
  POPOVER_MAX_HEIGHT_RATIO,
} from "@/store/dockStore";

const maxHeight = () => Math.round(window.innerHeight * POPOVER_MAX_HEIGHT_RATIO);

function mouseDownAt(
  handleProps: ReturnType<typeof useDockPopoverResize>["handleProps"],
  y: number
) {
  act(() => {
    handleProps.onMouseDown({
      preventDefault: vi.fn(),
      clientY: y,
      button: 0,
    } as unknown as React.MouseEvent);
  });
}

function moveTo(y: number) {
  act(() => {
    document.dispatchEvent(new MouseEvent("mousemove", { clientY: y }));
  });
}

function mouseUp() {
  act(() => {
    document.dispatchEvent(new MouseEvent("mouseup"));
  });
}

describe("useDockPopoverResize", () => {
  beforeEach(() => {
    // jsdom defaults innerHeight to 768; pin it so clamp math is deterministic.
    Object.defineProperty(window, "innerHeight", { value: 1000, configurable: true });
    act(() => {
      useDockStore.setState({ popoverHeight: POPOVER_DEFAULT_HEIGHT });
    });
  });

  afterEach(() => {
    // Release any in-flight drag (tests that assert the live draft height never
    // call mouseup), then unmount so the drag effect cleanup detaches its
    // document listeners — otherwise a leaked mouseup handler fires in the next
    // test and pollutes its assertions.
    act(() => {
      document.dispatchEvent(new MouseEvent("mouseup"));
    });
    cleanup();
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });

  it("drag up (smaller clientY) increases height", () => {
    const { result } = renderHook(() => useDockPopoverResize());
    mouseDownAt(result.current.handleProps, 500);
    moveTo(400); // moved up 100px
    expect(result.current.height).toBe(POPOVER_DEFAULT_HEIGHT + 100);
  });

  it("drag down (larger clientY) decreases height", () => {
    const { result } = renderHook(() => useDockPopoverResize());
    mouseDownAt(result.current.handleProps, 500);
    moveTo(600); // moved down 100px
    expect(result.current.height).toBe(POPOVER_DEFAULT_HEIGHT - 100);
  });

  it("clamps to the minimum height", () => {
    const { result } = renderHook(() => useDockPopoverResize());
    mouseDownAt(result.current.handleProps, 500);
    moveTo(5000); // far down — well below the minimum
    expect(result.current.height).toBe(POPOVER_MIN_HEIGHT);
  });

  it("clamps to the viewport-relative maximum height", () => {
    const { result } = renderHook(() => useDockPopoverResize());
    mouseDownAt(result.current.handleProps, 500);
    moveTo(-5000); // far up — well above the maximum
    expect(result.current.height).toBe(window.innerHeight * POPOVER_MAX_HEIGHT_RATIO);
  });

  it("commits to the store exactly once, at mouseup", () => {
    const spy = vi.spyOn(useDockStore.getState(), "setPopoverHeight");
    const { result } = renderHook(() => useDockPopoverResize());
    mouseDownAt(result.current.handleProps, 500);
    moveTo(450);
    moveTo(400);
    moveTo(350);
    // Live draft tracks the pointer, but the persisted store value has not moved.
    expect(useDockStore.getState().popoverHeight).toBe(POPOVER_DEFAULT_HEIGHT);
    expect(spy).not.toHaveBeenCalled();

    mouseUp();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(useDockStore.getState().popoverHeight).toBe(POPOVER_DEFAULT_HEIGHT + 150);
    spy.mockRestore();
  });

  it("invokes onCommit once the gesture settles", () => {
    const onCommit = vi.fn();
    const { result } = renderHook(() => useDockPopoverResize(onCommit));
    mouseDownAt(result.current.handleProps, 500);
    moveTo(400);
    expect(onCommit).not.toHaveBeenCalled();
    mouseUp();
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("restores the body cursor and userSelect after a drag", () => {
    const { result } = renderHook(() => useDockPopoverResize());
    mouseDownAt(result.current.handleProps, 500);
    expect(document.body.style.cursor).toBe("row-resize");
    expect(document.body.style.userSelect).toBe("none");
    moveTo(400);
    mouseUp();
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });

  it("restores the body cursor when the popover unmounts mid-drag", () => {
    const { result, unmount } = renderHook(() => useDockPopoverResize());
    mouseDownAt(result.current.handleProps, 500);
    moveTo(400);
    expect(document.body.style.cursor).toBe("row-resize");
    // Popover closes via Escape/outside-click before mouseup fires.
    unmount();
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });

  it("steps the height with ArrowUp / ArrowDown", () => {
    const onCommit = vi.fn();
    const { result } = renderHook(() => useDockPopoverResize(onCommit));
    act(() => {
      result.current.handleProps.onKeyDown({
        key: "ArrowUp",
        preventDefault: vi.fn(),
      } as unknown as React.KeyboardEvent);
    });
    expect(useDockStore.getState().popoverHeight).toBe(POPOVER_DEFAULT_HEIGHT + 10);

    act(() => {
      result.current.handleProps.onKeyDown({
        key: "ArrowDown",
        preventDefault: vi.fn(),
      } as unknown as React.KeyboardEvent);
    });
    expect(useDockStore.getState().popoverHeight).toBe(POPOVER_DEFAULT_HEIGHT);
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it("does not commit when the pointer is released without moving", () => {
    // onCommit is unique to this hook instance, so it isolates this gesture from
    // any drag listeners other tests may have left attached to document.
    const onCommit = vi.fn();
    const { result } = renderHook(() => useDockPopoverResize(onCommit));
    mouseDownAt(result.current.handleProps, 500);
    mouseUp(); // released at the same position
    expect(onCommit).not.toHaveBeenCalled();
    expect(result.current.height).toBe(POPOVER_DEFAULT_HEIGHT);
  });

  it("ignores non-primary mouse buttons", () => {
    const { result } = renderHook(() => useDockPopoverResize());
    act(() => {
      result.current.handleProps.onMouseDown({
        preventDefault: vi.fn(),
        clientY: 500,
        button: 2, // right-click
      } as unknown as React.MouseEvent);
    });
    expect(result.current.isResizing).toBe(false);
    expect(document.body.style.cursor).toBe("");
  });

  it("does not fire onCommit when ArrowDown is pressed at the minimum", () => {
    act(() => {
      useDockStore.setState({ popoverHeight: POPOVER_MIN_HEIGHT });
    });
    const onCommit = vi.fn();
    const { result } = renderHook(() => useDockPopoverResize(onCommit));
    act(() => {
      result.current.handleProps.onKeyDown({
        key: "ArrowDown",
        preventDefault: vi.fn(),
      } as unknown as React.KeyboardEvent);
    });
    expect(useDockStore.getState().popoverHeight).toBe(POPOVER_MIN_HEIGHT);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("ignores document mouse events after unmount mid-drag", () => {
    const spy = vi.spyOn(useDockStore.getState(), "setPopoverHeight");
    const onCommit = vi.fn();
    const { result, unmount } = renderHook(() => useDockPopoverResize(onCommit));
    mouseDownAt(result.current.handleProps, 500);
    moveTo(400);
    unmount();
    spy.mockClear();
    moveTo(300);
    mouseUp();
    expect(spy).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("resets to the default height on double-click", () => {
    act(() => {
      useDockStore.setState({ popoverHeight: 420 });
    });
    const { result } = renderHook(() => useDockPopoverResize());
    act(() => {
      result.current.handleProps.onDoubleClick();
    });
    expect(useDockStore.getState().popoverHeight).toBe(POPOVER_DEFAULT_HEIGHT);
  });

  it("exposes accurate ARIA bounds on the handle", () => {
    const { result } = renderHook(() => useDockPopoverResize());
    expect(result.current.handleProps.role).toBe("separator");
    expect(result.current.handleProps["aria-orientation"]).toBe("horizontal");
    expect(result.current.handleProps["aria-valuemin"]).toBe(POPOVER_MIN_HEIGHT);
    expect(result.current.handleProps["aria-valuemax"]).toBe(maxHeight());
    expect(result.current.handleProps["aria-valuenow"]).toBe(POPOVER_DEFAULT_HEIGHT);
  });
});
