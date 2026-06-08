/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useDevPreviewConsoleCapture } from "../useDevPreviewConsoleCapture";
import { useConsoleCaptureStore } from "@/store/consoleCaptureStore";
import { usePanelStore } from "@/store";
import type { SerializedConsoleRow } from "@shared/types/ipc/webviewConsole";
import type { PtyPanelData } from "@shared/types/panel";

const PANE_ID = "pane-1";
const WC_ID = 42;

let messageCb: ((row: SerializedConsoleRow) => void) | undefined;
let clearedCb: ((p: { paneId: string; navigationGeneration: number }) => void) | undefined;
const offMessage = vi.fn();
const offCleared = vi.fn();

const registerPanel = vi.fn(() => Promise.resolve());
const startConsoleCapture = vi.fn(() => Promise.resolve());
const stopConsoleCapture = vi.fn(() => Promise.resolve());

function makeWebviewElement(getWebContentsId: () => number = () => WC_ID): Electron.WebviewTag {
  return { getWebContentsId } as unknown as Electron.WebviewTag;
}

function row(overrides: Partial<SerializedConsoleRow> = {}): SerializedConsoleRow {
  return {
    id: Math.floor(Math.random() * 1e9),
    paneId: PANE_ID,
    level: "error",
    cdpType: "error",
    args: [],
    summaryText: "boom",
    timestamp: Date.now(),
    navigationGeneration: 1,
    groupDepth: 0,
    ...overrides,
  };
}

beforeEach(() => {
  messageCb = undefined;
  clearedCb = undefined;
  vi.clearAllMocks();
  useConsoleCaptureStore.setState({ messages: new Map(), counters: new Map() });
  // Default: panel is NOT registered (treated as a real teardown).
  usePanelStore.setState({ panelsById: {} });
  (window as unknown as { electron: Record<string, unknown> }).electron = {
    webview: {
      registerPanel,
      startConsoleCapture,
      stopConsoleCapture,
      onConsoleMessage: vi.fn((cb: (r: SerializedConsoleRow) => void) => {
        messageCb = cb;
        return offMessage;
      }),
      onConsoleContextCleared: vi.fn(
        (cb: (p: { paneId: string; navigationGeneration: number }) => void) => {
          clearedCb = cb;
          return offCleared;
        }
      ),
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useDevPreviewConsoleCapture", () => {
  it("registers the panel before starting capture when the webview is mounted and not evicted", async () => {
    const webview = makeWebviewElement();
    renderHook(() => useDevPreviewConsoleCapture(PANE_ID, webview, false, false));
    expect(registerPanel).toHaveBeenCalledWith(WC_ID, PANE_ID);
    await waitFor(() => expect(startConsoleCapture).toHaveBeenCalledWith(WC_ID, PANE_ID));
    const registerCallOrder = registerPanel.mock.invocationCallOrder[0];
    const startCallOrder = startConsoleCapture.mock.invocationCallOrder[0];
    expect(registerCallOrder).toBeDefined();
    expect(startCallOrder).toBeDefined();
    expect(registerCallOrder!).toBeLessThan(startCallOrder!);
  });

  it("does not start capture before the webview is mounted", () => {
    renderHook(() => useDevPreviewConsoleCapture(PANE_ID, null, false, false));
    expect(startConsoleCapture).not.toHaveBeenCalled();
  });

  it("does not start capture while evicted", () => {
    const webview = makeWebviewElement();
    renderHook(() => useDevPreviewConsoleCapture(PANE_ID, webview, true, true));
    expect(startConsoleCapture).not.toHaveBeenCalled();
  });

  it("does not start capture when getWebContentsId throws", () => {
    const webview = makeWebviewElement(() => {
      throw new Error("not attached");
    });
    renderHook(() => useDevPreviewConsoleCapture(PANE_ID, webview, true, false));
    expect(startConsoleCapture).not.toHaveBeenCalled();
  });

  it("retries when the ready signal changes after getWebContentsId initially throws", async () => {
    const getWebContentsId = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("not attached");
      })
      .mockReturnValue(WC_ID);
    const webview = makeWebviewElement(getWebContentsId);
    const { rerender } = renderHook(
      ({ ready }: { ready: boolean }) =>
        useDevPreviewConsoleCapture(PANE_ID, webview, ready, false),
      { initialProps: { ready: false } }
    );

    expect(startConsoleCapture).not.toHaveBeenCalled();

    rerender({ ready: true });
    expect(registerPanel).toHaveBeenCalledWith(WC_ID, PANE_ID);
    await waitFor(() => expect(startConsoleCapture).toHaveBeenCalledWith(WC_ID, PANE_ID));
  });

  it("stops capture and unsubscribes on unmount", async () => {
    const webview = makeWebviewElement();
    const { unmount } = renderHook(() =>
      useDevPreviewConsoleCapture(PANE_ID, webview, true, false)
    );
    unmount();
    expect(offMessage).toHaveBeenCalledTimes(1);
    expect(offCleared).toHaveBeenCalledTimes(1);
    // stop is chained after the start promise settles (microtask).
    await waitFor(() => expect(stopConsoleCapture).toHaveBeenCalledWith(WC_ID, PANE_ID));
  });

  it("stops capture when the panel becomes evicted", async () => {
    const webview = makeWebviewElement();
    const { rerender } = renderHook(
      ({ evicted }: { evicted: boolean }) =>
        useDevPreviewConsoleCapture(PANE_ID, webview, true, evicted),
      { initialProps: { evicted: false } }
    );
    await waitFor(() => expect(startConsoleCapture).toHaveBeenCalledTimes(1));

    rerender({ evicted: true });
    await waitFor(() => expect(stopConsoleCapture).toHaveBeenCalledWith(WC_ID, PANE_ID));
  });

  it("does not let a stale ready-transition cleanup stop the replacement capture", async () => {
    let resolveFirstStart: (() => void) | undefined;
    startConsoleCapture
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirstStart = resolve;
          })
      )
      .mockResolvedValueOnce(undefined);

    const webview = makeWebviewElement();
    const { rerender, unmount } = renderHook(
      ({ ready }: { ready: boolean }) =>
        useDevPreviewConsoleCapture(PANE_ID, webview, ready, false),
      { initialProps: { ready: false } }
    );

    rerender({ ready: true });
    await waitFor(() => expect(startConsoleCapture).toHaveBeenCalledTimes(2));

    resolveFirstStart?.();
    await Promise.resolve();
    expect(stopConsoleCapture).not.toHaveBeenCalled();

    unmount();
    await waitFor(() => expect(stopConsoleCapture).toHaveBeenCalledWith(WC_ID, PANE_ID));
  });

  it("routes only matching-pane console messages into the store", () => {
    const webview = makeWebviewElement();
    renderHook(() => useDevPreviewConsoleCapture(PANE_ID, webview, true, false));

    messageCb?.(row({ paneId: "other-pane" }));
    expect(useConsoleCaptureStore.getState().getMessages(PANE_ID)).toHaveLength(0);

    messageCb?.(row({ paneId: PANE_ID }));
    expect(useConsoleCaptureStore.getState().getMessages(PANE_ID)).toHaveLength(1);
  });

  it("marks rows stale only for the matching pane on context-cleared", () => {
    const webview = makeWebviewElement();
    renderHook(() => useDevPreviewConsoleCapture(PANE_ID, webview, true, false));

    messageCb?.(row({ paneId: PANE_ID, navigationGeneration: 1 }));
    clearedCb?.({ paneId: "other-pane", navigationGeneration: 2 });
    expect(useConsoleCaptureStore.getState().getMessages(PANE_ID)[0]?.isStale).toBe(false);

    clearedCb?.({ paneId: PANE_ID, navigationGeneration: 2 });
    expect(useConsoleCaptureStore.getState().getMessages(PANE_ID)[0]?.isStale).toBe(true);
  });

  it("drops the pane's buffered rows when the panel is deleted (no longer registered)", () => {
    const webview = makeWebviewElement();
    const { unmount } = renderHook(() =>
      useDevPreviewConsoleCapture(PANE_ID, webview, true, false)
    );
    messageCb?.(row({ paneId: PANE_ID }));
    expect(useConsoleCaptureStore.getState().getMessages(PANE_ID)).toHaveLength(1);

    unmount();
    expect(useConsoleCaptureStore.getState().getMessages(PANE_ID)).toHaveLength(0);
  });

  it("keeps buffered rows when the panel only deactivates in a grid tab group", () => {
    // Panel is still registered: unmount is a tab-switch deactivation, not a
    // deletion, so captured rows must survive until the user switches back.
    usePanelStore.setState({
      panelsById: { [PANE_ID]: { id: PANE_ID } as unknown as PtyPanelData },
    });
    const webview = makeWebviewElement();
    const { unmount } = renderHook(() =>
      useDevPreviewConsoleCapture(PANE_ID, webview, true, false)
    );
    messageCb?.(row({ paneId: PANE_ID }));
    expect(useConsoleCaptureStore.getState().getMessages(PANE_ID)).toHaveLength(1);

    unmount();
    expect(useConsoleCaptureStore.getState().getMessages(PANE_ID)).toHaveLength(1);
  });
});

describe("useDevPreviewConsoleCapture — HMR liveness", () => {
  it("starts with hmrDead false", () => {
    const webview = makeWebviewElement();
    const { result } = renderHook(() => useDevPreviewConsoleCapture(PANE_ID, webview, true, false));
    expect(result.current.hmrDead).toBe(false);
  });

  it("flips hmrDead when Vite logs a failed websocket connection", () => {
    const webview = makeWebviewElement();
    const { result } = renderHook(() => useDevPreviewConsoleCapture(PANE_ID, webview, true, false));
    act(() => {
      messageCb?.(row({ summaryText: "[vite] failed to connect to websocket." }));
    });
    expect(result.current.hmrDead).toBe(true);
  });

  it("flips hmrDead when Vite logs a lost server connection", () => {
    const webview = makeWebviewElement();
    const { result } = renderHook(() => useDevPreviewConsoleCapture(PANE_ID, webview, true, false));
    act(() => {
      messageCb?.(row({ summaryText: "[vite] server connection lost. Polling for restart..." }));
    });
    expect(result.current.hmrDead).toBe(true);
  });

  it("matches the failure string case-insensitively", () => {
    const webview = makeWebviewElement();
    const { result } = renderHook(() => useDevPreviewConsoleCapture(PANE_ID, webview, true, false));
    act(() => {
      messageCb?.(row({ summaryText: "[VITE] FAILED TO CONNECT TO WEBSOCKET." }));
    });
    expect(result.current.hmrDead).toBe(true);
  });

  it("ignores ordinary HMR update logs", () => {
    const webview = makeWebviewElement();
    const { result } = renderHook(() => useDevPreviewConsoleCapture(PANE_ID, webview, true, false));
    act(() => {
      messageCb?.(row({ level: "info", summaryText: "[vite] hmr update /src/App.tsx" }));
    });
    expect(result.current.hmrDead).toBe(false);
  });

  it("ignores failure logs from a different pane", () => {
    const webview = makeWebviewElement();
    const { result } = renderHook(() => useDevPreviewConsoleCapture(PANE_ID, webview, true, false));
    act(() => {
      messageCb?.(
        row({ paneId: "other-pane", summaryText: "[vite] failed to connect to websocket." })
      );
    });
    expect(result.current.hmrDead).toBe(false);
  });

  it("clears hmrDead when the guest execution context is cleared (reload/navigation)", () => {
    const webview = makeWebviewElement();
    const { result } = renderHook(() => useDevPreviewConsoleCapture(PANE_ID, webview, true, false));
    act(() => {
      messageCb?.(row({ summaryText: "[vite] failed to connect to websocket." }));
    });
    expect(result.current.hmrDead).toBe(true);

    act(() => {
      clearedCb?.({ paneId: PANE_ID, navigationGeneration: 2 });
    });
    expect(result.current.hmrDead).toBe(false);
  });

  it("does not clear hmrDead when a different pane's context is cleared", () => {
    const webview = makeWebviewElement();
    const { result } = renderHook(() => useDevPreviewConsoleCapture(PANE_ID, webview, true, false));
    act(() => {
      messageCb?.(row({ summaryText: "[vite] failed to connect to websocket." }));
    });
    act(() => {
      clearedCb?.({ paneId: "other-pane", navigationGeneration: 2 });
    });
    expect(result.current.hmrDead).toBe(true);
  });

  it("clears hmrDead when resetHmrDead is called", () => {
    const webview = makeWebviewElement();
    const { result } = renderHook(() => useDevPreviewConsoleCapture(PANE_ID, webview, true, false));
    act(() => {
      messageCb?.(row({ summaryText: "[vite] failed to connect to websocket." }));
    });
    expect(result.current.hmrDead).toBe(true);

    act(() => {
      result.current.resetHmrDead();
    });
    expect(result.current.hmrDead).toBe(false);
  });

  it("keeps a stable resetHmrDead identity across rerenders", () => {
    const webview = makeWebviewElement();
    const { result, rerender } = renderHook(() =>
      useDevPreviewConsoleCapture(PANE_ID, webview, true, false)
    );
    const first = result.current.resetHmrDead;
    rerender();
    expect(result.current.resetHmrDead).toBe(first);
  });

  it("ignores stale failures from an older generation after a context clear", () => {
    // Restart leaves the old guest page polling and logging failures from its
    // now-defunct generation. Once the page reloads (context clear advances the
    // generation), those stragglers must not resurrect the banner.
    const webview = makeWebviewElement();
    const { result } = renderHook(() => useDevPreviewConsoleCapture(PANE_ID, webview, true, false));
    act(() => {
      clearedCb?.({ paneId: PANE_ID, navigationGeneration: 2 });
    });
    act(() => {
      messageCb?.(
        row({
          navigationGeneration: 1,
          summaryText: "[vite] server connection lost. Polling for restart...",
        })
      );
    });
    expect(result.current.hmrDead).toBe(false);
  });

  it("still flips on a failure from the current generation after a context clear", () => {
    const webview = makeWebviewElement();
    const { result } = renderHook(() => useDevPreviewConsoleCapture(PANE_ID, webview, true, false));
    act(() => {
      clearedCb?.({ paneId: PANE_ID, navigationGeneration: 2 });
    });
    act(() => {
      messageCb?.(
        row({ navigationGeneration: 2, summaryText: "[vite] failed to connect to websocket." })
      );
    });
    expect(result.current.hmrDead).toBe(true);
  });

  it("matches the multi-line Vite failure log", () => {
    const webview = makeWebviewElement();
    const { result } = renderHook(() => useDevPreviewConsoleCapture(PANE_ID, webview, true, false));
    act(() => {
      messageCb?.(
        row({
          summaryText:
            "[vite] failed to connect to websocket.\nyour current setup:\n  (browser) localhost:5173/ <--[HTTP]--> localhost:5173/ (server)\n  (browser) localhost:5173/ <--[WebSocket (failing)]--> localhost:5173/ (server)",
        })
      );
    });
    expect(result.current.hmrDead).toBe(true);
  });

  it("isolates hmrDead between concurrent panes", () => {
    const webview = makeWebviewElement();
    // The hook reads its callback from the shared mock; render the second pane
    // last so messageCb routes through the pane-2 instance, then target pane-1.
    const { result: pane1 } = renderHook(() =>
      useDevPreviewConsoleCapture(PANE_ID, webview, true, false)
    );
    act(() => {
      messageCb?.(row({ paneId: "pane-2", summaryText: "[vite] failed to connect to websocket." }));
    });
    expect(pane1.current.hmrDead).toBe(false);
  });
});
