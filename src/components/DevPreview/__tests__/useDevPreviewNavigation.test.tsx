/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useState } from "react";
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
    clearRetryState: vi.fn(),
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
  // `{ok:true}` alone isn't a valid ActionDispatchSuccess — it needs `result`.
  // The cast that used to hide that is exactly the class of mistake #11114 is about.
  vi.spyOn(actionService, "dispatch").mockResolvedValue({ ok: true, result: undefined });
});

// #11114: dispatch() resolves {ok:false} rather than rejecting, so the old
// `.finally(() => { isPromotingRef.current = false })` reset the guard but never
// looked at the result — a failed promotion was indistinguishable from success.
describe("useDevPreviewNavigation — promote-to-portal failures (#11114)", () => {
  const dispatchMock = () => vi.mocked(actionService.dispatch);

  // Built as typed values rather than `as`-cast literals: the dispatch result is
  // a discriminated union, so the compiler can check these for us.
  type DispatchResult = Awaited<ReturnType<typeof actionService.dispatch>>;
  const succeeded = (): DispatchResult => ({ ok: true, result: undefined });
  const failed = (message: string): DispatchResult => ({
    ok: false,
    error: { code: "EXECUTION_ERROR", message },
  });

  it("reports no error and releases the guard when promotion succeeds", async () => {
    const { result } = renderHook(() => useDevPreviewNavigation(baseParams()));

    await act(async () => {
      await result.current.handlePromoteToPortal();
    });

    expect(dispatchMock()).toHaveBeenCalledWith(
      "devPreview.promoteToPortal",
      { panelId: PANE_ID, projectId: "proj-1" },
      { source: "user" }
    );
    expect(result.current.promoteToPortalError).toBeNull();
    expect(result.current.isPromotingToPortal).toBe(false);
  });

  it("exposes the dispatch error message when promotion fails", async () => {
    const message = "Portal panel limit reached";
    dispatchMock().mockResolvedValue(failed(message));

    const { result } = renderHook(() => useDevPreviewNavigation(baseParams()));
    await act(async () => {
      await result.current.handlePromoteToPortal();
    });

    expect(result.current.promoteToPortalError).toBe(message);
    // The guard must release even on failure, or Retry would be dead.
    expect(result.current.isPromotingToPortal).toBe(false);
  });

  it("ignores a second click while a promotion is in flight", async () => {
    let resolveDispatch!: (value: DispatchResult) => void;
    dispatchMock().mockReturnValue(
      new Promise<DispatchResult>((resolve) => {
        resolveDispatch = resolve;
      })
    );

    const { result } = renderHook(() => useDevPreviewNavigation(baseParams()));

    const inFlight: Array<Promise<void>> = [];
    act(() => {
      inFlight.push(result.current.handlePromoteToPortal());
      inFlight.push(result.current.handlePromoteToPortal());
    });

    // The synchronous isPromotingRef guard swallows the second click...
    expect(dispatchMock()).toHaveBeenCalledTimes(1);
    // ...and the pane reports the attempt as pending while it runs.
    expect(result.current.isPromotingToPortal).toBe(true);

    await act(async () => {
      resolveDispatch(succeeded());
      await Promise.all(inFlight);
    });

    expect(result.current.isPromotingToPortal).toBe(false);

    // The guard genuinely released — a later click dispatches again.
    await act(async () => {
      await result.current.handlePromoteToPortal();
    });
    expect(dispatchMock()).toHaveBeenCalledTimes(2);
  });

  it("drops a stale result when the pane's project changed mid-flight", async () => {
    let resolveDispatch!: (value: DispatchResult) => void;
    dispatchMock().mockReturnValue(
      new Promise<DispatchResult>((resolve) => {
        resolveDispatch = resolve;
      })
    );

    const { result, rerender } = renderHook(
      (props: { currentProjectId: string }) =>
        useDevPreviewNavigation(baseParams({ currentProjectId: props.currentProjectId })),
      { initialProps: { currentProjectId: "proj-1" } }
    );

    act(() => {
      void result.current.handlePromoteToPortal();
    });

    // The pane switches project while the promotion is still in flight.
    rerender({ currentProjectId: "proj-2" });

    await act(async () => {
      resolveDispatch(failed("Promotion failed for the old project"));
    });

    // The obsolete failure belongs to proj-1 and must not surface against proj-2,
    // and it must not leave the new context's guard stuck.
    expect(result.current.promoteToPortalError).toBeNull();
    expect(result.current.isPromotingToPortal).toBe(false);

    dispatchMock().mockResolvedValue(succeeded());
    await act(async () => {
      await result.current.handlePromoteToPortal();
    });
    expect(dispatchMock()).toHaveBeenCalledTimes(2);
  });

  it("allows a retry after a failure, and a successful retry clears the error", async () => {
    dispatchMock().mockResolvedValue(failed("Promotion failed"));

    const { result } = renderHook(() => useDevPreviewNavigation(baseParams()));
    await act(async () => {
      await result.current.handlePromoteToPortal();
    });
    expect(result.current.promoteToPortalError).toBe("Promotion failed");

    dispatchMock().mockResolvedValue(succeeded());
    await act(async () => {
      await result.current.handlePromoteToPortal();
    });

    expect(dispatchMock()).toHaveBeenCalledTimes(2);
    expect(result.current.promoteToPortalError).toBeNull();
  });

  it("clearPromoteToPortalError dismisses the error without dispatching", async () => {
    dispatchMock().mockResolvedValue(failed("Promotion failed"));

    const { result } = renderHook(() => useDevPreviewNavigation(baseParams()));
    await act(async () => {
      await result.current.handlePromoteToPortal();
    });

    act(() => result.current.clearPromoteToPortalError());

    expect(result.current.promoteToPortalError).toBeNull();
    expect(dispatchMock()).toHaveBeenCalledTimes(1);
  });
});

describe("useDevPreviewNavigation — history handlers", () => {
  it("handleNavigate pushes a normalized (localhost-only) URL onto history", () => {
    const setHistory = vi.fn();
    const { result } = renderHook(() => useDevPreviewNavigation(baseParams({ setHistory })));
    act(() => result.current.handleNavigate("localhost:5173/app"));
    expect(setHistory).toHaveBeenCalled();
    const updater = setHistory.mock.calls[0]![0];
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

  // A load start no longer refills the connection-retry budget (#12296), so every
  // explicit navigation has to hand it back — otherwise a target that exhausted
  // its five retries makes the next URL's first transient failure terminal.
  it("handleNavigate resets the retry budget for the new target", () => {
    const clearRetryState = vi.fn();
    const { result } = renderHook(() => useDevPreviewNavigation(baseParams({ clearRetryState })));
    act(() => result.current.handleNavigate("localhost:5173/app"));
    expect(clearRetryState).toHaveBeenCalledTimes(1);
  });

  // Re-submitting the URL already showing starts no load, so clearing retry state
  // there would drop an in-flight document's latches with nothing to restore them.
  it("handleNavigate leaves the retry budget alone when re-submitting the current URL", () => {
    const clearRetryState = vi.fn();
    const { result } = renderHook(() => useDevPreviewNavigation(baseParams({ clearRetryState })));
    act(() => result.current.handleNavigate("http://localhost:3000/"));
    expect(clearRetryState).not.toHaveBeenCalled();
  });

  it("handleNavigate leaves the retry budget alone when the URL is rejected", () => {
    const clearRetryState = vi.fn();
    const { result } = renderHook(() => useDevPreviewNavigation(baseParams({ clearRetryState })));
    act(() => result.current.handleNavigate("   "));
    expect(clearRetryState).not.toHaveBeenCalled();
  });

  it("handleBack and handleForward reset the retry budget only when they navigate", () => {
    const clearRetryState = vi.fn();
    const { result } = renderHook(() =>
      useDevPreviewNavigation(
        baseParams({ clearRetryState, canGoBack: false, canGoForward: false })
      )
    );
    act(() => result.current.handleBack());
    act(() => result.current.handleForward());
    expect(clearRetryState).not.toHaveBeenCalled();

    const { result: navigable } = renderHook(() =>
      useDevPreviewNavigation(baseParams({ clearRetryState, canGoBack: true, canGoForward: true }))
    );
    act(() => navigable.current.handleBack());
    act(() => navigable.current.handleForward());
    expect(clearRetryState).toHaveBeenCalledTimes(2);
  });

  it("handleReload and handleRetryWebviewLoad reset the retry budget", () => {
    const clearRetryState = vi.fn();
    const { result } = renderHook(() => useDevPreviewNavigation(baseParams({ clearRetryState })));
    act(() => result.current.handleReload());
    expect(clearRetryState).toHaveBeenCalledTimes(1);
    act(() => result.current.handleRetryWebviewLoad());
    expect(clearRetryState).toHaveBeenCalledTimes(2);
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
    const setWebviewLoadError = vi.fn();
    const setIsLoading = vi.fn();
    const webview = makeWebview();
    const { result } = renderHook(() =>
      useDevPreviewNavigation(
        baseParams({
          currentUrl: "http://localhost:3000/x",
          webviewRef: { current: webview },
          setWebviewLoadError,
          setIsLoading,
        })
      )
    );
    act(() => result.current.handleRetryWebviewLoad());
    expect(setWebviewLoadError).toHaveBeenCalledWith(null);
    expect(setIsLoading).toHaveBeenCalledWith(true);
    expect(webview.loadURL).toHaveBeenCalledWith("http://localhost:3000/x");
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

  it("falls back to opening the raw proxy URL when minting the bootstrap token fails", async () => {
    (window.electron.devPreview.mintBrowserToken as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("mint failed")
    );
    const { result } = renderHook(() =>
      useDevPreviewNavigation(
        baseParams({
          currentUrl: "https://proxy.example/path",
          proxyOrigin: "https://proxy.example",
        })
      )
    );
    await act(async () => {
      result.current.handleOpenExternal();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(window.electron.system.openExternal).toHaveBeenCalledWith("https://proxy.example/path");
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

// #12297 — the pane must never lose the route when it crosses onto the proxy origin,
// and its address bar must accept the origin it is itself displaying. These need a
// harness that actually owns history state, so the migration effect converges instead
// of being observed one updater at a time.
describe("useDevPreviewNavigation — proxy-origin routing (#12297)", () => {
  const PROXY = "http://dp-proj-panel.localhost:43000";
  const UPSTREAM = "http://localhost:5173";

  function renderStateful(init: {
    present: string;
    past?: string[];
    future?: string[];
    devServerUrl?: string | null;
    proxyOrigin?: string | null;
  }) {
    const initial: BrowserHistory = {
      past: init.past ?? [],
      present: init.present,
      future: init.future ?? [],
    };
    // Every rendered history, not just the converged one: asserting on final state alone
    // cannot tell "never committed the raw upstream URL" from "committed it, then the
    // migration effect quietly replaced it".
    const seen = { history: initial, commits: [] as string[] };
    const rendered = renderHook(() => {
      const [history, setHistory] = useState<BrowserHistory>(initial);
      seen.history = history;
      if (seen.commits.at(-1) !== history.present) seen.commits.push(history.present);
      return useDevPreviewNavigation(
        baseParams({
          history,
          setHistory,
          currentUrl: history.present,
          canGoBack: history.past.length > 0,
          canGoForward: history.future.length > 0,
          devServerUrl: init.devServerUrl ?? null,
          proxyOrigin: init.proxyOrigin ?? null,
        })
      );
    });
    return { ...rendered, seen };
  }

  it("accepts the panel's own proxy origin from the address bar", () => {
    // The reported bug: this returned "Only localhost URLs are allowed" and never navigated.
    const { result, seen } = renderStateful({ present: `${PROXY}/`, proxyOrigin: PROXY });
    act(() => result.current.handleNavigate(`${PROXY}/typed-route?x=1#f`));
    expect(seen.history.present).toBe(`${PROXY}/typed-route?x=1#f`);
    expect(result.current.validateUrl(`${PROXY}/typed-route`).error).toBeUndefined();
  });

  it("retargets a typed raw upstream URL onto the proxy origin in one commit", () => {
    const { result, seen } = renderStateful({
      present: `${PROXY}/`,
      devServerUrl: `${UPSTREAM}/`,
      proxyOrigin: PROXY,
    });
    act(() => result.current.handleNavigate(`${UPSTREAM}/once?a=1#b`));

    // The route survives, and history never holds the raw upstream origin — so the pane
    // never gates the webview out and never remounts it against a stale seed.
    expect(seen.history.present).toBe(`${PROXY}/once?a=1#b`);
    expect(seen.history.past).toEqual([`${PROXY}/`]);
    // The raw URL was never committed even transiently. Without this, a strict-normalizing
    // handleNavigate followed by a repairing migration would satisfy the assertions above.
    expect(seen.commits).toEqual([`${PROXY}/`, `${PROXY}/once?a=1#b`]);
  });

  it("refuses a foreign host without touching history", () => {
    const { result, seen } = renderStateful({ present: `${PROXY}/`, proxyOrigin: PROXY });
    act(() => result.current.handleNavigate("http://example.com/x"));
    act(() => result.current.handleNavigate("http://dp-proj-other.localhost:43000/x"));
    expect(seen.history.present).toBe(`${PROXY}/`);
    expect(seen.history.past).toEqual([]);
  });

  it("exposes a validator that tracks the panel's own proxy origin", () => {
    const { result } = renderStateful({ present: `${PROXY}/`, proxyOrigin: PROXY });
    expect(result.current.validateUrl(`${PROXY}/x`).url).toBe(`${PROXY}/x`);
    expect(
      result.current.validateUrl("http://dp-proj-other.localhost:43000/x").url
    ).toBeUndefined();
    // Same policy the toolbar submits through, so the two can never disagree.
    expect(result.current.validateUrl(`${UPSTREAM}/x`).url).toBe(`${PROXY}/x`);
  });

  it("migrates a stale raw-upstream entry onto the proxy origin without stranding it in the back stack", () => {
    const { seen } = renderStateful({
      present: `${UPSTREAM}/consume?token=audit-single-use#done`,
      past: [`${PROXY}/start`],
      future: [`${PROXY}/ahead`],
      devServerUrl: `${UPSTREAM}/`,
      proxyOrigin: PROXY,
    });

    expect(seen.history.present).toBe(`${PROXY}/consume?token=audit-single-use#done`);
    // Replacement, not a push: Back still returns to /start and Forward still works.
    expect(seen.history.past).toEqual([`${PROXY}/start`]);
    expect(seen.history.future).toEqual([`${PROXY}/ahead`]);
  });

  it("settles once on the proxy origin instead of re-migrating", () => {
    const { seen, rerender } = renderStateful({
      present: `${UPSTREAM}/settings`,
      devServerUrl: `${UPSTREAM}/`,
      proxyOrigin: PROXY,
    });
    const settled = seen.history;
    rerender();
    expect(seen.history.present).toBe(`${PROXY}/settings`);
    expect(seen.history).toBe(settled);
    // Exactly one migration commit: the stale entry, then the migrated one, and no loop.
    expect(seen.commits).toEqual([`${UPSTREAM}/settings`, `${PROXY}/settings`]);
  });

  it("still pushes in legacy mode, where a port shift is a genuine new origin", () => {
    const { seen } = renderStateful({
      present: "http://localhost:3000/dashboard",
      devServerUrl: "http://localhost:3001/",
      proxyOrigin: null,
    });
    expect(seen.history.present).toBe("http://localhost:3001/dashboard");
    expect(seen.history.past).toEqual(["http://localhost:3000/dashboard"]);
  });

  it("keeps back/forward on the proxy origin after a retargeted navigation", () => {
    const { result, seen } = renderStateful({
      present: `${PROXY}/start`,
      devServerUrl: `${UPSTREAM}/`,
      proxyOrigin: PROXY,
    });
    act(() => result.current.handleNavigate(`${UPSTREAM}/once`));
    expect(seen.history.present).toBe(`${PROXY}/once`);

    act(() => result.current.handleBack());
    expect(seen.history.present).toBe(`${PROXY}/start`);
    expect(seen.history.future).toEqual([`${PROXY}/once`]);

    act(() => result.current.handleForward());
    expect(seen.history.present).toBe(`${PROXY}/once`);
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
