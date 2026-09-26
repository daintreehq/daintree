// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAnimatedPresence } from "../useAnimatedPresence";

describe("useAnimatedPresence syncEnter", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is present and visible in the very render that opens", () => {
    const { result, rerender } = renderHook(
      ({ isOpen }) => useAnimatedPresence({ isOpen, animationDuration: 120, syncEnter: true }),
      { initialProps: { isOpen: false } }
    );
    expect(result.current).toEqual({ isVisible: false, shouldRender: false });

    rerender({ isOpen: true });
    expect(result.current).toEqual({ isVisible: true, shouldRender: true });
  });

  it("keeps rendering through the exit, then unmounts and reports it", async () => {
    const onAnimateOut = vi.fn();
    const { result, rerender } = renderHook(
      ({ isOpen }) =>
        useAnimatedPresence({ isOpen, animationDuration: 120, onAnimateOut, syncEnter: true }),
      { initialProps: { isOpen: true } }
    );

    rerender({ isOpen: false });
    expect(result.current).toEqual({ isVisible: false, shouldRender: true });
    expect(onAnimateOut).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(120);
    });
    expect(result.current.shouldRender).toBe(false);
    expect(onAnimateOut).toHaveBeenCalledTimes(1);
  });

  it("leaves the default mode's frame-delayed visibility alone", async () => {
    const { result, rerender } = renderHook(
      ({ isOpen }) => useAnimatedPresence({ isOpen, animationDuration: 120 }),
      { initialProps: { isOpen: false } }
    );

    rerender({ isOpen: true });
    expect(result.current.isVisible).toBe(false);

    await act(async () => {
      vi.advanceTimersToNextFrame();
    });
    expect(result.current).toEqual({ isVisible: true, shouldRender: true });
  });
});
