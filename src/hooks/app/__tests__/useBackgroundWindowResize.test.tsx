// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

type ResizePayload = { width: number; height: number };

const onBackgroundResizeMock = vi.hoisted(() =>
  vi.fn<(cb: (payload: ResizePayload) => void) => () => void>()
);

const applyBackgroundWindowResizeMock = vi.hoisted(() => vi.fn());
const resetBackgroundResizeBasisMock = vi.hoisted(() => vi.fn());

type LifecyclePhase = "cached" | "active" | "revealed";

const subscribeProjectViewLifecycleMock = vi.hoisted(() =>
  vi.fn<(cb: (phase: LifecyclePhase) => void) => () => void>()
);

vi.mock("@/lib/viewCacheState", () => ({
  subscribeProjectViewLifecycle: subscribeProjectViewLifecycleMock,
}));

vi.stubGlobal("window", {
  ...globalThis.window,
  electron: {
    project: {
      onBackgroundResize: onBackgroundResizeMock,
    },
  },
});

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    applyBackgroundWindowResize: applyBackgroundWindowResizeMock,
    resetBackgroundResizeBasis: resetBackgroundResizeBasisMock,
  },
}));

import { useBackgroundWindowResize } from "../useBackgroundWindowResize";

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
}

describe("useBackgroundWindowResize", () => {
  let lastCallback: ((payload: ResizePayload) => void) | null = null;
  let emitPhase: (phase: LifecyclePhase) => void;
  let unsubscribe: ReturnType<typeof vi.fn>;
  let unsubscribeLifecycle: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    unsubscribe = vi.fn();
    unsubscribeLifecycle = vi.fn();
    lastCallback = null;
    const phaseHandlers: Array<(phase: LifecyclePhase) => void> = [];
    emitPhase = (phase) => phaseHandlers.forEach((handler) => handler(phase));
    onBackgroundResizeMock.mockImplementation((cb) => {
      lastCallback = cb;
      return unsubscribe as () => void;
    });
    subscribeProjectViewLifecycleMock.mockImplementation((cb) => {
      phaseHandlers.push(cb);
      return unsubscribeLifecycle as () => void;
    });
    setVisibility("hidden");
  });

  it("subscribes on mount", () => {
    renderHook(() => useBackgroundWindowResize());
    expect(onBackgroundResizeMock).toHaveBeenCalledTimes(1);
  });

  it("forwards bounds to terminalInstanceService", () => {
    renderHook(() => useBackgroundWindowResize());

    act(() => {
      lastCallback?.({ width: 1280, height: 800 });
    });

    expect(applyBackgroundWindowResizeMock).toHaveBeenCalledWith(1280, 800);
  });

  it("ignores a missing payload", () => {
    renderHook(() => useBackgroundWindowResize());

    act(() => {
      lastCallback?.(null as unknown as ResizePayload);
    });

    expect(applyBackgroundWindowResizeMock).not.toHaveBeenCalled();
  });

  it("resets the scaling basis when the view returns to the foreground", () => {
    renderHook(() => useBackgroundWindowResize());

    setVisibility("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(resetBackgroundResizeBasisMock).toHaveBeenCalledTimes(1);
  });

  it("does not reset the basis on a hidden visibilitychange", () => {
    renderHook(() => useBackgroundWindowResize());

    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(resetBackgroundResizeBasisMock).not.toHaveBeenCalled();
  });

  it("resets the basis on every reactivation phase, not just reveal", () => {
    // A switch superseded mid-flight delivers warm-activated alone, so keying
    // the reset on "revealed" would strand the anchor for that view.
    renderHook(() => useBackgroundWindowResize());

    act(() => {
      emitPhase("active");
    });
    expect(resetBackgroundResizeBasisMock).toHaveBeenCalledTimes(1);

    act(() => {
      emitPhase("revealed");
    });
    expect(resetBackgroundResizeBasisMock).toHaveBeenCalledTimes(2);
  });

  it("does not reset the basis when the view is cached", () => {
    renderHook(() => useBackgroundWindowResize());

    act(() => {
      emitPhase("cached");
    });

    expect(resetBackgroundResizeBasisMock).not.toHaveBeenCalled();
  });

  it("unsubscribes from both signals and removes the visibility listener on unmount", () => {
    const { unmount } = renderHook(() => useBackgroundWindowResize());
    unmount();

    expect(unsubscribe).toHaveBeenCalled();
    expect(unsubscribeLifecycle).toHaveBeenCalled();

    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(resetBackgroundResizeBasisMock).not.toHaveBeenCalled();
  });
});
