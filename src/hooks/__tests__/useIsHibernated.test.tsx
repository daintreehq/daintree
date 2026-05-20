// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

let capturedListener: (() => void) | null = null;
let currentHibernated = false;

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    subscribeHibernation: vi.fn((_id: string, listener: () => void) => {
      capturedListener = listener;
      return () => {
        capturedListener = null;
      };
    }),
    isHibernated: vi.fn(() => currentHibernated),
  },
}));

import { useIsHibernated } from "../useIsHibernated";
import { terminalInstanceService } from "@/services/TerminalInstanceService";

describe("useIsHibernated", () => {
  beforeEach(() => {
    capturedListener = null;
    currentHibernated = false;
    vi.clearAllMocks();
  });

  it("returns the current hibernation state", () => {
    currentHibernated = false;
    const { result: r1 } = renderHook(() => useIsHibernated("t1"));
    expect(r1.current).toBe(false);

    currentHibernated = true;
    const { result: r2 } = renderHook(() => useIsHibernated("t1"));
    expect(r2.current).toBe(true);
  });

  it("re-renders when subscriber notification fires", () => {
    currentHibernated = false;
    const { result } = renderHook(() => useIsHibernated("t1"));
    expect(result.current).toBe(false);

    currentHibernated = true;
    act(() => capturedListener?.());
    expect(result.current).toBe(true);

    currentHibernated = false;
    act(() => capturedListener?.());
    expect(result.current).toBe(false);
  });

  it("cleans up subscription on unmount", () => {
    const { unmount } = renderHook(() => useIsHibernated("t1"));
    expect(capturedListener).not.toBeNull();
    unmount();
    expect(capturedListener).toBeNull();
  });

  it("re-subscribes when id changes", () => {
    const { rerender } = renderHook(({ id }) => useIsHibernated(id), {
      initialProps: { id: "t1" },
    });

    expect(terminalInstanceService.subscribeHibernation).toHaveBeenCalledWith(
      "t1",
      expect.any(Function)
    );

    rerender({ id: "t2" });
    expect(terminalInstanceService.subscribeHibernation).toHaveBeenCalledWith(
      "t2",
      expect.any(Function)
    );
  });
});
