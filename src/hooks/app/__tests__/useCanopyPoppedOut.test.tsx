// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useCanopyStore } from "@/store/canopyStore";
import { useCanopyPoppedOut } from "../useCanopyPoppedOut";

afterEach(() => useCanopyStore.setState({ isOpen: false, mode: "unset", resume: null }));

describe("useCanopyPoppedOut (#16338)", () => {
  it("closes this view's dialog once another view's popped out, and stops listening when gone", () => {
    let poppedOut: () => void = () => {};
    const off = vi.fn();
    Object.defineProperty(window, "electron", {
      value: {
        canopyWindow: {
          onPoppedOut: (listener: () => void) => {
            poppedOut = listener;
            return off;
          },
        },
      },
      configurable: true,
      writable: true,
    });
    useCanopyStore.setState({ mode: "on", isOpen: true });

    const { unmount } = renderHook(() => useCanopyPoppedOut());
    poppedOut();

    expect(useCanopyStore.getState().isOpen).toBe(false);
    // A dialog already shut keeps the place it was left at for its next opening.
    const resume = { at: Date.now(), hostId: null, query: "", runId: "a", order: [] };
    useCanopyStore.setState({ resume });
    poppedOut();
    expect(useCanopyStore.getState().resume).toBe(resume);
    unmount();
    expect(off).toHaveBeenCalledTimes(1);
  });
});
