// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { useFindInPage } from "../useFindInPage";

const onFindShortcutMock = vi.fn(() => vi.fn());

vi.mock("@/hooks/useFindInPage", async (importOriginal) => {
  return importOriginal();
});

// Mock window.electron.webview.onFindShortcut
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
});

function createMockWebview() {
  const listeners = new Map<string, Set<EventListener>>();
  const mock = {
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
  return mock as unknown as Electron.WebviewTag & {
    _emit: (type: string, payload: Record<string, unknown>) => void;
  };
}

describe("useFindInPage", () => {
  it("starts closed with empty state", () => {
    const { result } = renderHook(() => useFindInPage("panel-1", null, false, false));

    expect(result.current.isOpen).toBe(false);
    expect(result.current.query).toBe("");
    expect(result.current.activeMatch).toBe(0);
    expect(result.current.matchCount).toBe(0);
  });

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

    expect(webview.findInPage).toHaveBeenCalledWith("hello", { findNext: false });
    expect(result.current.query).toBe("hello");
  });

  it("calls findInPage with findNext for goNext/goPrev", () => {
    const webview = createMockWebview();
    const { result } = renderHook(() => useFindInPage("panel-1", webview, true, true));

    act(() => result.current.open());
    act(() => result.current.setQuery("test"));
    webview.findInPage.mockClear();

    act(() => result.current.goNext());
    expect(webview.findInPage).toHaveBeenCalledWith("test", {
      forward: true,
      findNext: true,
    });

    webview.findInPage.mockClear();

    act(() => result.current.goPrev());
    expect(webview.findInPage).toHaveBeenCalledWith("test", {
      forward: false,
      findNext: true,
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

  it("opens find bar on canopy:find-in-panel when focused", () => {
    const webview = createMockWebview();
    const { result } = renderHook(() => useFindInPage("panel-1", webview, true, true));

    act(() => {
      window.dispatchEvent(new Event("canopy:find-in-panel"));
    });

    expect(result.current.isOpen).toBe(true);
  });

  it("does not open find bar on canopy:find-in-panel when not focused", () => {
    const webview = createMockWebview();
    const { result } = renderHook(() => useFindInPage("panel-1", webview, true, false));

    act(() => {
      window.dispatchEvent(new Event("canopy:find-in-panel"));
    });

    expect(result.current.isOpen).toBe(false);
  });

  it("subscribes to onFindShortcut IPC", () => {
    const webview = createMockWebview();
    renderHook(() => useFindInPage("panel-1", webview, true, true));

    expect(onFindShortcutMock).toHaveBeenCalled();
  });

  it("handles find shortcut for open/close", () => {
    const webview = createMockWebview();
    let shortcutCallback: (payload: { panelId: string; shortcut: string }) => void;
    onFindShortcutMock.mockImplementation((cb: typeof shortcutCallback) => {
      shortcutCallback = cb;
      return vi.fn();
    });

    const { result } = renderHook(() => useFindInPage("panel-1", webview, true, true));

    // Open via shortcut
    act(() => shortcutCallback!({ panelId: "panel-1", shortcut: "find" }));
    expect(result.current.isOpen).toBe(true);

    // Close via shortcut
    act(() => shortcutCallback!({ panelId: "panel-1", shortcut: "close" }));
    expect(result.current.isOpen).toBe(false);
  });

  it("ignores shortcuts for different panels", () => {
    const webview = createMockWebview();
    let shortcutCallback: (payload: { panelId: string; shortcut: string }) => void;
    onFindShortcutMock.mockImplementation((cb: typeof shortcutCallback) => {
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
});
