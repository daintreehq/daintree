// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const setLifecycleStateMock = vi.fn(() => Promise.resolve());

vi.mock("@/store", () => ({
  usePanelStore: vi.fn(),
}));

import { usePanelStore } from "@/store";
import { useWebviewThrottle } from "../useWebviewThrottle";

function makeWebviewEl(webContentsId = 1) {
  return {
    getWebContentsId: vi.fn(() => webContentsId),
  } as unknown as Electron.WebviewTag;
}

describe("useWebviewThrottle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setLifecycleStateMock.mockClear();
    Object.defineProperty(window, "electron", {
      value: { webview: { setLifecycleState: setLifecycleStateMock } },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function mockStore(activeDockTerminalId: string | null) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(usePanelStore).mockImplementation((selector: (s: any) => unknown) =>
      selector({ activeDockTerminalId })
    );
  }

  it("freezes webview after 500ms delay when in dock and not active", async () => {
    mockStore("other-panel");
    const webviewEl = makeWebviewEl();

    renderHook(() => useWebviewThrottle("panel-1", "dock", webviewEl, true));

    expect(setLifecycleStateMock).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(setLifecycleStateMock).toHaveBeenCalledWith(1, true);
  });

  it("unfreezes immediately when panel moves to grid", () => {
    mockStore(null);
    const webviewEl = makeWebviewEl();

    renderHook(() => useWebviewThrottle("panel-1", "grid", webviewEl, true));

    expect(setLifecycleStateMock).toHaveBeenCalledWith(1, false);
  });

  it("unfreezes immediately when panel becomes the active dock terminal", () => {
    mockStore("panel-1");
    const webviewEl = makeWebviewEl();

    renderHook(() => useWebviewThrottle("panel-1", "dock", webviewEl, true));

    expect(setLifecycleStateMock).toHaveBeenCalledWith(1, false);
  });

  it("does not call IPC when webview is not ready", async () => {
    mockStore("other-panel");
    const webviewEl = makeWebviewEl();

    renderHook(() => useWebviewThrottle("panel-1", "dock", webviewEl, false));

    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(setLifecycleStateMock).not.toHaveBeenCalled();
  });

  it("does not call IPC when webviewElement is null", async () => {
    mockStore("other-panel");

    renderHook(() => useWebviewThrottle("panel-1", "dock", null, true));

    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(setLifecycleStateMock).not.toHaveBeenCalled();
  });

  it("cancels pending freeze when panel becomes active before 500ms", () => {
    mockStore("other-panel");
    const webviewEl = makeWebviewEl();

    const { rerender } = renderHook(
      ({ activeDockId }: { activeDockId: string | null }) => {
        mockStore(activeDockId);
        return useWebviewThrottle("panel-1", "dock", webviewEl, true);
      },
      { initialProps: { activeDockId: "other-panel" } }
    );

    // Advance partway — freeze timer is pending
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(setLifecycleStateMock).not.toHaveBeenCalled();

    // Panel becomes the active dock terminal
    rerender({ activeDockId: "panel-1" });

    // Now it should unfreeze immediately, not freeze
    expect(setLifecycleStateMock).toHaveBeenCalledWith(1, false);

    // Advance past original timer — should not freeze
    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(setLifecycleStateMock).toHaveBeenCalledTimes(1);
    expect(setLifecycleStateMock).toHaveBeenCalledWith(1, false);
  });

  it("uses the latest webviewElement when element is swapped mid-freeze-delay", () => {
    mockStore("other-panel");
    const el1 = makeWebviewEl(10);
    const el2 = makeWebviewEl(20);

    const { rerender } = renderHook(
      ({ el }: { el: Electron.WebviewTag }) => useWebviewThrottle("panel-1", "dock", el, true),
      { initialProps: { el: el1 } }
    );

    // Partway through the freeze delay, the element is replaced
    act(() => {
      vi.advanceTimersByTime(200);
    });

    rerender({ el: el2 });

    // Advance past the new timer — should use el2's webContentsId
    act(() => {
      vi.advanceTimersByTime(500);
    });

    // Should freeze with the new element's ID, not the old one
    expect(setLifecycleStateMock).not.toHaveBeenCalledWith(10, true);
    expect(setLifecycleStateMock).toHaveBeenCalledWith(20, true);
  });
});
