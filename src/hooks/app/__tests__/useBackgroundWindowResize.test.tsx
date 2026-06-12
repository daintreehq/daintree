// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

type ResizePayload = { width: number; height: number };

const onBackgroundResizeMock = vi.hoisted(() =>
  vi.fn<(cb: (payload: ResizePayload) => void) => () => void>()
);

const applyBackgroundWindowResizeMock = vi.hoisted(() => vi.fn());
const resetBackgroundResizeBasisMock = vi.hoisted(() => vi.fn());

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
  let unsubscribe: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    unsubscribe = vi.fn();
    lastCallback = null;
    onBackgroundResizeMock.mockImplementation((cb) => {
      lastCallback = cb;
      return unsubscribe as () => void;
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

  it("unsubscribes and removes the visibility listener on unmount", () => {
    const { unmount } = renderHook(() => useBackgroundWindowResize());
    unmount();

    expect(unsubscribe).toHaveBeenCalled();

    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(resetBackgroundResizeBasisMock).not.toHaveBeenCalled();
  });
});
