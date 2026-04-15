// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserPaneProps } from "../BrowserPane";
import { BrowserPane } from "../BrowserPane";

type MockWebviewElement = HTMLElement & {
  reload: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  setZoomFactor: ReturnType<typeof vi.fn>;
  getURL: ReturnType<typeof vi.fn>;
  isLoading: ReturnType<typeof vi.fn>;
  getWebContentsId: ReturnType<typeof vi.fn>;
  capturePage: ReturnType<typeof vi.fn>;
  setMockLoading: (value: boolean) => void;
};

function decorateWebviewElement(element: HTMLElement): MockWebviewElement {
  let currentUrl = element.getAttribute("src") ?? "http://localhost:5173/";
  let loading = false;
  const webview = element as MockWebviewElement;

  const syncUrlFromAttribute = () => {
    const src = element.getAttribute("src");
    if (typeof src === "string" && src.length > 0) {
      currentUrl = src;
    }
  };

  webview.reload = vi.fn();
  webview.loadURL = vi.fn((url: string) => {
    currentUrl = url;
    element.setAttribute("src", url);
  });
  webview.setZoomFactor = vi.fn();
  webview.getURL = vi.fn(() => {
    syncUrlFromAttribute();
    return currentUrl;
  });
  webview.isLoading = vi.fn(() => loading);
  webview.getWebContentsId = vi.fn(() => 42);
  webview.capturePage = vi.fn(() =>
    Promise.resolve({ toPNG: () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]) })
  );
  webview.setMockLoading = (value: boolean) => {
    loading = value;
  };

  return webview;
}

const {
  terminalStoreState,
  usePanelStoreMock,
  useProjectStoreMock,
  useIsDraggingMock,
  actionDispatchMock,
  useUrlHistoryStoreMock,
} = vi.hoisted(() => {
  const terminalStoreState = {
    getTerminal: vi.fn(),
    setBrowserUrl: vi.fn(),
    setBrowserHistory: vi.fn(),
    setBrowserZoom: vi.fn(),
  };
  const usePanelStoreMock = vi.fn((selector: (state: typeof terminalStoreState) => unknown) =>
    selector(terminalStoreState)
  );
  (usePanelStoreMock as unknown as { getState: () => typeof terminalStoreState }).getState = () =>
    terminalStoreState;
  const projectStoreState = { currentProject: { id: "test-project" } };
  const useProjectStoreMock = vi.fn((selector: (state: typeof projectStoreState) => unknown) =>
    selector(projectStoreState)
  );
  const useIsDraggingMock = vi.fn(() => false);
  const actionDispatchMock = vi.fn();
  const urlHistoryStoreState = {
    recordVisit: vi.fn(),
    updateTitle: vi.fn(),
  };
  const useUrlHistoryStoreMock = vi.fn(
    (selector: (state: typeof urlHistoryStoreState) => unknown) => selector(urlHistoryStoreState)
  );
  (useUrlHistoryStoreMock as unknown as { getState: () => typeof urlHistoryStoreState }).getState =
    () => urlHistoryStoreState;
  return {
    terminalStoreState,
    usePanelStoreMock,
    useProjectStoreMock,
    useIsDraggingMock,
    actionDispatchMock,
    useUrlHistoryStoreMock,
  };
});

vi.mock("@/store", () => ({
  usePanelStore: usePanelStoreMock,
  useProjectStore: useProjectStoreMock,
}));

vi.mock("@/store/urlHistoryStore", () => ({
  useUrlHistoryStore: useUrlHistoryStoreMock,
}));

vi.mock("@/components/DragDrop", () => ({
  useIsDragging: useIsDraggingMock,
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: actionDispatchMock,
  },
}));

vi.mock("@/hooks/useWebviewDialog", () => ({
  useWebviewDialog: () => ({ currentDialog: null, handleDialogRespond: vi.fn() }),
}));

vi.mock("@/hooks/useFindInPage", () => ({
  useFindInPage: () => ({
    isOpen: false,
    query: "",
    activeMatch: 0,
    matchCount: 0,
    inputRef: { current: null },
    isComposingRef: { current: false },
    open: vi.fn(),
    close: vi.fn(),
    setQuery: vi.fn(),
    goNext: vi.fn(),
    goPrev: vi.fn(),
  }),
}));

vi.mock("@/components/Browser/BrowserToolbar", () => ({
  BrowserToolbar: () => <div data-testid="browser-toolbar" />,
}));

vi.mock("@/components/Panel", () => ({
  ContentPanel: ({
    children,
    toolbar,
  }: {
    children: React.ReactNode;
    toolbar?: React.ReactNode;
  }) => (
    <div data-testid="content-panel">
      {toolbar}
      {children}
    </div>
  ),
}));

function emitWebviewEvent(
  webview: MockWebviewElement,
  type: string,
  payload: Record<string, unknown> = {}
) {
  const event = new Event(type);
  Object.assign(event, payload);
  webview.dispatchEvent(event);
}

function getWebviewElement(container: HTMLElement): MockWebviewElement {
  const webview = container.querySelector("webview");
  if (!webview) {
    throw new Error("Expected webview element to be rendered");
  }
  return webview as unknown as MockWebviewElement;
}

describe("BrowserPane webview lifecycle regression", () => {
  let originalCreateElement: typeof document.createElement;

  const baseProps: BrowserPaneProps = {
    id: "browser-panel-1",
    title: "Browser",
    initialUrl: "http://localhost:5173/",
    isFocused: true,
    onFocus: vi.fn(),
    onClose: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    // Mock window.electron.webview for CDP console capture
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).window = globalThis.window ?? {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).electron = {
      clipboard: {
        writeImage: vi.fn(() => Promise.resolve({ ok: true })),
      },
      webview: {
        startConsoleCapture: vi.fn(() => Promise.resolve()),
        stopConsoleCapture: vi.fn(() => Promise.resolve()),
        clearConsoleCapture: vi.fn(() => Promise.resolve()),
        getConsoleProperties: vi.fn(() => Promise.resolve({ properties: [] })),
        onConsoleMessage: vi.fn(() => vi.fn()),
        onConsoleContextCleared: vi.fn(() => vi.fn()),
        setLifecycleState: vi.fn(() => Promise.resolve()),
        registerPanel: vi.fn(() => Promise.resolve()),
        respondToDialog: vi.fn(() => Promise.resolve()),
        onDialogRequest: vi.fn(() => vi.fn()),
        onNavigationBlocked: vi.fn(() => vi.fn()),
      },
      window: {
        onDestroyHiddenWebviews: vi.fn(() => vi.fn()),
      },
    };

    originalCreateElement = document.createElement.bind(document);
    document.createElement = ((tagName: string, options?: ElementCreationOptions) => {
      const element = originalCreateElement(tagName, options);
      if (String(tagName).toLowerCase() === "webview") {
        return decorateWebviewElement(element as HTMLElement);
      }
      return element;
    }) as typeof document.createElement;
    terminalStoreState.getTerminal.mockImplementation(() => ({
      id: "browser-panel-1",
      browserHistory: {
        past: [],
        present: "http://localhost:5173/",
        future: [],
      },
      browserZoom: 1.35,
    }));
  });

  afterEach(() => {
    document.createElement = originalCreateElement;
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("renders webview with allowpopups attribute for target=_blank support", () => {
    const { container } = render(<BrowserPane {...baseProps} />);
    const webview = getWebviewElement(container);
    expect(webview.hasAttribute("allowpopups")).toBe(true);
  });

  it("uses theme-backed browser chrome surfaces", () => {
    const { container } = render(<BrowserPane {...baseProps} />);
    const themedSurface = container.querySelector(".bg-surface-canvas");
    expect(themedSurface).toBeTruthy();
    expect(container.querySelector(".bg-white")).toBeNull();
  });

  it("recovers ready/loading state from an already-loaded webview", async () => {
    const { container } = render(<BrowserPane {...baseProps} />);
    const webview = getWebviewElement(container);

    await act(async () => {
      await Promise.resolve();
    });

    expect(webview.setZoomFactor).toHaveBeenCalledWith(1.35);
  });

  it("reloads webview after 30s when loading is stuck", () => {
    const { container } = render(<BrowserPane {...baseProps} />);
    const webview = getWebviewElement(container);

    act(() => {
      webview.setMockLoading(true);
      emitWebviewEvent(webview, "did-start-loading");
    });

    act(() => {
      vi.advanceTimersByTime(30000);
    });

    expect(webview.reload).toHaveBeenCalledTimes(1);
  });

  it("clears stuck-load timeout on did-stop-loading", () => {
    const { container } = render(<BrowserPane {...baseProps} />);
    const webview = getWebviewElement(container);

    act(() => {
      webview.setMockLoading(true);
      emitWebviewEvent(webview, "did-start-loading");
      webview.setMockLoading(false);
      emitWebviewEvent(webview, "did-stop-loading");
    });

    act(() => {
      vi.advanceTimersByTime(30000);
    });

    expect(webview.reload).not.toHaveBeenCalled();
  });

  it("clears stuck-load timeout on did-fail-load", () => {
    const { container } = render(<BrowserPane {...baseProps} />);
    const webview = getWebviewElement(container);

    act(() => {
      webview.setMockLoading(true);
      emitWebviewEvent(webview, "did-start-loading");
      emitWebviewEvent(webview, "did-fail-load", {
        errorCode: -105,
        errorDescription: "Name not resolved",
      });
    });

    act(() => {
      vi.advanceTimersByTime(30000);
    });

    expect(webview.reload).not.toHaveBeenCalled();
  });

  it("cleans pending timeout on unmount", () => {
    const { container, unmount } = render(<BrowserPane {...baseProps} />);
    const webview = getWebviewElement(container);

    act(() => {
      webview.setMockLoading(true);
      emitWebviewEvent(webview, "did-start-loading");
    });

    unmount();

    act(() => {
      vi.advanceTimersByTime(30000);
    });

    expect(webview.reload).not.toHaveBeenCalled();
  });

  it("renders drag protection overlay and hides webview when isDragging is true", () => {
    useIsDraggingMock.mockReturnValue(true);
    const { container } = render(<BrowserPane {...baseProps} />);

    const overlay = container.querySelector(".z-10.bg-transparent");
    expect(overlay).not.toBeNull();

    const webview = container.querySelector("webview");
    expect(webview?.className).toContain("invisible");
    expect(webview?.className).toContain("pointer-events-none");
  });

  it("does not render drag protection overlay when isDragging is false", () => {
    useIsDraggingMock.mockReturnValue(false);
    const { container } = render(<BrowserPane {...baseProps} />);

    const overlay = container.querySelector(".z-10.bg-transparent");
    expect(overlay).toBeNull();

    const webview = container.querySelector("webview");
    expect(webview?.className).not.toContain("invisible");
    expect(webview?.className).not.toContain("pointer-events-none");
  });

  describe("blocked navigation banner", () => {
    function getNavigationBlockedCallback(): (payload: {
      panelId: string;
      url: string;
      canOpenExternal: boolean;
    }) => void {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mock = (window as any).electron.webview.onNavigationBlocked;
      const lastCall = mock.mock.calls[mock.mock.calls.length - 1];
      return lastCall[0];
    }

    it("shows banner with hostname when navigation is blocked", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const callback = getNavigationBlockedCallback();

      act(() => {
        callback({
          panelId: "browser-panel-1",
          url: "https://oauth.example.com/authorize",
          canOpenExternal: true,
        });
        vi.advanceTimersByTime(150);
      });

      expect(container.textContent).toContain("oauth.example.com");
      expect(container.textContent).toContain("Open in External Browser");
    });

    it("ignores events for different panelId", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const callback = getNavigationBlockedCallback();

      act(() => {
        callback({ panelId: "other-panel", url: "https://evil.com", canOpenExternal: true });
        vi.advanceTimersByTime(150);
      });

      expect(container.textContent).not.toContain("evil.com");
    });

    it("shows only the last URL when multiple events fire within 150ms", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const callback = getNavigationBlockedCallback();

      act(() => {
        callback({
          panelId: "browser-panel-1",
          url: "https://first.com/step1",
          canOpenExternal: true,
        });
        callback({
          panelId: "browser-panel-1",
          url: "https://second.com/step2",
          canOpenExternal: true,
        });
        callback({
          panelId: "browser-panel-1",
          url: "https://final.com/done",
          canOpenExternal: true,
        });
        vi.advanceTimersByTime(150);
      });

      expect(container.textContent).toContain("final.com");
      expect(container.textContent).not.toContain("first.com");
      expect(container.textContent).not.toContain("second.com");
    });

    it("dismiss button clears the banner", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const callback = getNavigationBlockedCallback();

      act(() => {
        callback({
          panelId: "browser-panel-1",
          url: "https://example.com",
          canOpenExternal: true,
        });
        vi.advanceTimersByTime(150);
      });

      const dismissButton = container.querySelector('[aria-label="Dismiss"]');
      expect(dismissButton).not.toBeNull();

      act(() => {
        dismissButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(container.textContent).not.toContain("example.com");
    });

    it("Open in External Browser dispatches browser.openExternal with blocked URL", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const callback = getNavigationBlockedCallback();

      act(() => {
        callback({
          panelId: "browser-panel-1",
          url: "https://oauth.provider.com/auth",
          canOpenExternal: true,
        });
        vi.advanceTimersByTime(150);
      });

      const openButton = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Open in External Browser")
      );
      expect(openButton).toBeDefined();

      act(() => {
        openButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(actionDispatchMock).toHaveBeenCalledWith(
        "browser.openExternal",
        { terminalId: "browser-panel-1", url: "https://oauth.provider.com/auth" },
        { source: "user" }
      );
    });

    it("clears banner on did-navigate", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);
      const callback = getNavigationBlockedCallback();

      act(() => {
        callback({
          panelId: "browser-panel-1",
          url: "https://blocked.com",
          canOpenExternal: true,
        });
        vi.advanceTimersByTime(150);
      });

      expect(container.textContent).toContain("blocked.com");

      act(() => {
        emitWebviewEvent(webview, "did-navigate", { url: "http://localhost:5173/new" });
      });

      expect(container.textContent).not.toContain("blocked.com");
    });
  });

  describe("screenshot capture via IPC", () => {
    it("calls clipboard.writeImage with Uint8Array after dom-ready", async () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitWebviewEvent(webview, "dom-ready");
      });

      await act(async () => {
        window.dispatchEvent(
          new CustomEvent("daintree:browser-capture-screenshot", {
            detail: { id: "browser-panel-1" },
          })
        );
        await Promise.resolve();
        await Promise.resolve();
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mock = (window as any).electron.clipboard.writeImage;
      expect(mock).toHaveBeenCalledTimes(1);
      const arg = mock.mock.calls[0][0];
      expect(arg).toBeInstanceOf(Uint8Array);
    });

    it("does not call writeImage when webview is not ready", async () => {
      const { container } = render(<BrowserPane {...baseProps} initialUrl="about:blank" />);
      const webview = getWebviewElement(container);
      webview.getURL.mockReturnValue("about:blank");

      await act(async () => {
        window.dispatchEvent(
          new CustomEvent("daintree:browser-capture-screenshot", {
            detail: { id: "browser-panel-1" },
          })
        );
        await Promise.resolve();
        await Promise.resolve();
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mock = (window as any).electron.clipboard.writeImage;
      expect(mock).not.toHaveBeenCalled();
    });

    it("does not call writeImage when URL is about:blank", async () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitWebviewEvent(webview, "dom-ready");
      });

      webview.getURL.mockReturnValue("about:blank");

      await act(async () => {
        window.dispatchEvent(
          new CustomEvent("daintree:browser-capture-screenshot", {
            detail: { id: "browser-panel-1" },
          })
        );
        await Promise.resolve();
        await Promise.resolve();
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mock = (window as any).electron.clipboard.writeImage;
      expect(mock).not.toHaveBeenCalled();
    });
  });

  describe("stale URL detection on initial load", () => {
    it("shows stale URL message on ERR_CONNECTION_REFUSED during initial restored load", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitWebviewEvent(webview, "did-fail-load", {
          errorCode: -102,
          errorDescription: "ERR_CONNECTION_REFUSED",
          isMainFrame: true,
          validatedURL: "http://localhost:5173/",
        });
      });

      expect(container.textContent).toContain("The saved URL is no longer reachable");
      expect(container.textContent).toContain("server may have moved to a different port");
    });

    it("shows generic error on ERR_CONNECTION_REFUSED after user navigates", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);

      // Simulate successful first load
      act(() => {
        emitWebviewEvent(webview, "dom-ready");
      });

      // Then a subsequent connection refused
      act(() => {
        emitWebviewEvent(webview, "did-fail-load", {
          errorCode: -102,
          errorDescription: "ERR_CONNECTION_REFUSED",
          isMainFrame: true,
          validatedURL: "http://localhost:5173/other",
        });
      });

      expect(container.textContent).not.toContain("The saved URL is no longer reachable");
      expect(container.textContent).toContain("ERR_CONNECTION_REFUSED");
    });

    it("shows generic error when user types a bad URL before first success", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);

      // User navigates before any dom-ready fires
      act(() => {
        window.dispatchEvent(
          new CustomEvent("daintree:browser-navigate", {
            detail: { id: "browser-panel-1", url: "http://localhost:9999" },
          })
        );
      });

      act(() => {
        emitWebviewEvent(webview, "did-fail-load", {
          errorCode: -102,
          errorDescription: "ERR_CONNECTION_REFUSED",
          isMainFrame: true,
          validatedURL: "http://localhost:9999/",
        });
      });

      // Should show generic error since the user actively navigated
      expect(container.textContent).not.toContain("The saved URL is no longer reachable");
      expect(container.textContent).toContain("ERR_CONNECTION_REFUSED");
    });
  });
});
