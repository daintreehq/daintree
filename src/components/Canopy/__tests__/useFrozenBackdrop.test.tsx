// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { UI_EXIT_DURATION } from "@/lib/animationUtils";
import { useFrozenBackdrop } from "../useFrozenBackdrop";

const captureBackdrop = vi.fn(async (): Promise<Uint8Array | null> => new Uint8Array([1, 2, 3]));
let nextUrl = 0;
const revoked: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  captureBackdrop.mockClear();
  revoked.length = 0;
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: { canopy: { captureBackdrop } },
  });
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: () => `blob:still-${++nextUrl}`,
    revokeObjectURL: (url: string) => revoked.push(url),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useFrozenBackdrop", () => {
  it("takes a still as the panel opens, and none while it is shut", async () => {
    const { result, rerender } = renderHook(({ open }) => useFrozenBackdrop(open), {
      initialProps: { open: false },
    });
    expect(captureBackdrop).not.toHaveBeenCalled();
    rerender({ open: true });
    await act(async () => {});
    expect(captureBackdrop).toHaveBeenCalledTimes(1);
    expect(result.current).toMatch(/^blob:still-/);
  });

  it("goes back to the live app when the window resizes under it", async () => {
    const { result } = renderHook(() => useFrozenBackdrop(true));
    await act(async () => {});
    expect(result.current).not.toBeNull();
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current).toBeNull();
  });

  it("keeps the still through the close's fade, then lets it go", async () => {
    const { result, rerender } = renderHook(({ open }) => useFrozenBackdrop(open), {
      initialProps: { open: true },
    });
    await act(async () => {});
    const still = result.current;
    rerender({ open: false });
    expect(result.current).toBe(still);
    act(() => {
      vi.advanceTimersByTime(UI_EXIT_DURATION);
    });
    expect(result.current).toBeNull();
    expect(revoked).toEqual([still]);
  });

  it("shows nothing when the view couldn't be captured", async () => {
    captureBackdrop.mockResolvedValueOnce(null);
    const { result } = renderHook(() => useFrozenBackdrop(true));
    await act(async () => {});
    expect(result.current).toBeNull();
  });
});
