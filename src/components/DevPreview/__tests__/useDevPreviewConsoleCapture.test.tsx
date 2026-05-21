/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useDevPreviewConsoleCapture } from "../useDevPreviewConsoleCapture";
import { useConsoleCaptureStore } from "@/store/consoleCaptureStore";
import { usePanelStore } from "@/store";
import type { SerializedConsoleRow } from "@shared/types/ipc/webviewConsole";
import type { TerminalInstance } from "@/types";

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
      panelsById: { [PANE_ID]: { id: PANE_ID } as unknown as TerminalInstance },
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
