/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDevPreviewViewport } from "../useDevPreviewViewport";

const PANE_ID = "pane-1";

function makeWebContents(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    getUserAgent: vi.fn(() => "original-ua"),
    setUserAgent: vi.fn(),
    enableDeviceEmulation: vi.fn(),
    disableDeviceEmulation: vi.fn(),
    ...overrides,
  };
}

function makeWebview(webContents: ReturnType<typeof makeWebContents>): Electron.WebviewTag {
  return {
    getWebContents: vi.fn(() => webContents),
  } as unknown as Electron.WebviewTag;
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
    originalUaRef: { current: null },
    setViewportPreset: vi.fn(),
    setViewportRotated: vi.fn(),
    setViewportDpr: vi.fn(),
    setViewportFit: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
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
    const webContents = makeWebContents();
    const webview = makeWebview(webContents);
    renderHook(() =>
      useDevPreviewViewport(
        baseParams({ viewportPreset: "iphone", isWebviewReady: false, webviewElement: webview })
      )
    );
    expect(webContents.enableDeviceEmulation).not.toHaveBeenCalled();
  });

  it("enables emulation and seeds originalUaRef once, when ready with a preset", () => {
    const webContents = makeWebContents();
    const webview = makeWebview(webContents);
    const originalUaRef = { current: null as string | null };
    renderHook(() =>
      useDevPreviewViewport(
        baseParams({
          viewportPreset: "iphone",
          isWebviewReady: true,
          webviewElement: webview,
          originalUaRef,
        })
      )
    );

    expect(webContents.setUserAgent).toHaveBeenCalledWith(expect.stringContaining("iPhone"));
    expect(webContents.enableDeviceEmulation).toHaveBeenCalledTimes(1);
    expect(originalUaRef.current).toBe("original-ua");
  });

  it("does not re-seed originalUaRef if it was already captured", () => {
    const webContents = makeWebContents();
    const webview = makeWebview(webContents);
    const originalUaRef = { current: "already-seeded" };
    renderHook(() =>
      useDevPreviewViewport(
        baseParams({
          viewportPreset: "iphone",
          isWebviewReady: true,
          webviewElement: webview,
          originalUaRef,
        })
      )
    );
    expect(originalUaRef.current).toBe("already-seeded");
  });

  it("disables emulation and restores the original UA when the preset clears", () => {
    const webContents = makeWebContents();
    const webview = makeWebview(webContents);
    const originalUaRef = { current: null as string | null };
    const { rerender } = renderHook((props) => useDevPreviewViewport(props), {
      initialProps: baseParams({
        viewportPreset: "iphone",
        isWebviewReady: true,
        webviewElement: webview,
        originalUaRef,
      }),
    });
    expect(webContents.enableDeviceEmulation).toHaveBeenCalledTimes(1);

    rerender(
      baseParams({
        viewportPreset: undefined,
        isWebviewReady: true,
        webviewElement: webview,
        originalUaRef,
      })
    );

    expect(webContents.disableDeviceEmulation).toHaveBeenCalledTimes(1);
    expect(webContents.setUserAgent).toHaveBeenLastCalledWith("original-ua");
  });

  it("does not re-apply emulation when the preset/rotation/dpr key is unchanged", () => {
    const webContents = makeWebContents();
    const webview = makeWebview(webContents);
    const { rerender } = renderHook((props) => useDevPreviewViewport(props), {
      initialProps: baseParams({
        viewportPreset: "iphone",
        isWebviewReady: true,
        webviewElement: webview,
      }),
    });
    expect(webContents.enableDeviceEmulation).toHaveBeenCalledTimes(1);

    rerender(
      baseParams({ viewportPreset: "iphone", isWebviewReady: true, webviewElement: webview })
    );
    expect(webContents.enableDeviceEmulation).toHaveBeenCalledTimes(1);
  });
});
