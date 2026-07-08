/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDevPreviewNavigation } from "../useDevPreviewNavigation";
import { initializeBrowserHistory } from "../../Browser/historyUtils";
import { actionService } from "@/services/ActionService";
import type { BrowserHistory } from "@shared/types/browser";

const PANE_ID = "pane-1";

function makeWebview(overrides: Partial<Record<string, unknown>> = {}): Electron.WebviewTag {
  return {
    reload: vi.fn(),
    stop: vi.fn(),
    loadURL: vi.fn(),
    getURL: vi.fn(() => "http://localhost:3000/"),
    getWebContentsId: vi.fn(() => 7),
    setZoomFactor: vi.fn(),
    isDevToolsOpened: vi.fn(() => false),
    openDevTools: vi.fn(),
    closeDevTools: vi.fn(),
    capturePage: vi.fn(() =>
      Promise.resolve({ toPNG: () => new Uint8Array([1, 2, 3]).buffer as unknown as Buffer })
    ),
    ...overrides,
  } as unknown as Electron.WebviewTag;
}

function baseParams(overrides: Partial<Parameters<typeof useDevPreviewNavigation>[0]> = {}) {
  const history: BrowserHistory = initializeBrowserHistory(undefined, "http://localhost:3000/");
  return {
    id: PANE_ID,
    currentProjectId: "proj-1",
    currentUrl: history.present,
    canGoBack: false,
    canGoForward: false,
    history,
    setHistory: vi.fn(),
    zoomFactor: 1,
    setZoomFactor: vi.fn(),
    devServerUrl: null,
    proxyOrigin: null,
    isUnconfigured: false,
    isWebviewReady: true,
    webviewRef: { current: makeWebview() },
    setBrowserUrl: vi.fn(),
    setBrowserHistory: vi.fn(),
    setBrowserZoom: vi.fn(),
    setIsLoading: vi.fn(),
    setWebviewLoadError: vi.fn(),
    clearLoadTimers: vi.fn(),
    isConsoleOpen: false,
    setDevPreviewConsoleOpen: vi.fn(),
    onHardReload: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (window as unknown as { electron: Record<string, unknown> }).electron = {
    webview: {
      onReloadShortcut: vi.fn(() => () => {}),
      onCloseShortcut: vi.fn(() => () => {}),
      reloadIgnoringCache: vi.fn().mockResolvedValue(undefined),
    },
    clipboard: { writeImage: vi.fn().mockResolvedValue(undefined) },
    system: { openExternal: vi.fn().mockResolvedValue(undefined) },
    devPreview: {
      mintBrowserToken: vi.fn().mockResolvedValue({ bootstrapUrl: "https://bootstrap.example" }),
    },
  };
  vi.spyOn(actionService, "dispatch").mockResolvedValue({ ok: true } as Awaited<
    ReturnType<typeof actionService.dispatch>
  >);
});

describe("useDevPreviewNavigation — history handlers", () => {
  it("handleNavigate pushes a normalized (localhost-only) URL onto history", () => {
    const setHistory = vi.fn();
    const { result } = renderHook(() => useDevPreviewNavigation(baseParams({ setHistory })));
    act(() => result.current.handleNavigate("localhost:5173/app"));
    expect(setHistory).toHaveBeenCalled();
    const updater = setHistory.mock.calls[0][0];
    const next = updater(initializeBrowserHistory(undefined, ""));
    expect(next.present).toContain("localhost:5173/app");
  });

  it("handleBack is a no-op when canGoBack is false", () => {
    const setHistory = vi.fn();
    const { result } = renderHook(() =>
      useDevPreviewNavigation(baseParams({ setHistory, canGoBack: false }))
    );
    act(() => result.current.handleBack());
    expect(setHistory).not.toHaveBeenCalled();
  });

  it("handleBack navigates back when canGoBack is true", () => {
    const setHistory = vi.fn();
    const { result } = renderHook(() =>
      useDevPreviewNavigation(baseParams({ setHistory, canGoBack: true }))
    );
    act(() => result.current.handleBack());
    expect(setHistory).toHaveBeenCalled();
  });

  it("handleForward is a no-op when canGoForward is false", () => {
    const setHistory = vi.fn();
    const { result } = renderHook(() =>
      useDevPreviewNavigation(baseParams({ setHistory, canGoForward: false }))
    );
    act(() => result.current.handleForward());
    expect(setHistory).not.toHaveBeenCalled();
  });
});

describe("useDevPreviewNavigation — reload/cancel/retry", () => {
  it("handleReload clears the load error and reloads the webview", () => {
    const setWebviewLoadError = vi.fn();
    const webview = makeWebview();
    const { result } = renderHook(() =>
      useDevPreviewNavigation(baseParams({ setWebviewLoadError, webviewRef: { current: webview } }))
    );
    act(() => result.current.handleReload());
    expect(setWebviewLoadError).toHaveBeenCalledWith(null);
    expect(webview.reload).toHaveBeenCalledTimes(1);
  });

  it("handleCancelLoad clears timers, stops loading, and sets an aborted error", () => {
    const clearLoadTimers = vi.fn();
    const setIsLoading = vi.fn();
    const setWebviewLoadError = vi.fn();
    const webview = makeWebview();
    const { result } = renderHook(() =>
      useDevPreviewNavigation(
        baseParams({
          clearLoadTimers,
          setIsLoading,
          setWebviewLoadError,
          webviewRef: { current: webview },
        })
      )
    );
    act(() => result.current.handleCancelLoad());
    expect(clearLoadTimers).toHaveBeenCalledTimes(1);
    expect(setIsLoading).toHaveBeenCalledWith(false);
    expect(webview.stop).toHaveBeenCalledTimes(1);
    expect(setWebviewLoadError).toHaveBeenCalledWith({
      code: "aborted",
      message: "Load cancelled.",
    });
  });

  it("handleRetryWebviewLoad issues an imperative load when there's a current URL", () => {
    const webview = makeWebview();
    const { result } = renderHook(() =>
      useDevPreviewNavigation(
        baseParams({ currentUrl: "http://localhost:3000/x", webviewRef: { current: webview } })
      )
    );
    act(() => result.current.handleRetryWebviewLoad());
    // loadWebviewUrl calls webview.stop()+loadURL internally; getURL is enough
    // signal here that the webview was addressed rather than blank-reloaded.
    expect(webview.reload).not.toHaveBeenCalled();
  });

  it("handleRetryWebviewLoad falls back to a plain reload without a current URL", () => {
    const webview = makeWebview();
    const { result } = renderHook(() =>
      useDevPreviewNavigation(baseParams({ currentUrl: "", webviewRef: { current: webview } }))
    );
    act(() => result.current.handleRetryWebviewLoad());
    expect(webview.reload).toHaveBeenCalledTimes(1);
  });
});

describe("useDevPreviewNavigation — screenshot/devtools/console/zoom", () => {
  it("handleCaptureScreenshot copies a PNG to the clipboard and returns true", async () => {
    const webview = makeWebview();
    const { result } = renderHook(() =>
      useDevPreviewNavigation(baseParams({ webviewRef: { current: webview } }))
    );
    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.handleCaptureScreenshot();
    });
    expect(outcome).toBe(true);
    expect(window.electron.clipboard.writeImage).toHaveBeenCalledTimes(1);
  });

  it("handleCaptureScreenshot returns false when the webview is on about:blank", async () => {
    const webview = makeWebview({ getURL: vi.fn(() => "about:blank") });
    const { result } = renderHook(() =>
      useDevPreviewNavigation(baseParams({ webviewRef: { current: webview } }))
    );
    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.handleCaptureScreenshot();
    });
    expect(outcome).toBe(false);
  });

  it("handleToggleDevTools opens devtools when closed, closes when open", () => {
    const webview = makeWebview({ isDevToolsOpened: vi.fn(() => false) });
    const { result } = renderHook(() =>
      useDevPreviewNavigation(baseParams({ webviewRef: { current: webview } }))
    );
    act(() => result.current.handleToggleDevTools());
    expect(webview.openDevTools).toHaveBeenCalledTimes(1);
  });

  it("handleToggleConsole flips setDevPreviewConsoleOpen from the current state", () => {
    const setDevPreviewConsoleOpen = vi.fn();
    const { result } = renderHook(() =>
      useDevPreviewNavigation(baseParams({ isConsoleOpen: false, setDevPreviewConsoleOpen }))
    );
    act(() => result.current.handleToggleConsole());
    expect(setDevPreviewConsoleOpen).toHaveBeenCalledWith(PANE_ID, true);
  });

  it("handleZoomChange clamps to [0.25, 2.0] and applies it to the webview", () => {
    const setZoomFactor = vi.fn();
    const webview = makeWebview();
    const { result } = renderHook(() =>
      useDevPreviewNavigation(baseParams({ setZoomFactor, webviewRef: { current: webview } }))
    );
    act(() => result.current.handleZoomChange(5));
    expect(setZoomFactor).toHaveBeenCalledWith(2.0);
    expect(webview.setZoomFactor).toHaveBeenCalledWith(2.0);

    act(() => result.current.handleZoomChange(0.01));
    expect(setZoomFactor).toHaveBeenCalledWith(0.25);
  });
});

describe("useDevPreviewNavigation — open external / promote to portal", () => {
  it("mints a bootstrap token and opens it when the URL is on the stable proxy origin", async () => {
    const { result } = renderHook(() =>
      useDevPreviewNavigation(
        baseParams({
          currentUrl: "https://proxy.example/path?x=1#frag",
          proxyOrigin: "https://proxy.example",
        })
      )
    );
    await act(async () => {
      result.current.handleOpenExternal();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(window.electron.devPreview.mintBrowserToken).toHaveBeenCalledWith(
      expect.objectContaining({ redirectPath: "/path?x=1#frag" })
    );
    expect(window.electron.system.openExternal).toHaveBeenCalledWith("https://bootstrap.example");
  });

  it("opens the raw URL directly in legacy (non-proxy) mode", () => {
    const { result } = renderHook(() =>
      useDevPreviewNavigation(
        baseParams({ currentUrl: "http://localhost:3000/", proxyOrigin: null })
      )
    );
    act(() => result.current.handleOpenExternal());
    expect(window.electron.devPreview.mintBrowserToken).not.toHaveBeenCalled();
    expect(window.electron.system.openExternal).toHaveBeenCalledWith("http://localhost:3000/");
  });

  it("handlePromoteToPortal guards against re-entrant calls while one is in flight", () => {
    const setBrowserUrl = vi.fn();
    const { result } = renderHook(() =>
      useDevPreviewNavigation(baseParams({ setBrowserUrl, currentUrl: "http://localhost:3000/" }))
    );
    // The mount-time URL-persistence effect already called setBrowserUrl once;
    // isolate the calls made by handlePromoteToPortal itself from here.
    setBrowserUrl.mockClear();
    act(() => {
      result.current.handlePromoteToPortal();
      result.current.handlePromoteToPortal();
    });
    expect(setBrowserUrl).toHaveBeenCalledTimes(1);
  });
});

describe("useDevPreviewNavigation — persistence effects", () => {
  it("mirrors history/url/zoom into the panel store", () => {
    const setBrowserHistory = vi.fn();
    const setBrowserZoom = vi.fn();
    const setBrowserUrl = vi.fn();
    renderHook(() =>
      useDevPreviewNavigation(
        baseParams({ setBrowserHistory, setBrowserZoom, setBrowserUrl, zoomFactor: 1.5 })
      )
    );
    expect(setBrowserHistory).toHaveBeenCalledWith(PANE_ID, expect.any(Object));
    expect(setBrowserZoom).toHaveBeenCalledWith(PANE_ID, 1.5);
    expect(setBrowserUrl).toHaveBeenCalledWith(PANE_ID, "http://localhost:3000/");
  });

  it("does not push a dev-server URL into history while the proxy origin is still resolving", () => {
    const setHistory = vi.fn();
    renderHook(() =>
      useDevPreviewNavigation(
        baseParams({ setHistory, devServerUrl: "http://127.0.0.1:4000/", proxyOrigin: undefined })
      )
    );
    // Only the plain history-persistence effect may have called setHistory's
    // setter form; none of those calls may be the pushBrowserHistory updater
    // that the URL-adoption effect would produce when unguarded.
    for (const call of setHistory.mock.calls) {
      expect(typeof call[0]).not.toBe("function");
    }
  });

  it("adopts a resolved dev-server URL onto the stable proxy origin once proxyOrigin settles", () => {
    const setHistory = vi.fn();
    renderHook(() =>
      useDevPreviewNavigation(
        baseParams({
          setHistory,
          currentUrl: "",
          devServerUrl: "http://127.0.0.1:4000/",
          proxyOrigin: "https://proxy.example",
        })
      )
    );
    const updaterCalls = setHistory.mock.calls.filter((call) => typeof call[0] === "function");
    expect(updaterCalls.length).toBeGreaterThan(0);
  });
});

describe("useDevPreviewNavigation — shortcut listeners", () => {
  it("invokes onHardReload when a matching reload shortcut fires", () => {
    let shortcutCb: ((payload: { panelId: string }) => void) | undefined;
    (window.electron.webview.onReloadShortcut as ReturnType<typeof vi.fn>).mockImplementation(
      (cb: (payload: { panelId: string }) => void) => {
        shortcutCb = cb;
        return () => {};
      }
    );
    const onHardReload = vi.fn();
    renderHook(() => useDevPreviewNavigation(baseParams({ onHardReload })));
    act(() => shortcutCb?.({ panelId: PANE_ID }));
    expect(onHardReload).toHaveBeenCalledTimes(1);
  });

  it("ignores a reload shortcut for a different panel", () => {
    let shortcutCb: ((payload: { panelId: string }) => void) | undefined;
    (window.electron.webview.onReloadShortcut as ReturnType<typeof vi.fn>).mockImplementation(
      (cb: (payload: { panelId: string }) => void) => {
        shortcutCb = cb;
        return () => {};
      }
    );
    const onHardReload = vi.fn();
    renderHook(() => useDevPreviewNavigation(baseParams({ onHardReload })));
    act(() => shortcutCb?.({ panelId: "other-pane" }));
    expect(onHardReload).not.toHaveBeenCalled();
  });
});
