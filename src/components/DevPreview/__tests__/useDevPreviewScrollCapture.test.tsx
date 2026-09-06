/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDevPreviewScrollCapture } from "../useDevPreviewScrollCapture";
import type { DevPreviewStatus } from "@/hooks/useDevServer";

interface RenderProps {
  status: DevPreviewStatus;
  webviewElement: Electron.WebviewTag | null;
}

const PANE_ID = "pane-1";
const WC_ID = 42;
const getScrollPositionMock = vi.fn();

function makeWebview(overrides: Partial<Electron.WebviewTag> = {}): Electron.WebviewTag {
  return {
    getURL: vi.fn(() => "http://localhost:3000/page"),
    getWebContentsId: vi.fn(() => WC_ID),
    executeJavaScript: vi.fn(() => Promise.resolve(0)),
    ...overrides,
  } as unknown as Electron.WebviewTag;
}

beforeEach(() => {
  vi.clearAllMocks();
  (window as unknown as { electron: Record<string, unknown> }).electron = {
    webview: { getScrollPosition: getScrollPositionMock },
  };
});

describe("useDevPreviewScrollCapture — status-transition (executeJavaScript) path", () => {
  it("captures via executeJavaScript when status transitions away from running", async () => {
    const webview = makeWebview({ executeJavaScript: vi.fn(() => Promise.resolve(120)) });
    const setDevPreviewScrollPosition = vi.fn();
    const { rerender } = renderHook<ReturnType<typeof useDevPreviewScrollCapture>, RenderProps>(
      ({ status, webviewElement }) =>
        useDevPreviewScrollCapture({
          id: PANE_ID,
          status,
          webviewElement,
          setDevPreviewScrollPosition,
        }),
      { initialProps: { status: "running" as const, webviewElement: webview } }
    );

    await act(async () => {
      rerender({ status: "stopped" as const, webviewElement: webview });
      await Promise.resolve();
    });

    expect(webview.executeJavaScript).toHaveBeenCalledWith("window.scrollY");
    expect(getScrollPositionMock).not.toHaveBeenCalled();
    expect(setDevPreviewScrollPosition).toHaveBeenCalledWith(PANE_ID, {
      url: "http://localhost:3000/page",
      scrollY: 120,
    });
  });

  it("persists a captured scrollY of exactly 0 via executeJavaScript (no >0 guard on this path)", async () => {
    const webview = makeWebview({ executeJavaScript: vi.fn(() => Promise.resolve(0)) });
    const setDevPreviewScrollPosition = vi.fn();
    const { rerender } = renderHook<ReturnType<typeof useDevPreviewScrollCapture>, RenderProps>(
      ({ status, webviewElement }) =>
        useDevPreviewScrollCapture({
          id: PANE_ID,
          status,
          webviewElement,
          setDevPreviewScrollPosition,
        }),
      { initialProps: { status: "running" as const, webviewElement: webview } }
    );

    await act(async () => {
      rerender({ status: "stopped" as const, webviewElement: webview });
      await Promise.resolve();
    });

    expect(setDevPreviewScrollPosition).toHaveBeenCalledWith(PANE_ID, {
      url: "http://localhost:3000/page",
      scrollY: 0,
    });
  });

  it("does not capture when the status was not previously running", async () => {
    const webview = makeWebview();
    const setDevPreviewScrollPosition = vi.fn();
    const { rerender } = renderHook<ReturnType<typeof useDevPreviewScrollCapture>, RenderProps>(
      ({ status, webviewElement }) =>
        useDevPreviewScrollCapture({
          id: PANE_ID,
          status,
          webviewElement,
          setDevPreviewScrollPosition,
        }),
      { initialProps: { status: "starting" as const, webviewElement: webview } }
    );

    await act(async () => {
      rerender({ status: "stopped" as const, webviewElement: webview });
      await Promise.resolve();
    });

    expect(webview.executeJavaScript).not.toHaveBeenCalled();
  });
});

describe("useDevPreviewScrollCapture — captureScrollViaCdp (frozen-safe) path", () => {
  it("captures via CDP getScrollPosition and skips executeJavaScript entirely", async () => {
    getScrollPositionMock.mockResolvedValue(200);
    const webview = makeWebview();
    const setDevPreviewScrollPosition = vi.fn();
    const { result } = renderHook(() =>
      useDevPreviewScrollCapture({
        id: PANE_ID,
        status: "running",
        webviewElement: null,
        setDevPreviewScrollPosition,
      })
    );

    await act(async () => {
      result.current.captureScrollViaCdp(webview);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getScrollPositionMock).toHaveBeenCalledWith(WC_ID);
    expect(webview.executeJavaScript).not.toHaveBeenCalled();
    expect(setDevPreviewScrollPosition).toHaveBeenCalledWith(PANE_ID, {
      url: "http://localhost:3000/page",
      scrollY: 200,
    });
  });

  it("persists a successful 0 so a return to the top overwrites a stale offset", async () => {
    getScrollPositionMock.mockResolvedValue(0);
    const webview = makeWebview();
    const setDevPreviewScrollPosition = vi.fn();
    const { result } = renderHook(() =>
      useDevPreviewScrollCapture({
        id: PANE_ID,
        status: "running",
        webviewElement: null,
        setDevPreviewScrollPosition,
      })
    );

    await act(async () => {
      result.current.captureScrollViaCdp(webview);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(setDevPreviewScrollPosition).toHaveBeenCalledWith(PANE_ID, {
      url: "http://localhost:3000/page",
      scrollY: 0,
    });
  });

  it("leaves any stored position untouched when the read fails (null sentinel)", async () => {
    getScrollPositionMock.mockResolvedValue(null);
    const webview = makeWebview();
    const setDevPreviewScrollPosition = vi.fn();
    const { result } = renderHook(() =>
      useDevPreviewScrollCapture({
        id: PANE_ID,
        status: "running",
        webviewElement: null,
        setDevPreviewScrollPosition,
      })
    );

    await act(async () => {
      result.current.captureScrollViaCdp(webview);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(setDevPreviewScrollPosition).not.toHaveBeenCalled();
  });

  it("discards a reading whose document changed while the request was in flight", async () => {
    // The eviction path blanks the guest right after asking for the offset.
    // Now that a zero is persisted, an answer arriving after that would file
    // the blank page's 0 against the previous URL.
    let urlNow = "http://localhost:3000/page";
    const webview = makeWebview({ getURL: vi.fn(() => urlNow) });
    getScrollPositionMock.mockImplementation(() => {
      urlNow = "about:blank";
      return Promise.resolve(0);
    });
    const setDevPreviewScrollPosition = vi.fn();
    const { result } = renderHook(() =>
      useDevPreviewScrollCapture({
        id: PANE_ID,
        status: "running",
        webviewElement: null,
        setDevPreviewScrollPosition,
      })
    );

    await act(async () => {
      result.current.captureScrollViaCdp(webview);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(setDevPreviewScrollPosition).not.toHaveBeenCalled();
  });

  it("skips capture entirely when the webview URL is about:blank", async () => {
    const webview = makeWebview({ getURL: vi.fn(() => "about:blank") });
    const setDevPreviewScrollPosition = vi.fn();
    const { result } = renderHook(() =>
      useDevPreviewScrollCapture({
        id: PANE_ID,
        status: "running",
        webviewElement: null,
        setDevPreviewScrollPosition,
      })
    );

    result.current.captureScrollViaCdp(webview);
    expect(getScrollPositionMock).not.toHaveBeenCalled();
  });

  it("shares one generation counter across both capture strategies: invalidating rejects a stale CDP resolution", async () => {
    let resolveScroll: (value: number) => void = () => {};
    getScrollPositionMock.mockReturnValue(
      new Promise<number>((resolve) => {
        resolveScroll = resolve;
      })
    );
    const webview = makeWebview();
    const setDevPreviewScrollPosition = vi.fn();
    const { result } = renderHook(() =>
      useDevPreviewScrollCapture({
        id: PANE_ID,
        status: "running",
        webviewElement: null,
        setDevPreviewScrollPosition,
      })
    );

    result.current.captureScrollViaCdp(webview);
    act(() => {
      result.current.invalidateScrollCaptures();
    });

    await act(async () => {
      resolveScroll(300);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(setDevPreviewScrollPosition).not.toHaveBeenCalled();
  });

  it("shares one generation counter across both capture strategies: invalidating rejects a stale executeJavaScript resolution", async () => {
    let resolveScroll: (value: number) => void = () => {};
    const webview = makeWebview({
      executeJavaScript: vi.fn(
        () =>
          new Promise<number>((resolve) => {
            resolveScroll = resolve;
          })
      ),
    });
    const setDevPreviewScrollPosition = vi.fn();
    const { result, rerender } = renderHook<
      ReturnType<typeof useDevPreviewScrollCapture>,
      RenderProps
    >(
      ({ status, webviewElement }) =>
        useDevPreviewScrollCapture({
          id: PANE_ID,
          status,
          webviewElement,
          setDevPreviewScrollPosition,
        }),
      { initialProps: { status: "running" as const, webviewElement: webview } }
    );

    rerender({ status: "stopped" as const, webviewElement: webview });
    act(() => {
      result.current.invalidateScrollCaptures();
    });

    await act(async () => {
      resolveScroll(150);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(setDevPreviewScrollPosition).not.toHaveBeenCalled();
  });
});
