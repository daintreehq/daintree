// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { useFindInPage } from "../useFindInPage";

const focusWebviewPageMock = vi.hoisted(() => vi.fn(() => true));
vi.mock("@/components/Browser/browserUtils", () => ({
  focusWebviewPage: focusWebviewPageMock,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const onFindShortcutMock: Mock<any> = vi.fn(() => vi.fn());

vi.mock("@/hooks/useFindInPage", async (importOriginal) => {
  return importOriginal();
});

beforeEach(() => {
  (globalThis as Record<string, unknown>).window = globalThis;
  Object.defineProperty(globalThis, "electron", {
    value: {
      webview: {
        onFindShortcut: onFindShortcutMock,
      },
    },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  onFindShortcutMock.mockClear();
  focusWebviewPageMock.mockClear();
});

interface MockWebview {
  findInPage: Mock;
  stopFindInPage: Mock;
  addEventListener: Mock;
  removeEventListener: Mock;
  _emit: (type: string, payload: Record<string, unknown>) => void;
}

function createMockWebview(): Electron.WebviewTag & MockWebview {
  const listeners = new Map<string, Set<EventListener>>();
  const mock: MockWebview = {
    findInPage: vi.fn(() => 1),
    stopFindInPage: vi.fn(),
    addEventListener: vi.fn((type: string, handler: EventListener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(handler);
    }),
    removeEventListener: vi.fn((type: string, handler: EventListener) => {
      listeners.get(type)?.delete(handler);
    }),
    _emit(type: string, payload: Record<string, unknown>) {
      const event = new Event(type);
      Object.assign(event, payload);
      listeners.get(type)?.forEach((h) => h(event));
    },
  };
  return mock as unknown as Electron.WebviewTag & MockWebview;
}

describe("useFindInPage", () => {
  it("opens and closes the find bar", () => {
    const webview = createMockWebview();
    const { result } = renderHook(() => useFindInPage("panel-1", webview, true, true));

    act(() => result.current.open());
    expect(result.current.isOpen).toBe(true);

    act(() => result.current.close());
    expect(result.current.isOpen).toBe(false);
    expect(webview.stopFindInPage).toHaveBeenCalledWith("clearSelection");
  });

  it("calls findInPage when query changes", () => {
    const webview = createMockWebview();
    const { result } = renderHook(() => useFindInPage("panel-1", webview, true, true));

    act(() => result.current.open());
    act(() => result.current.setQuery("hello"));

    expect(webview.findInPage).toHaveBeenCalledWith("hello", { findNext: true, matchCase: false });
    expect(result.current.query).toBe("hello");
  });

  it("steps through the open session for goNext/goPrev", () => {
    const webview = createMockWebview();
    const { result } = renderHook(() => useFindInPage("panel-1", webview, true, true));

    act(() => result.current.open());
    act(() => result.current.setQuery("test"));
    webview.findInPage.mockClear();

    act(() => result.current.goNext());
    expect(webview.findInPage).toHaveBeenCalledWith("test", {
      forward: true,
      findNext: false,
      matchCase: false,
    });

    webview.findInPage.mockClear();

    act(() => result.current.goPrev());
    expect(webview.findInPage).toHaveBeenCalledWith("test", {
      forward: false,
      findNext: false,
      matchCase: false,
    });
  });

  it("clears state and calls stopFindInPage when query is emptied", () => {
    const webview = createMockWebview();
    const { result } = renderHook(() => useFindInPage("panel-1", webview, true, true));

    act(() => result.current.open());
    act(() => result.current.setQuery("test"));
    webview.stopFindInPage.mockClear();

    act(() => result.current.setQuery(""));
    expect(webview.stopFindInPage).toHaveBeenCalledWith("clearSelection");
    expect(result.current.matchCount).toBe(0);
    expect(result.current.activeMatch).toBe(0);
  });

  it("opens find bar on daintree:find-in-panel when focused", () => {
    const webview = createMockWebview();
    const { result } = renderHook(() => useFindInPage("panel-1", webview, true, true));

    act(() => {
      window.dispatchEvent(new Event("daintree:find-in-panel"));
    });

    expect(result.current.isOpen).toBe(true);
  });

  it("does not open find bar on daintree:find-in-panel when not focused", () => {
    const webview = createMockWebview();
    const { result } = renderHook(() => useFindInPage("panel-1", webview, true, false));

    act(() => {
      window.dispatchEvent(new Event("daintree:find-in-panel"));
    });

    expect(result.current.isOpen).toBe(false);
  });

  // #16877: a panel dialog's pane and the grid pane under it are both focused;
  // only the one inside the modal that holds the keys may open its find bar.
  describe("while an app modal holds the keyboard", () => {
    const mounted: HTMLElement[] = [];
    afterEach(() => {
      mounted.splice(0).forEach((el) => el.remove());
    });

    function webviewIn(parent: HTMLElement): Electron.WebviewTag & MockWebview {
      const el = Object.assign(document.createElement("div"), createMockWebview());
      parent.appendChild(el);
      return el as unknown as Electron.WebviewTag & MockWebview;
    }

    function focusedModal(): HTMLDivElement {
      const modal = document.createElement("div");
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-modal", "true");
      const button = document.createElement("button");
      modal.appendChild(button);
      document.body.appendChild(modal);
      mounted.push(modal);
      button.focus();
      return modal;
    }

    it("keeps the background pane's find bar shut", () => {
      const grid = document.createElement("div");
      document.body.appendChild(grid);
      mounted.push(grid);
      const webview = webviewIn(grid);
      focusedModal();
      const { result } = renderHook(() => useFindInPage("panel-1", webview, true, true));

      act(() => {
        window.dispatchEvent(new Event("daintree:find-in-panel"));
      });

      expect(result.current.isOpen).toBe(false);
    });

    it("opens the find bar of the pane inside that modal", () => {
      const modal = focusedModal();
      const webview = webviewIn(modal);
      const { result } = renderHook(() => useFindInPage("panel-1", webview, true, true));

      act(() => {
        window.dispatchEvent(new Event("daintree:find-in-panel"));
      });

      expect(result.current.isOpen).toBe(true);
    });

    // An evicted webview, or one waiting on a remote forward, is not mounted;
    // the pane root still places the pane.
    it("reads the modal from the pane root while the webview isn't mounted", () => {
      const modal = focusedModal();
      const pane = document.createElement("div");
      modal.appendChild(pane);
      const paneRef = { current: pane };
      const { result } = renderHook(() => useFindInPage("panel-1", null, false, true, paneRef));

      act(() => {
        window.dispatchEvent(new Event("daintree:find-in-panel"));
      });

      expect(result.current.isOpen).toBe(true);
    });

    it("ignores the guest's forwarded Cmd+F once a modal over the pane has the keys", () => {
      let shortcutCallback: ((payload: { panelId: string; shortcut: string }) => void) | undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onFindShortcutMock.mockImplementation((cb: any) => {
        shortcutCallback = cb;
        return vi.fn();
      });
      const grid = document.createElement("div");
      document.body.appendChild(grid);
      mounted.push(grid);
      const webview = webviewIn(grid);
      const { result } = renderHook(() => useFindInPage("panel-1", webview, true, true));
      focusedModal();

      act(() => shortcutCallback?.({ panelId: "panel-1", shortcut: "find" }));

      expect(shortcutCallback).toBeDefined();
      expect(result.current.isOpen).toBe(false);
    });
  });

  it("handles find shortcut for open/close", () => {
    const webview = createMockWebview();
    let shortcutCallback: (payload: { panelId: string; shortcut: string }) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onFindShortcutMock.mockImplementation((cb: any) => {
      shortcutCallback = cb;
      return vi.fn();
    });

    const { result } = renderHook(() => useFindInPage("panel-1", webview, true, true));

    act(() => shortcutCallback!({ panelId: "panel-1", shortcut: "find" }));
    expect(result.current.isOpen).toBe(true);

    act(() => shortcutCallback!({ panelId: "panel-1", shortcut: "close" }));
    expect(result.current.isOpen).toBe(false);
  });

  it("ignores shortcuts for different panels", () => {
    const webview = createMockWebview();
    let shortcutCallback: (payload: { panelId: string; shortcut: string }) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onFindShortcutMock.mockImplementation((cb: any) => {
      shortcutCallback = cb;
      return vi.fn();
    });

    const { result } = renderHook(() => useFindInPage("panel-1", webview, true, true));

    act(() => shortcutCallback!({ panelId: "panel-2", shortcut: "find" }));
    expect(result.current.isOpen).toBe(false);
  });

  it("calls stopFindInPage on unmount", () => {
    const webview = createMockWebview();
    const { unmount } = renderHook(() => useFindInPage("panel-1", webview, true, true));

    unmount();
    expect(webview.stopFindInPage).toHaveBeenCalledWith("clearSelection");
  });

  it("updates match count on found-in-page event with matching requestId and finalUpdate", () => {
    const webview = createMockWebview();
    webview.findInPage.mockReturnValue(42);
    const { result } = renderHook(() => useFindInPage("panel-1", webview, true, true));

    act(() => result.current.open());
    act(() => result.current.setQuery("hello"));

    // Emit found-in-page with matching requestId and finalUpdate
    act(() => {
      webview._emit("found-in-page", {
        result: { requestId: 42, activeMatchOrdinal: 2, matches: 5, finalUpdate: true },
      });
    });

    expect(result.current.activeMatch).toBe(2);
    expect(result.current.matchCount).toBe(5);
  });

  it("ignores found-in-page events with wrong requestId", () => {
    const webview = createMockWebview();
    webview.findInPage.mockReturnValue(42);
    const { result } = renderHook(() => useFindInPage("panel-1", webview, true, true));

    act(() => result.current.open());
    act(() => result.current.setQuery("hello"));

    act(() => {
      webview._emit("found-in-page", {
        result: { requestId: 999, activeMatchOrdinal: 3, matches: 10, finalUpdate: true },
      });
    });

    expect(result.current.activeMatch).toBe(0);
    expect(result.current.matchCount).toBe(0);
  });

  it("ignores found-in-page events with finalUpdate false", () => {
    const webview = createMockWebview();
    webview.findInPage.mockReturnValue(42);
    const { result } = renderHook(() => useFindInPage("panel-1", webview, true, true));

    act(() => result.current.open());
    act(() => result.current.setQuery("hello"));

    act(() => {
      webview._emit("found-in-page", {
        result: { requestId: 42, activeMatchOrdinal: 1, matches: 3, finalUpdate: false },
      });
    });

    expect(result.current.activeMatch).toBe(0);
    expect(result.current.matchCount).toBe(0);
  });

  it("restarts find on did-navigate-in-page when find bar is open", () => {
    const webview = createMockWebview();
    const { result } = renderHook(() => useFindInPage("panel-1", webview, true, true));

    act(() => result.current.open());
    act(() => result.current.setQuery("test"));
    webview.findInPage.mockClear();

    // Simulate SPA navigation
    act(() => {
      webview._emit("did-navigate-in-page", {
        isMainFrame: true,
        url: "http://localhost:3000/new",
      });
    });

    expect(webview.findInPage).toHaveBeenCalledWith("test", { findNext: true, matchCase: false });
  });

  it("does not restart find on did-navigate-in-page for non-main frame", () => {
    const webview = createMockWebview();
    const { result } = renderHook(() => useFindInPage("panel-1", webview, true, true));

    act(() => result.current.open());
    act(() => result.current.setQuery("test"));
    webview.findInPage.mockClear();

    act(() => {
      webview._emit("did-navigate-in-page", {
        isMainFrame: false,
        url: "http://localhost:3000/iframe",
      });
    });

    expect(webview.findInPage).not.toHaveBeenCalled();
  });

  it("handles IPC next and prev shortcuts", () => {
    const webview = createMockWebview();
    let shortcutCallback: (payload: { panelId: string; shortcut: string }) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onFindShortcutMock.mockImplementation((cb: any) => {
      shortcutCallback = cb;
      return vi.fn();
    });

    const { result } = renderHook(() => useFindInPage("panel-1", webview, true, true));

    act(() => result.current.open());
    act(() => result.current.setQuery("test"));
    webview.findInPage.mockClear();

    act(() => shortcutCallback!({ panelId: "panel-1", shortcut: "next" }));
    expect(webview.findInPage).toHaveBeenCalledWith("test", {
      forward: true,
      findNext: false,
      matchCase: false,
    });

    webview.findInPage.mockClear();

    act(() => shortcutCallback!({ panelId: "panel-1", shortcut: "prev" }));
    expect(webview.findInPage).toHaveBeenCalledWith("test", {
      forward: false,
      findNext: false,
      matchCase: false,
    });
  });

  it("toggleMatchCase re-issues find with matchCase when query is active", () => {
    const webview = createMockWebview();
    const { result } = renderHook(() => useFindInPage("panel-1", webview, true, true));

    act(() => result.current.open());
    act(() => result.current.setQuery("test"));
    webview.findInPage.mockClear();

    act(() => result.current.toggleMatchCase());
    expect(webview.findInPage).toHaveBeenCalledWith("test", { findNext: true, matchCase: true });
  });

  it("goNext/goPrev preserve current matchCase", () => {
    const webview = createMockWebview();
    const { result } = renderHook(() => useFindInPage("panel-1", webview, true, true));

    act(() => result.current.open());
    act(() => result.current.setQuery("test"));
    act(() => result.current.toggleMatchCase());
    webview.findInPage.mockClear();

    act(() => result.current.goNext());
    expect(webview.findInPage).toHaveBeenCalledWith("test", {
      forward: true,
      findNext: false,
      matchCase: true,
    });

    webview.findInPage.mockClear();
    act(() => result.current.goPrev());
    expect(webview.findInPage).toHaveBeenCalledWith("test", {
      forward: false,
      findNext: false,
      matchCase: true,
    });
  });

  it("keeps the query and matchCase across a close and reopen", () => {
    const webview = createMockWebview();
    const { result } = renderHook(() => useFindInPage("panel-1", webview, true, true));

    act(() => result.current.open());
    act(() => result.current.toggleMatchCase());
    act(() => result.current.setQuery("hello"));

    act(() => result.current.close());
    expect(result.current.isOpen).toBe(false);
    expect(result.current.query).toBe("hello");
    expect(result.current.matchCase).toBe(true);

    act(() => result.current.open());
    expect(result.current.query).toBe("hello");
    expect(result.current.matchCase).toBe(true);
  });

  it("clears the page's find session and the counts on close", () => {
    const webview = createMockWebview();
    const { result } = renderHook(() => useFindInPage("panel-1", webview, true, true));

    act(() => result.current.open());
    act(() => result.current.setQuery("hello"));
    act(() => {
      webview._emit("found-in-page", {
        result: { requestId: 1, activeMatchOrdinal: 2, matches: 5, finalUpdate: true },
      });
    });
    expect(result.current.matchCount).toBe(5);
    webview.stopFindInPage.mockClear();

    act(() => result.current.close());
    expect(webview.stopFindInPage).toHaveBeenCalledWith("clearSelection");
    expect(result.current.matchCount).toBe(0);
    expect(result.current.activeMatch).toBe(0);
  });

  it("searches again with the kept query and matchCase when the bar reopens", () => {
    const webview = createMockWebview();
    webview.findInPage.mockReturnValueOnce(1).mockReturnValueOnce(2);
    const { result } = renderHook(() => useFindInPage("panel-1", webview, true, true));

    act(() => result.current.open());
    act(() => result.current.toggleMatchCase());
    act(() => result.current.setQuery("hello"));
    act(() => result.current.close());
    webview.findInPage.mockClear();

    act(() => result.current.open());
    expect(webview.findInPage).toHaveBeenCalledTimes(1);
    expect(webview.findInPage).toHaveBeenCalledWith("hello", { findNext: true, matchCase: true });

    act(() => {
      webview._emit("found-in-page", {
        result: { requestId: 2, activeMatchOrdinal: 1, matches: 4, finalUpdate: true },
      });
    });
    expect(result.current.matchCount).toBe(4);
  });

  it("does not search on reopen when no query was kept", () => {
    const webview = createMockWebview();
    const { result } = renderHook(() => useFindInPage("panel-1", webview, true, true));

    act(() => result.current.open());
    act(() => result.current.toggleMatchCase());
    act(() => result.current.close());
    act(() => result.current.open());

    expect(webview.findInPage).not.toHaveBeenCalled();
    expect(result.current.matchCase).toBe(true);
  });

  it("does not search on reopen while an IME composition is in progress", () => {
    const webview = createMockWebview();
    const { result } = renderHook(() => useFindInPage("panel-1", webview, true, true));

    act(() => result.current.open());
    act(() => result.current.setQuery("hello"));
    act(() => result.current.close());
    webview.findInPage.mockClear();
    result.current.isComposingRef.current = true;

    act(() => result.current.open());
    expect(webview.findInPage).not.toHaveBeenCalled();
  });

  it("does not search again when open is called on a bar that is already open", () => {
    const webview = createMockWebview();
    const { result } = renderHook(() => useFindInPage("panel-1", webview, true, true));

    act(() => result.current.open());
    act(() => result.current.setQuery("hello"));
    webview.findInPage.mockClear();

    act(() => result.current.open());
    expect(webview.findInPage).not.toHaveBeenCalled();
  });

  it("hands the keyboard back to the webview page on close", () => {
    const webview = createMockWebview();
    const { result } = renderHook(() => useFindInPage("panel-1", webview, true, true));

    act(() => result.current.open());
    expect(focusWebviewPageMock).not.toHaveBeenCalled();

    act(() => result.current.close());
    expect(focusWebviewPageMock).toHaveBeenCalledTimes(1);
    expect(focusWebviewPageMock).toHaveBeenCalledWith(webview);
  });

  it("hands the keyboard back when the guest forwards the close shortcut", () => {
    const webview = createMockWebview();
    let shortcutCallback: (payload: { panelId: string; shortcut: string }) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onFindShortcutMock.mockImplementation((cb: any) => {
      shortcutCallback = cb;
      return vi.fn();
    });
    const { result } = renderHook(() => useFindInPage("panel-1", webview, true, true));

    act(() => shortcutCallback!({ panelId: "panel-1", shortcut: "find" }));
    act(() => shortcutCallback!({ panelId: "panel-1", shortcut: "close" }));

    expect(result.current.isOpen).toBe(false);
    expect(focusWebviewPageMock).toHaveBeenCalledWith(webview);
  });

  it("searches once when the bar reopens as the webview becomes ready", () => {
    const webview = createMockWebview();
    const { result, rerender } = renderHook(
      ({ ready }) => useFindInPage("panel-1", webview, ready, true),
      { initialProps: { ready: true } }
    );

    act(() => result.current.open());
    act(() => result.current.setQuery("hello"));
    act(() => result.current.close());
    rerender({ ready: false });
    webview.findInPage.mockClear();

    act(() => {
      result.current.open();
      rerender({ ready: true });
    });
    expect(webview.findInPage).toHaveBeenCalledTimes(1);
    expect(webview.findInPage).toHaveBeenCalledWith("hello", { findNext: true, matchCase: false });
  });

  it("does not search while closed when the webview becomes ready or is replaced", () => {
    const first = createMockWebview();
    const second = createMockWebview();
    const { result, rerender } = renderHook(
      ({ webview, ready }) => useFindInPage("panel-1", webview, ready, true),
      { initialProps: { webview: first, ready: true } }
    );

    act(() => result.current.open());
    act(() => result.current.setQuery("hello"));
    act(() => result.current.close());
    first.findInPage.mockClear();

    rerender({ webview: first, ready: false });
    rerender({ webview: first, ready: true });
    rerender({ webview: second, ready: true });

    expect(first.findInPage).not.toHaveBeenCalled();
    expect(second.findInPage).not.toHaveBeenCalled();
    expect(result.current.query).toBe("hello");
  });

  it("starts a fresh find session when the hook is reused for another pane", () => {
    const webview = createMockWebview();
    const { result, rerender } = renderHook(
      ({ panelId }) => useFindInPage(panelId, webview, true, true),
      { initialProps: { panelId: "panel-1" } }
    );

    act(() => result.current.open());
    act(() => result.current.toggleMatchCase());
    act(() => result.current.setQuery("hello"));
    act(() => result.current.close());
    expect(result.current.query).toBe("hello");

    rerender({ panelId: "panel-2" });
    expect(result.current.query).toBe("");
    expect(result.current.matchCase).toBe(false);
    expect(result.current.isOpen).toBe(false);

    webview.findInPage.mockClear();
    act(() => result.current.open());
    expect(webview.findInPage).not.toHaveBeenCalled();
  });

  it("closes an open bar and ends its search when the hook is reused for another pane", () => {
    const webview = createMockWebview();
    const { result, rerender } = renderHook(
      ({ panelId }) => useFindInPage(panelId, webview, true, true),
      { initialProps: { panelId: "panel-1" } }
    );

    act(() => result.current.open());
    act(() => result.current.setQuery("hello"));
    act(() => {
      webview._emit("found-in-page", {
        result: { requestId: 1, activeMatchOrdinal: 2, matches: 5, finalUpdate: true },
      });
    });
    expect(result.current.matchCount).toBe(5);
    result.current.isComposingRef.current = true;
    webview.findInPage.mockClear();
    webview.stopFindInPage.mockClear();

    rerender({ panelId: "panel-2" });

    expect(result.current.isOpen).toBe(false);
    expect(result.current.query).toBe("");
    expect(result.current.matchCount).toBe(0);
    expect(result.current.activeMatch).toBe(0);
    expect(result.current.isComposingRef.current).toBe(false);
    expect(webview.stopFindInPage).toHaveBeenCalledWith("clearSelection");
    expect(webview.findInPage).not.toHaveBeenCalled();

    act(() => result.current.open());
    act(() => result.current.setQuery("again"));
    expect(webview.findInPage).toHaveBeenCalledWith("again", { findNext: true, matchCase: false });
  });

  it("does not step a search the closed bar no longer shows", () => {
    const webview = createMockWebview();
    let shortcutCallback: (payload: { panelId: string; shortcut: string }) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onFindShortcutMock.mockImplementation((cb: any) => {
      shortcutCallback = cb;
      return vi.fn();
    });
    const { result } = renderHook(() => useFindInPage("panel-1", webview, true, true));

    act(() => result.current.open());
    act(() => result.current.setQuery("hello"));
    act(() => result.current.close());
    webview.findInPage.mockClear();

    act(() => shortcutCallback!({ panelId: "panel-1", shortcut: "next" }));
    act(() => shortcutCallback!({ panelId: "panel-1", shortcut: "prev" }));
    expect(webview.findInPage).not.toHaveBeenCalled();
  });

  it("clears an IME composition the closing bar can no longer end", () => {
    const webview = createMockWebview();
    const { result } = renderHook(() => useFindInPage("panel-1", webview, true, true));

    act(() => result.current.open());
    result.current.isComposingRef.current = true;
    act(() => result.current.close());

    expect(result.current.isComposingRef.current).toBe(false);
  });

  it("still closes when there is no webview to hand the keyboard to", () => {
    focusWebviewPageMock.mockReturnValueOnce(false);
    const { result } = renderHook(() => useFindInPage("panel-1", null, false, true));

    act(() => result.current.open());
    act(() => result.current.close());

    expect(result.current.isOpen).toBe(false);
  });

  it("empty query + toggle does not call findInPage", () => {
    const webview = createMockWebview();
    const { result } = renderHook(() => useFindInPage("panel-1", webview, true, true));

    webview.findInPage.mockClear();
    act(() => result.current.toggleMatchCase());
    expect(webview.findInPage).not.toHaveBeenCalled();
  });

  it("SPA navigation restart preserves matchCase", () => {
    const webview = createMockWebview();
    const { result } = renderHook(() => useFindInPage("panel-1", webview, true, true));

    act(() => result.current.open());
    act(() => result.current.setQuery("test"));
    act(() => result.current.toggleMatchCase());
    webview.findInPage.mockClear();

    act(() => {
      webview._emit("did-navigate-in-page", {
        isMainFrame: true,
        url: "http://localhost:3000/new",
      });
    });

    expect(webview.findInPage).toHaveBeenCalledWith("test", { findNext: true, matchCase: true });
  });

  it("resumes an open query when the webview becomes ready", () => {
    const webview = createMockWebview();
    const { result, rerender } = renderHook(
      ({ ready }) => useFindInPage("panel-1", webview, ready, true),
      { initialProps: { ready: false } }
    );

    act(() => result.current.open());
    act(() => result.current.setQuery("hello"));
    expect(webview.findInPage).not.toHaveBeenCalled();

    rerender({ ready: true });

    expect(webview.findInPage).toHaveBeenCalledTimes(1);
    expect(webview.findInPage).toHaveBeenCalledWith("hello", { findNext: true, matchCase: false });
  });

  it("resumes an open query on a replacement webview and drops the old match state", () => {
    const webviewA = createMockWebview();
    webviewA.findInPage.mockReturnValue(7);
    const webviewB = createMockWebview();
    webviewB.findInPage.mockReturnValue(3);
    const { result, rerender } = renderHook(
      ({ webview }) => useFindInPage("panel-1", webview, true, true),
      { initialProps: { webview: webviewA } }
    );

    act(() => result.current.open());
    act(() => result.current.setQuery("hello"));
    act(() => result.current.toggleMatchCase());
    act(() => {
      webviewA._emit("found-in-page", {
        result: { requestId: 7, activeMatchOrdinal: 2, matches: 4, finalUpdate: true },
      });
    });
    expect(result.current.matchCount).toBe(4);

    rerender({ webview: webviewB });

    expect(webviewB.findInPage).toHaveBeenCalledTimes(1);
    expect(webviewB.findInPage).toHaveBeenCalledWith("hello", { findNext: true, matchCase: true });
    expect(result.current.activeMatch).toBe(0);
    expect(result.current.matchCount).toBe(0);

    act(() => {
      webviewB._emit("found-in-page", {
        result: { requestId: 7, activeMatchOrdinal: 1, matches: 9, finalUpdate: true },
      });
    });
    expect(result.current.matchCount).toBe(0);

    act(() => {
      webviewB._emit("found-in-page", {
        result: { requestId: 3, activeMatchOrdinal: 1, matches: 2, finalUpdate: true },
      });
    });
    expect(result.current.matchCount).toBe(2);
  });

  it("does not resume when the find bar is closed or the query is empty", () => {
    const webview = createMockWebview();
    const { result, rerender } = renderHook(
      ({ ready }) => useFindInPage("panel-1", webview, ready, true),
      { initialProps: { ready: false } }
    );

    rerender({ ready: true });
    expect(webview.findInPage).not.toHaveBeenCalled();

    rerender({ ready: false });
    act(() => result.current.open());
    rerender({ ready: true });
    expect(webview.findInPage).not.toHaveBeenCalled();
  });

  it("does not resume while an IME composition is in progress", () => {
    const webview = createMockWebview();
    const { result, rerender } = renderHook(
      ({ ready }) => useFindInPage("panel-1", webview, ready, true),
      { initialProps: { ready: false } }
    );

    act(() => result.current.open());
    act(() => result.current.setQuery("hello"));
    result.current.isComposingRef.current = true;

    rerender({ ready: true });
    expect(webview.findInPage).not.toHaveBeenCalled();
  });

  it("does not re-issue a find from the resume path when typing or toggling matchCase", () => {
    const webview = createMockWebview();
    const { result } = renderHook(() => useFindInPage("panel-1", webview, true, true));

    act(() => result.current.open());
    act(() => result.current.setQuery("h"));
    act(() => result.current.setQuery("he"));
    act(() => result.current.toggleMatchCase());

    expect(webview.findInPage).toHaveBeenCalledTimes(3);
  });

  it("resumes with the latest query and matchCase set while unready", () => {
    const webview = createMockWebview();
    const { result, rerender } = renderHook(
      ({ ready }) => useFindInPage("panel-1", webview, ready, true),
      { initialProps: { ready: false } }
    );

    act(() => result.current.open());
    act(() => result.current.setQuery("h"));
    act(() => result.current.setQuery("hello"));
    act(() => result.current.toggleMatchCase());

    rerender({ ready: true });

    expect(webview.findInPage).toHaveBeenCalledTimes(1);
    expect(webview.findInPage).toHaveBeenCalledWith("hello", { findNext: true, matchCase: true });
  });

  it("clears stale results when readiness drops and resumes once when it returns", () => {
    const webview = createMockWebview();
    webview.findInPage.mockReturnValueOnce(1).mockReturnValueOnce(2);
    const { result, rerender } = renderHook(
      ({ ready }) => useFindInPage("panel-1", webview, ready, true),
      { initialProps: { ready: true } }
    );

    act(() => result.current.open());
    act(() => result.current.setQuery("hello"));
    act(() => {
      webview._emit("found-in-page", {
        result: { requestId: 1, activeMatchOrdinal: 1, matches: 3, finalUpdate: true },
      });
    });
    expect(result.current.matchCount).toBe(3);

    rerender({ ready: false });
    expect(result.current.matchCount).toBe(0);
    act(() => {
      webview._emit("found-in-page", {
        result: { requestId: 1, activeMatchOrdinal: 1, matches: 3, finalUpdate: true },
      });
    });
    expect(result.current.matchCount).toBe(0);

    rerender({ ready: true });
    expect(webview.findInPage).toHaveBeenCalledTimes(2);
    act(() => {
      webview._emit("found-in-page", {
        result: { requestId: 2, activeMatchOrdinal: 1, matches: 5, finalUpdate: true },
      });
    });
    expect(result.current.matchCount).toBe(5);
  });
});

// Mirrors what Electron 42's guest find does, as measured: `findNext: true`
// opens a session, `false` steps through it, and a step with no session open
// is never answered. Replies arrive after `findInPage` returns its id.
function createSessionWebview(matchesFor: (text: string, matchCase: boolean) => number) {
  const webview = createMockWebview();
  let nextId = 0;
  let session: { text: string; active: number } | null = null;
  const pending: Array<Record<string, unknown>> = [];
  webview.findInPage.mockImplementation(
    (text: string, opts: { findNext?: boolean; forward?: boolean; matchCase?: boolean }) => {
      const requestId = ++nextId;
      const matches = matchesFor(text, opts.matchCase ?? false);
      if (opts.findNext || (session && session.text !== text)) {
        session = { text, active: matches > 0 ? 1 : 0 };
      } else if (session) {
        const step = opts.forward === false ? -1 : 1;
        session.active = matches > 0 ? ((session.active - 1 + step + matches) % matches) + 1 : 0;
      } else {
        return requestId;
      }
      pending.push({ requestId, activeMatchOrdinal: session.active, matches, finalUpdate: true });
      return requestId;
    }
  );
  webview.stopFindInPage.mockImplementation(() => {
    session = null;
  });
  const flush = () =>
    act(() => {
      for (const result of pending.splice(0)) webview._emit("found-in-page", { result });
    });
  return { webview, flush };
}

describe("useFindInPage against Electron's find sessions", () => {
  it("shows the match count while the query is typed", () => {
    const { webview, flush } = createSessionWebview((text) => (text.startsWith("FIND") ? 3 : 0));
    const { result } = renderHook(() => useFindInPage("panel-1", webview, true, true));

    act(() => result.current.open());
    act(() => result.current.setQuery("FIND"));
    flush();

    expect(result.current.matchCount).toBe(3);
    expect(result.current.activeMatch).toBe(1);
  });

  it("moves through the matches with goNext and goPrev", () => {
    const { webview, flush } = createSessionWebview(() => 3);
    const { result } = renderHook(() => useFindInPage("panel-1", webview, true, true));

    act(() => result.current.open());
    act(() => result.current.setQuery("FINDME"));
    flush();
    act(() => result.current.goNext());
    flush();
    expect(result.current.activeMatch).toBe(2);

    act(() => result.current.goNext());
    flush();
    expect(result.current.activeMatch).toBe(3);

    act(() => result.current.goPrev());
    flush();
    expect(result.current.activeMatch).toBe(2);
    expect(result.current.matchCount).toBe(3);
  });

  it("starts a fresh session when match case is toggled", () => {
    const { webview, flush } = createSessionWebview((_text, matchCase) => (matchCase ? 3 : 4));
    const { result } = renderHook(() => useFindInPage("panel-1", webview, true, true));

    act(() => result.current.open());
    act(() => result.current.setQuery("Find"));
    flush();
    act(() => result.current.goNext());
    flush();
    expect(result.current.activeMatch).toBe(2);
    expect(result.current.matchCount).toBe(4);

    act(() => result.current.toggleMatchCase());
    flush();
    expect(result.current.activeMatch).toBe(1);
    expect(result.current.matchCount).toBe(3);

    act(() => result.current.goNext());
    flush();
    expect(result.current.activeMatch).toBe(2);

    act(() => result.current.toggleMatchCase());
    flush();
    expect(webview.findInPage).toHaveBeenLastCalledWith("Find", {
      findNext: true,
      matchCase: false,
    });
    expect(result.current.activeMatch).toBe(1);
    expect(result.current.matchCount).toBe(4);
  });
});
