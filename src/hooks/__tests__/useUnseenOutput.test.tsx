// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

let capturedListener: (() => void) | null = null;
let currentSnapshot = { isUserScrolledBack: false, unseen: 0 };

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    subscribeUnseenOutput: vi.fn((id: string, listener: () => void) => {
      capturedListener = listener;
      return () => {
        capturedListener = null;
      };
    }),
    getUnseenOutputSnapshot: vi.fn(() => currentSnapshot),
  },
}));

import { useUnseenOutput } from "../useUnseenOutput";
import { terminalInstanceService } from "@/services/TerminalInstanceService";

describe("useUnseenOutput", () => {
  beforeEach(() => {
    capturedListener = null;
    currentSnapshot = { isUserScrolledBack: false, unseen: 0 };
    vi.clearAllMocks();
  });

  it("returns hasUnseenOutput: false when not scrolled back", () => {
    currentSnapshot = { isUserScrolledBack: false, unseen: 0 };
    const { result } = renderHook(() => useUnseenOutput("t1"));
    expect(result.current.hasUnseenOutput).toBe(false);
    expect(result.current.isUserScrolledBack).toBe(false);
  });

  it("returns hasUnseenOutput: false when scrolled back but no unseen", () => {
    currentSnapshot = { isUserScrolledBack: true, unseen: 0 };
    const { result } = renderHook(() => useUnseenOutput("t1"));
    expect(result.current.hasUnseenOutput).toBe(false);
    expect(result.current.isUserScrolledBack).toBe(true);
  });

  it("returns hasUnseenOutput: true when scrolled back with unseen output", () => {
    currentSnapshot = { isUserScrolledBack: true, unseen: 5 };
    const { result } = renderHook(() => useUnseenOutput("t1"));
    expect(result.current.hasUnseenOutput).toBe(true);
    expect(result.current.isUserScrolledBack).toBe(true);
  });

  it("re-renders when subscriber notification fires", () => {
    currentSnapshot = { isUserScrolledBack: false, unseen: 0 };
    const { result } = renderHook(() => useUnseenOutput("t1"));
    expect(result.current.hasUnseenOutput).toBe(false);

    currentSnapshot = { isUserScrolledBack: true, unseen: 1 };
    act(() => capturedListener?.());
    expect(result.current.hasUnseenOutput).toBe(true);
  });

  it("cleans up subscription on unmount", () => {
    currentSnapshot = { isUserScrolledBack: false, unseen: 0 };
    const { unmount } = renderHook(() => useUnseenOutput("t1"));
    expect(capturedListener).not.toBeNull();
    unmount();
    expect(capturedListener).toBeNull();
  });

  it("re-subscribes when id changes", () => {
    currentSnapshot = { isUserScrolledBack: false, unseen: 0 };
    const { rerender } = renderHook(({ id }) => useUnseenOutput(id), {
      initialProps: { id: "t1" },
    });

    expect(terminalInstanceService.subscribeUnseenOutput).toHaveBeenCalledWith(
      "t1",
      expect.any(Function)
    );

    rerender({ id: "t2" });
    expect(terminalInstanceService.subscribeUnseenOutput).toHaveBeenCalledWith(
      "t2",
      expect.any(Function)
    );
  });
});
