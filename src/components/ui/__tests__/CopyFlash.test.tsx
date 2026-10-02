// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({ isOpen }: { isOpen: boolean }) => ({
    isVisible: isOpen,
    shouldRender: isOpen,
  }),
}));

const viewMock = vi.hoisted(() => {
  const listeners = new Set<(observable: boolean) => void>();
  return {
    listeners,
    isProjectViewObservable: vi.fn(() => true),
    subscribeProjectViewObservability: vi.fn((listener: (observable: boolean) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
});
vi.mock("@/lib/viewCacheState", () => ({
  isProjectViewObservable: viewMock.isProjectViewObservable,
  subscribeProjectViewObservability: viewMock.subscribeProjectViewObservability,
}));

import { UI_ACTION_SUCCESS_DWELL_MS } from "@/lib/animationUtils";
import { _resetCopyFlashForTests, captureCopyFlash, showCopyFlash } from "@/lib/copyFlash";
import { CopyFlash } from "../CopyFlash";

const card = () => document.querySelector<HTMLElement>("[data-copy-flash]");

function flash() {
  act(() => showCopyFlash(captureCopyFlash()));
}

describe("CopyFlash", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetCopyFlashForTests();
    viewMock.listeners.clear();
    viewMock.isProjectViewObservable.mockReturnValue(true);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1000 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
  });

  afterEach(() => {
    cleanup();
    _resetCopyFlashForTests();
    vi.useRealTimers();
  });

  it("says Copied beside the pointer, hidden from assistive tech and the pointer", () => {
    render(<CopyFlash />);
    fireEvent.pointerDown(document.body, { clientX: 300, clientY: 400 });
    flash();

    const el = card();
    expect(el).not.toBeNull();
    expect(el!.textContent).toBe("Copied");
    expect(el!.getAttribute("aria-hidden")).toBe("true");
    expect(el!.className).toContain("pointer-events-none");
    expect(el!.getAttribute("role")).toBeNull();
    // Above the pointer.
    expect(parseFloat(el!.style.top)).toBeLessThan(400);
  });

  it("flips below an origin at the top edge and stays inside the viewport", () => {
    render(<CopyFlash />);
    fireEvent.pointerDown(document.body, { clientX: 995, clientY: 4 });
    flash();

    const el = card()!;
    expect(parseFloat(el.style.top)).toBeGreaterThan(4);
    expect(parseFloat(el.style.left)).toBeLessThanOrEqual(1000 - 8);
  });

  it("sits bottom-centre when there is no origin", () => {
    render(<CopyFlash />);
    flash();

    const el = card()!;
    expect(parseFloat(el.style.top)).toBeGreaterThan(600);
  });

  it("is gone after the success dwell", () => {
    render(<CopyFlash />);
    flash();
    expect(card()).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(UI_ACTION_SUCCESS_DWELL_MS);
    });
    expect(card()).toBeNull();
  });

  it("shows one card for repeated copies", () => {
    render(<CopyFlash />);
    flash();
    flash();
    expect(document.querySelectorAll("[data-copy-flash]")).toHaveLength(1);
  });

  it("clears when the view is switched away and does not come back with it", () => {
    render(<CopyFlash />);
    flash();
    const pending = captureCopyFlash();

    act(() => {
      for (const listener of viewMock.listeners) listener(false);
    });
    expect(card()).toBeNull();

    act(() => {
      for (const listener of viewMock.listeners) listener(true);
      showCopyFlash(pending);
    });
    expect(card()).toBeNull();
  });

  it("leaves when the user scrolls the content under it", () => {
    render(<CopyFlash />);
    flash();
    fireEvent.wheel(document.body);
    expect(card()).toBeNull();
  });

  it("removes its listeners on unmount", () => {
    const { unmount } = render(<CopyFlash />);
    expect(viewMock.listeners.size).toBe(1);
    unmount();
    expect(viewMock.listeners.size).toBe(0);
  });
});
