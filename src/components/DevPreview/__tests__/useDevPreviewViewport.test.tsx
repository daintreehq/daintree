/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDevPreviewViewport } from "../useDevPreviewViewport";

const PANE_ID = "pane-1";

// Emulation runs in the main process now: the renderer only hands over the
// guest id. A webview tag never had `getWebContents()` — mocking it is what let
// the broken code path pass its tests (#12298).
const setDeviceEmulation = vi.fn<(payload: unknown) => Promise<{ applied: boolean }>>(() =>
  Promise.resolve({ applied: true })
);
const registerPanel = vi.fn<() => Promise<void>>(() => Promise.resolve());

function makeWebview(webContentsId = 42): Electron.WebviewTag {
  return {
    getWebContentsId: vi.fn(() => webContentsId),
  } as unknown as Electron.WebviewTag;
}

function makeDetachedWebview(): Electron.WebviewTag {
  return {
    getWebContentsId: vi.fn(() => {
      throw new Error("The WebView must be attached to the DOM");
    }),
  } as unknown as Electron.WebviewTag;
}

/**
 * Drain the register→apply→record promise chain. Each apply crosses several
 * microtask boundaries now that registration is chained ahead of it, so a
 * fixed couple of `Promise.resolve()` turns would be passing by luck.
 */
async function settleEmulation() {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
}

function emulationCalls() {
  return setDeviceEmulation.mock.calls.map(
    ([payload]) => payload as { webContentsId: number; panelId: string; emulation: unknown }
  );
}

function baseParams(overrides: Partial<Parameters<typeof useDevPreviewViewport>[0]> = {}) {
  return {
    id: PANE_ID,
    viewportPreset: undefined,
    viewportRotated: false,
    viewportDpr: 1 as const,
    viewportFit: false,
    isWebviewReady: false,
    webviewElement: null,
    setViewportPreset: vi.fn(),
    setViewportRotated: vi.fn(),
    setViewportDpr: vi.fn(),
    setViewportFit: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  setDeviceEmulation.mockClear();
  setDeviceEmulation.mockResolvedValue({ applied: true });
  registerPanel.mockClear();
  registerPanel.mockResolvedValue(undefined);
  (globalThis as unknown as { window: { electron: unknown } }).window.electron = {
    webview: { setDeviceEmulation, registerPanel },
  };
  class ResizeObserverStub {
    observe = vi.fn();
    disconnect = vi.fn();
    unobserve = vi.fn();
  }
  (global as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
});

describe("useDevPreviewViewport — handlers", () => {
  it("delegates preset/rotate/dpr/fit toggles to their setters with the panel id", () => {
    const setViewportPreset = vi.fn();
    const setViewportRotated = vi.fn();
    const setViewportDpr = vi.fn();
    const setViewportFit = vi.fn();
    const { result } = renderHook(() =>
      useDevPreviewViewport(
        baseParams({ setViewportPreset, setViewportRotated, setViewportDpr, setViewportFit })
      )
    );

    act(() => result.current.handleViewportPresetChange("iphone"));
    expect(setViewportPreset).toHaveBeenCalledWith(PANE_ID, "iphone");

    act(() => result.current.handleViewportRotateToggle());
    expect(setViewportRotated).toHaveBeenCalledWith(PANE_ID, true);

    act(() => result.current.handleViewportDprChange(2));
    expect(setViewportDpr).toHaveBeenCalledWith(PANE_ID, 2);

    act(() => result.current.handleViewportFitToggle());
    expect(setViewportFit).toHaveBeenCalledWith(PANE_ID, true);
  });
});

describe("useDevPreviewViewport — effectiveViewport / fitScale", () => {
  it("is null when no preset is active", () => {
    const { result } = renderHook(() => useDevPreviewViewport(baseParams()));
    expect(result.current.effectiveViewport).toBeNull();
    expect(result.current.fitScale).toBe(1);
  });

  it("computes effective dimensions for a preset, swapped when rotated", () => {
    const { result: portrait } = renderHook(() =>
      useDevPreviewViewport(baseParams({ viewportPreset: "iphone", viewportRotated: false }))
    );
    expect(portrait.current.effectiveViewport).toEqual({ width: 393, height: 852 });

    const { result: landscape } = renderHook(() =>
      useDevPreviewViewport(baseParams({ viewportPreset: "iphone", viewportRotated: true }))
    );
    expect(landscape.current.effectiveViewport).toEqual({ width: 852, height: 393 });
  });

  it("stays at scale 1 when fit mode is off even with a preset active", () => {
    const { result } = renderHook(() =>
      useDevPreviewViewport(baseParams({ viewportPreset: "iphone", viewportFit: false }))
    );
    expect(result.current.fitScale).toBe(1);
  });

  it("measures the fit container via ResizeObserver.observe and computes fitScale from its size", () => {
    const observeSpy = vi.fn();
    class ResizeObserverStub {
      observe = observeSpy;
      disconnect = vi.fn();
      unobserve = vi.fn();
    }
    (global as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;

    const { result } = renderHook(() =>
      useDevPreviewViewport(baseParams({ viewportPreset: "iphone", viewportFit: true }))
    );

    const div = document.createElement("div");
    Object.defineProperty(div, "clientWidth", { value: 200, configurable: true });
    Object.defineProperty(div, "clientHeight", { value: 400, configurable: true });

    act(() => {
      result.current.setFitContainerEl(div);
    });

    expect(observeSpy).toHaveBeenCalledWith(div);
    // iphone effective viewport is 393x852; container is 200x400.
    const expectedScale = Math.min(200 / 393, 400 / 852);
    expect(result.current.fitScale).toBeCloseTo(expectedScale, 5);
  });

  it("does not measure or apply a fit scale when fit mode is off, even once a container mounts", () => {
    const observeSpy = vi.fn();
    class ResizeObserverStub {
      observe = observeSpy;
      disconnect = vi.fn();
      unobserve = vi.fn();
    }
    (global as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;

    const { result } = renderHook(() =>
      useDevPreviewViewport(baseParams({ viewportPreset: "iphone", viewportFit: false }))
    );

    const div = document.createElement("div");
    Object.defineProperty(div, "clientWidth", { value: 200, configurable: true });
    Object.defineProperty(div, "clientHeight", { value: 400, configurable: true });

    act(() => {
      result.current.setFitContainerEl(div);
    });

    expect(observeSpy).not.toHaveBeenCalled();
    expect(result.current.fitScale).toBe(1);
  });
});

describe("useDevPreviewViewport — device emulation effect", () => {
  it("does nothing while the webview isn't ready", () => {
    renderHook(() =>
      useDevPreviewViewport(
        baseParams({
          viewportPreset: "iphone",
          isWebviewReady: false,
          webviewElement: makeWebview(),
        })
      )
    );
    expect(setDeviceEmulation).not.toHaveBeenCalled();
  });

  it("sends the preset's metrics, user agent and touch flag keyed by guest id", async () => {
    renderHook(() =>
      useDevPreviewViewport(
        baseParams({
          viewportPreset: "iphone",
          viewportDpr: 3,
          isWebviewReady: true,
          webviewElement: makeWebview(7),
        })
      )
    );

    await settleEmulation();

    expect(emulationCalls()).toEqual([
      {
        webContentsId: 7,
        panelId: PANE_ID,
        emulation: {
          params: {
            screenPosition: "mobile",
            screenSize: { width: 393, height: 852 },
            viewPosition: { x: 0, y: 0 },
            deviceScaleFactor: 3,
            viewSize: { width: 393, height: 852 },
            scale: 1,
          },
          userAgent: expect.stringContaining("iPhone"),
          touch: true,
        },
      },
    ]);
  });

  it("swaps width and height when the preset is rotated", async () => {
    renderHook(() =>
      useDevPreviewViewport(
        baseParams({
          viewportPreset: "iphone",
          viewportRotated: true,
          isWebviewReady: true,
          webviewElement: makeWebview(),
        })
      )
    );

    await settleEmulation();

    const firstCall = emulationCalls()[0];
    if (!firstCall) throw new Error("expected a device-emulation call");
    const emulation = firstCall.emulation as {
      params: { viewSize: { width: number; height: number } };
    };
    expect(emulation.params.viewSize).toEqual({ width: 852, height: 393 });
  });

  it("clears emulation with a null payload when the preset clears", async () => {
    const webview = makeWebview();
    const { rerender } = renderHook((props) => useDevPreviewViewport(props), {
      initialProps: baseParams({
        viewportPreset: "iphone",
        isWebviewReady: true,
        webviewElement: webview,
      }),
    });
    await settleEmulation();

    rerender(
      baseParams({ viewportPreset: undefined, isWebviewReady: true, webviewElement: webview })
    );
    await settleEmulation();

    const calls = emulationCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.emulation).toBeNull();
  });

  it("does not clear emulation that was never applied", async () => {
    renderHook(() =>
      useDevPreviewViewport(
        baseParams({
          viewportPreset: undefined,
          isWebviewReady: true,
          webviewElement: makeWebview(),
        })
      )
    );

    await settleEmulation();

    expect(setDeviceEmulation).not.toHaveBeenCalled();
  });

  it("does not re-apply emulation when the preset/rotation/dpr key is unchanged", async () => {
    const webview = makeWebview();
    const { rerender } = renderHook((props) => useDevPreviewViewport(props), {
      initialProps: baseParams({
        viewportPreset: "iphone",
        isWebviewReady: true,
        webviewElement: webview,
      }),
    });
    await settleEmulation();
    expect(setDeviceEmulation).toHaveBeenCalledTimes(1);

    rerender(
      baseParams({ viewportPreset: "iphone", isWebviewReady: true, webviewElement: webview })
    );
    await settleEmulation();
    expect(setDeviceEmulation).toHaveBeenCalledTimes(1);
  });

  it("records the newest request when two applies resolve out of order", async () => {
    // Applying is an IPC round trip now, so a slow first apply can land after a
    // fast second one. The stale reply must not overwrite what is applied.
    let resolveFirst: (value: { applied: boolean }) => void = () => {};
    setDeviceEmulation.mockImplementationOnce(
      () =>
        new Promise<{ applied: boolean }>((resolve) => {
          resolveFirst = resolve;
        })
    );

    const webview = makeWebview();
    const { rerender } = renderHook((props) => useDevPreviewViewport(props), {
      initialProps: baseParams({
        viewportPreset: "iphone",
        isWebviewReady: true,
        webviewElement: webview,
      }),
    });

    rerender(
      baseParams({ viewportPreset: "galaxy", isWebviewReady: true, webviewElement: webview })
    );
    await settleEmulation();
    // Now the superseded iPhone request finally answers.
    resolveFirst({ applied: true });
    await settleEmulation();
    expect(setDeviceEmulation).toHaveBeenCalledTimes(2);

    // Galaxy is what actually landed. Switching back to iPhone must re-apply —
    // if the stale reply had been allowed to record iPhone, this would dedupe
    // and never reach main.
    rerender(
      baseParams({ viewportPreset: "iphone", isWebviewReady: true, webviewElement: webview })
    );
    await settleEmulation();
    expect(setDeviceEmulation).toHaveBeenCalledTimes(3);
  });

  it("clears emulation requested while the first apply is still in flight", async () => {
    // Selecting a preset and going straight back to desktop must still reach
    // main: skipping the clear because nothing had been *confirmed* applied
    // would leave the guest emulated while the toolbar reads desktop.
    let resolveFirst: (value: { applied: boolean }) => void = () => {};
    setDeviceEmulation.mockImplementationOnce(
      () =>
        new Promise<{ applied: boolean }>((resolve) => {
          resolveFirst = resolve;
        })
    );

    const webview = makeWebview();
    const { rerender } = renderHook((props) => useDevPreviewViewport(props), {
      initialProps: baseParams({
        viewportPreset: "iphone",
        isWebviewReady: true,
        webviewElement: webview,
      }),
    });
    await settleEmulation();

    rerender(
      baseParams({ viewportPreset: undefined, isWebviewReady: true, webviewElement: webview })
    );
    resolveFirst({ applied: true });
    await settleEmulation();

    const calls = emulationCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.emulation).toBeNull();
  });

  it("re-issues the last confirmed state when a newer request is still pending", async () => {
    // Desktop is confirmed, a preset is requested, then desktop again before
    // that preset lands. Deduplicating against the confirmed desktop key would
    // skip the clear and leave the guest emulated once the preset arrives.
    let resolvePreset: (value: { applied: boolean }) => void = () => {};
    const webview = makeWebview();
    const { rerender } = renderHook((props) => useDevPreviewViewport(props), {
      initialProps: baseParams({
        viewportPreset: undefined,
        isWebviewReady: true,
        webviewElement: webview,
      }),
    });
    await settleEmulation();
    expect(setDeviceEmulation).not.toHaveBeenCalled();

    setDeviceEmulation.mockImplementationOnce(
      () =>
        new Promise<{ applied: boolean }>((resolve) => {
          resolvePreset = resolve;
        })
    );
    rerender(
      baseParams({ viewportPreset: "iphone", isWebviewReady: true, webviewElement: webview })
    );
    await settleEmulation();

    rerender(
      baseParams({ viewportPreset: undefined, isWebviewReady: true, webviewElement: webview })
    );
    await settleEmulation();
    resolvePreset({ applied: true });
    await settleEmulation();

    const calls = emulationCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.emulation).toBeNull();
  });

  it("does not record a preset main reported it did not apply", async () => {
    setDeviceEmulation.mockResolvedValueOnce({ applied: false });
    const webview = makeWebview();
    const { rerender } = renderHook((props) => useDevPreviewViewport(props), {
      initialProps: baseParams({
        viewportPreset: "iphone",
        isWebviewReady: false,
        webviewElement: webview,
      }),
    });
    rerender(
      baseParams({ viewportPreset: "iphone", isWebviewReady: true, webviewElement: webview })
    );
    await settleEmulation();
    expect(setDeviceEmulation).toHaveBeenCalledTimes(1);

    // A guest that was not yet registered gets another go on the next
    // transition rather than being cached as emulated.
    rerender(
      baseParams({ viewportPreset: "galaxy", isWebviewReady: true, webviewElement: webview })
    );
    await settleEmulation();
    rerender(
      baseParams({ viewportPreset: "iphone", isWebviewReady: true, webviewElement: webview })
    );
    await settleEmulation();
    expect(setDeviceEmulation).toHaveBeenCalledTimes(3);
  });

  it("registers the panel before applying so main can resolve ownership", async () => {
    renderHook(() =>
      useDevPreviewViewport(
        baseParams({
          viewportPreset: "iphone",
          isWebviewReady: true,
          webviewElement: makeWebview(7),
        })
      )
    );
    await settleEmulation();

    expect(registerPanel).toHaveBeenCalledWith(7, PANE_ID);
    expect(registerPanel.mock.invocationCallOrder[0]!).toBeLessThan(
      setDeviceEmulation.mock.invocationCallOrder[0]!
    );
  });

  it("reports a rejected apply instead of throwing", async () => {
    setDeviceEmulation.mockRejectedValueOnce(new Error("guest went away"));

    expect(() =>
      renderHook(() =>
        useDevPreviewViewport(
          baseParams({
            viewportPreset: "iphone",
            isWebviewReady: true,
            webviewElement: makeWebview(),
          })
        )
      )
    ).not.toThrow();

    await settleEmulation();
    expect(setDeviceEmulation).toHaveBeenCalledTimes(1);
  });

  it("survives a webview detached before its guest id can be read", async () => {
    expect(() =>
      renderHook(() =>
        useDevPreviewViewport(
          baseParams({
            viewportPreset: "iphone",
            isWebviewReady: true,
            webviewElement: makeDetachedWebview(),
          })
        )
      )
    ).not.toThrow();
    expect(setDeviceEmulation).not.toHaveBeenCalled();
  });
});
