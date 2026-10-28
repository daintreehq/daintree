// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

let capturedListener: (() => void) | null = null;
let currentSnapshot = { isUserScrolledBack: false, unseen: 0 };
let currentLastWheelAt = 0;

vi.mock("@/services/TerminalInstanceService", () => {
  const terminalInstanceService = {
    subscribeUnseenOutput: vi.fn((_id: string, listener: () => void) => {
      capturedListener = listener;
      return () => {
        capturedListener = null;
      };
    }),
    getUnseenOutputSnapshot: vi.fn(() => currentSnapshot),
    getLastWheelAt: vi.fn(() => currentLastWheelAt),
  };
  return {
    createTerminalPaintPlane: () => terminalInstanceService,
  };
});

import { useUnseenOutput } from "../useUnseenOutput";
import { createTerminalPaintPlane } from "@/services/TerminalInstanceService";
import {
  __testing as terminalServiceTesting,
  register as registerTerminalService,
} from "@/services/terminal/terminalInstanceServiceAccessor";

const terminalInstanceService = createTerminalPaintPlane();

const service = terminalInstanceService;

describe("useUnseenOutput", () => {
  beforeEach(() => {
    capturedListener = null;
    currentSnapshot = { isUserScrolledBack: false, unseen: 0 };
    currentLastWheelAt = 0;
    vi.clearAllMocks();
    terminalServiceTesting.reset();
    registerTerminalService(service);
  });

  it("returns hasUnseenOutput: false when not scrolled back", () => {
    currentSnapshot = { isUserScrolledBack: false, unseen: 0 };
    const { result } = renderHook(() => useUnseenOutput("t1"));
    expect(result.current.hasUnseenOutput).toBe(false);
    expect(result.current.isUserScrolledBack).toBe(false);
  });

  it("returns hasUnseenOutput: false when unseen is at or below the hysteresis threshold", () => {
    currentSnapshot = { isUserScrolledBack: true, unseen: 1 };
    const { result: r1 } = renderHook(() => useUnseenOutput("t1"));
    expect(r1.current.hasUnseenOutput).toBe(false);

    currentSnapshot = { isUserScrolledBack: true, unseen: 2 };
    const { result: r2 } = renderHook(() => useUnseenOutput("t1"));
    expect(r2.current.hasUnseenOutput).toBe(false);
  });

  it("returns hasUnseenOutput: true when scrolled back with unseen above threshold", () => {
    currentSnapshot = { isUserScrolledBack: true, unseen: 5 };
    const { result } = renderHook(() => useUnseenOutput("t1"));
    expect(result.current.hasUnseenOutput).toBe(true);
    expect(result.current.isUserScrolledBack).toBe(true);
  });

  it("suppresses hasUnseenOutput while a wheel event fired within the suppression window", () => {
    currentSnapshot = { isUserScrolledBack: true, unseen: 5 };
    currentLastWheelAt = Date.now() - 50; // 50ms ago — inside 200ms window
    const { result } = renderHook(() => useUnseenOutput("t1"));
    expect(result.current.hasUnseenOutput).toBe(false);
  });

  it("shows hasUnseenOutput again after the wheel suppression window elapses", () => {
    currentSnapshot = { isUserScrolledBack: true, unseen: 5 };
    currentLastWheelAt = Date.now() - 500; // 500ms ago — well past 200ms window
    const { result } = renderHook(() => useUnseenOutput("t1"));
    expect(result.current.hasUnseenOutput).toBe(true);
  });

  it("re-renders when subscriber notification fires", () => {
    currentSnapshot = { isUserScrolledBack: false, unseen: 0 };
    const { result } = renderHook(() => useUnseenOutput("t1"));
    expect(result.current.hasUnseenOutput).toBe(false);

    currentSnapshot = { isUserScrolledBack: true, unseen: 3 };
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

describe("useUnseenOutput before the terminal service loads", () => {
  beforeEach(() => {
    capturedListener = null;
    currentSnapshot = { isUserScrolledBack: true, unseen: 5 };
    currentLastWheelAt = 0;
    vi.clearAllMocks();
    terminalServiceTesting.reset();
  });

  it("reports nothing unseen and reads no service", () => {
    const { result } = renderHook(() => useUnseenOutput("t1"));
    expect(result.current).toEqual({ isUserScrolledBack: false, hasUnseenOutput: false });
    expect(terminalInstanceService.subscribeUnseenOutput).not.toHaveBeenCalled();
    expect(terminalInstanceService.getUnseenOutputSnapshot).not.toHaveBeenCalled();
  });

  it("subscribes and reports the service's values once it is ready", () => {
    const { result } = renderHook(() => useUnseenOutput("t1"));
    expect(result.current.hasUnseenOutput).toBe(false);

    act(() => registerTerminalService(service));
    expect(terminalInstanceService.subscribeUnseenOutput).toHaveBeenCalledWith(
      "t1",
      expect.any(Function)
    );
    expect(result.current.hasUnseenOutput).toBe(true);

    currentSnapshot = { isUserScrolledBack: false, unseen: 0 };
    act(() => capturedListener?.());
    expect(result.current.hasUnseenOutput).toBe(false);
  });

  it("leaves no listener behind when unmounted before ready", () => {
    const { unmount } = renderHook(() => useUnseenOutput("t1"));
    unmount();

    registerTerminalService(service);
    expect(terminalInstanceService.subscribeUnseenOutput).not.toHaveBeenCalled();
    expect(capturedListener).toBeNull();
  });
});
