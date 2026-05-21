// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserPaneProps } from "../BrowserPane";
import { BrowserPane } from "../BrowserPane";

type MockWebviewElement = HTMLElement & {
  reload: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
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
  webview.stop = vi.fn();
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

const { browserToolbarPropsSpy } = vi.hoisted(() => ({
  browserToolbarPropsSpy: vi.fn(),
}));
vi.mock("@/components/Browser/BrowserToolbar", () => ({
  BrowserToolbar: (props: Record<string, unknown>) => {
    browserToolbarPropsSpy(props);
    return <div data-testid="browser-toolbar" />;
  },
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
    initialHistory: {
      past: [],
      present: "http://localhost:5173/",
      future: [],
    },
    initialZoom: 1.35,
    isFocused: true,
    onFocus: vi.fn(),
    onClose: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).window = globalThis.window ?? {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).electron = {
      clipboard: {
        writeImage: vi.fn(() => Promise.resolve({ ok: true })),
      },
      webview: {
        setLifecycleState: vi.fn(() => Promise.resolve()),
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

  it("does not pass console-toggle props to BrowserToolbar (regression #7495)", () => {
    // The plain Browser panel must not surface the console button via the
    // shared toolbar — that wiring belongs to DevPreviewPane only.
    render(<BrowserPane {...baseProps} />);
    expect(browserToolbarPropsSpy).toHaveBeenCalled();
    const props = browserToolbarPropsSpy.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(props.onToggleConsole).toBeUndefined();
    expect(props.isConsoleOpen).toBeUndefined();
  });

  it("ignores window-dispatched console events without throwing (regression #7495)", () => {
    // The optional `onToggleConsole`/`onClearConsole` callbacks are guarded with
    // optional chaining in the action listener. Dispatching the events on a
    // plain BrowserPane must be a safe no-op.
    render(<BrowserPane {...baseProps} />);

    expect(() => {
      window.dispatchEvent(
        new CustomEvent("daintree:browser-toggle-console", {
          detail: { id: "browser-panel-1" },
        })
      );
      window.dispatchEvent(
        new CustomEvent("daintree:browser-clear-console", {
          detail: { id: "browser-panel-1" },
        })
      );
    }).not.toThrow();
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

  it("stops webview and shows timeout error after 30s when loading is stuck", () => {
    const { container } = render(<BrowserPane {...baseProps} />);
    const webview = getWebviewElement(container);

    act(() => {
      webview.setMockLoading(true);
      emitWebviewEvent(webview, "did-start-loading");
    });

    act(() => {
      vi.advanceTimersByTime(30000);
    });

    expect(webview.stop).toHaveBeenCalledTimes(1);
    expect(webview.reload).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Page Load Timed Out");
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
    expect(webview.stop).not.toHaveBeenCalled();
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
        isMainFrame: true,
        validatedURL: "http://badsite.test/",
      });
    });

    act(() => {
      vi.advanceTimersByTime(30000);
    });

    expect(webview.reload).not.toHaveBeenCalled();
    expect(webview.stop).not.toHaveBeenCalled();
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
    expect(webview.stop).not.toHaveBeenCalled();
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
      expect(container.textContent).toContain("Open in external browser");
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

      const dismissButton = container.querySelector('[aria-label="Dismiss navigation notice"]');
      expect(dismissButton).not.toBeNull();

      act(() => {
        dismissButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(container.textContent).not.toContain("example.com");
    });

    it("Open in external browser dispatches browser.openExternal with blocked URL", () => {
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
        b.textContent?.includes("Open in external browser")
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

  describe("slow-load and timeout escalation", () => {
    it("shows slow-load message and Cancel after 5s of loading", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        webview.setMockLoading(true);
        emitWebviewEvent(webview, "did-start-loading");
      });

      // Before 5s, only spinner (no slow-load text)
      expect(container.textContent).not.toContain("Taking longer than usual");

      act(() => {
        vi.advanceTimersByTime(5000);
      });

      expect(container.textContent).toContain("Taking longer than usual");
      expect(container.textContent).toContain("Cancel");
    });

    it("Cancel stops the webview and shows cancelled error", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        webview.setMockLoading(true);
        emitWebviewEvent(webview, "did-start-loading");
      });

      act(() => {
        vi.advanceTimersByTime(5000);
      });

      const cancelButton = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Cancel")
      );
      expect(cancelButton).toBeDefined();

      act(() => {
        cancelButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(webview.stop).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain("Load cancelled");
      expect(container.textContent).toContain("Retry");
    });

    it("timeout calls webview.stop() instead of reload", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        webview.setMockLoading(true);
        emitWebviewEvent(webview, "did-start-loading");
      });

      act(() => {
        vi.advanceTimersByTime(30000);
      });

      expect(webview.stop).toHaveBeenCalledTimes(1);
      expect(webview.reload).not.toHaveBeenCalled();
      expect(container.textContent).toContain("Page Load Timed Out");
    });

    it("timeout error overlay shows Retry and Open External buttons", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        webview.setMockLoading(true);
        emitWebviewEvent(webview, "did-start-loading");
      });

      act(() => {
        vi.advanceTimersByTime(30000);
      });

      expect(container.textContent).toContain("Retry");
      expect(container.textContent).toContain("Open in external browser");
    });

    it("Retry from timeout clears error and loads current URL", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        webview.setMockLoading(true);
        emitWebviewEvent(webview, "did-start-loading");
      });

      act(() => {
        vi.advanceTimersByTime(30000);
      });

      webview.stop.mockClear();

      const retryButton = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Retry")
      );
      expect(retryButton).toBeDefined();

      act(() => {
        retryButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(webview.loadURL).toHaveBeenCalledWith("http://localhost:5173/");
    });

    it("clears slow timer on did-stop-loading", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        webview.setMockLoading(true);
        emitWebviewEvent(webview, "did-start-loading");
      });

      act(() => {
        webview.setMockLoading(false);
        emitWebviewEvent(webview, "did-stop-loading");
      });

      act(() => {
        vi.advanceTimersByTime(5000);
      });

      expect(container.textContent).not.toContain("Taking longer than usual");
    });

    it("clears slow timer on did-fail-load", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        webview.setMockLoading(true);
        emitWebviewEvent(webview, "did-start-loading");
      });

      act(() => {
        emitWebviewEvent(webview, "did-fail-load", {
          errorCode: -105,
          errorDescription: "Name not resolved",
          isMainFrame: true,
          validatedURL: "http://badsite.test/",
        });
      });

      act(() => {
        vi.advanceTimersByTime(5000);
      });

      expect(container.textContent).not.toContain("Taking longer than usual");
    });

    it("shows DNS failure message with hostname for -105", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitWebviewEvent(webview, "did-fail-load", {
          errorCode: -105,
          errorDescription: "ERR_NAME_NOT_RESOLVED",
          isMainFrame: true,
          validatedURL: "http://nonexistent.example.com/page",
        });
      });

      expect(container.textContent).toContain("Couldn't resolve");
      expect(container.textContent).toContain("nonexistent.example.com");
    });

    it("shows no-internet message for -106", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitWebviewEvent(webview, "did-fail-load", {
          errorCode: -106,
          errorDescription: "ERR_INTERNET_DISCONNECTED",
          isMainFrame: true,
          validatedURL: "http://localhost:5173/",
        });
      });

      expect(container.textContent).toContain("No internet connection");
    });

    it("shows certificate error overlay for ERR_CERT_AUTHORITY_INVALID (-202)", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitWebviewEvent(webview, "did-fail-load", {
          errorCode: -202,
          errorDescription: "ERR_CERT_AUTHORITY_INVALID",
          isMainFrame: true,
          validatedURL: "https://localhost:8443/",
        });
      });

      expect(container.textContent).toContain("Certificate Error");
      expect(container.textContent).toContain("certificate couldn't be verified");
      expect(container.textContent).toContain("mkcert -install");
    });

    it("shows SSL/TLS handshake message for ERR_SSL_PROTOCOL_ERROR (-107)", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitWebviewEvent(webview, "did-fail-load", {
          errorCode: -107,
          errorDescription: "ERR_SSL_PROTOCOL_ERROR",
          isMainFrame: true,
          validatedURL: "https://localhost:8443/",
        });
      });

      expect(container.textContent).toContain("Certificate Error");
      expect(container.textContent).toContain("SSL/TLS handshake failed");
      // -107 is also raised on protocol mismatch — the mkcert hint is wrong here.
      expect(container.textContent).not.toContain("mkcert");
    });

    it("surfaces ERR_FILE_NOT_FOUND (-6) instead of silently swallowing it", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitWebviewEvent(webview, "did-fail-load", {
          errorCode: -6,
          errorDescription: "ERR_FILE_NOT_FOUND",
          isMainFrame: true,
          validatedURL: "http://localhost:5173/missing",
        });
      });

      expect(container.textContent).toContain("Unable to Display Page");
      expect(container.textContent).toContain("ERR_FILE_NOT_FOUND");
    });

    it("ignores sub-frame failures", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitWebviewEvent(webview, "did-fail-load", {
          errorCode: -105,
          errorDescription: "ERR_NAME_NOT_RESOLVED",
          isMainFrame: false,
          validatedURL: "http://tracker.example.test/pixel.gif",
        });
      });

      expect(container.textContent).not.toContain("Unable to Display Page");
      expect(container.textContent).not.toContain("Couldn't resolve");
    });

    it("does not disarm main-frame timeout when a sub-frame fails", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        webview.setMockLoading(true);
        emitWebviewEvent(webview, "did-start-loading");
      });

      // Sub-frame (e.g. tracker pixel) fails mid-load — must not clear the main-frame timer.
      act(() => {
        emitWebviewEvent(webview, "did-fail-load", {
          errorCode: -105,
          errorDescription: "ERR_NAME_NOT_RESOLVED",
          isMainFrame: false,
          validatedURL: "http://tracker.example.test/pixel.gif",
        });
      });

      act(() => {
        vi.advanceTimersByTime(30000);
      });

      expect(webview.stop).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain("Page Load Timed Out");
    });

    it("stale ERR_ABORTED from a superseded navigation does not disarm new timers", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);

      // First navigation starts and arms timers.
      act(() => {
        webview.setMockLoading(true);
        emitWebviewEvent(webview, "did-start-loading");
      });

      // Second navigation supersedes the first — fresh timers armed.
      act(() => {
        emitWebviewEvent(webview, "did-start-loading");
      });

      // The first navigation's superseded did-fail-load (ERR_ABORTED, -3) arrives late.
      act(() => {
        emitWebviewEvent(webview, "did-fail-load", {
          errorCode: -3,
          errorDescription: "ERR_ABORTED",
          isMainFrame: true,
          validatedURL: "http://localhost:5173/old",
        });
      });

      act(() => {
        vi.advanceTimersByTime(30000);
      });

      expect(webview.stop).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain("Page Load Timed Out");
    });

    it("shows connection-timeout message when validatedURL is empty", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitWebviewEvent(webview, "did-fail-load", {
          errorCode: -118,
          errorDescription: "ERR_CONNECTION_TIMED_OUT",
          isMainFrame: true,
          validatedURL: "",
        });
      });

      expect(container.textContent).toContain("Connection Failed");
      expect(container.textContent).toContain("timed out");
      expect(container.textContent).not.toContain("Unable to Display Page");
    });

    it("cleans slow timer on unmount", () => {
      const { container, unmount } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        webview.setMockLoading(true);
        emitWebviewEvent(webview, "did-start-loading");
      });

      unmount();

      act(() => {
        vi.advanceTimersByTime(5000);
      });

      // No error — timer was cleaned up
      expect(container.textContent).not.toContain("Taking longer than usual");
    });
  });

  describe("accessibility markers", () => {
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

    it("blocked-navigation banner has polite live region and distinct dismiss label", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const callback = getNavigationBlockedCallback();

      act(() => {
        callback({
          panelId: "browser-panel-1",
          url: "https://oauth.example.com/auth",
          canOpenExternal: true,
        });
        vi.advanceTimersByTime(150);
      });

      const banner = container.querySelector('[aria-live="polite"]');
      expect(banner).not.toBeNull();
      expect(banner?.getAttribute("aria-atomic")).toBe("true");
      expect(banner?.textContent).toContain("oauth.example.com");

      const dismiss = container.querySelector('[aria-label="Dismiss navigation notice"]');
      expect(dismiss).not.toBeNull();
      expect(container.querySelector('[aria-label="Dismiss"]')).toBeNull();
    });

    it("load-error overlay has role=alert", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitWebviewEvent(webview, "did-fail-load", {
          errorCode: -105,
          errorDescription: "Name not resolved",
          isMainFrame: true,
          validatedURL: "http://nonexistent.example.com/",
        });
      });

      const alert = container.querySelector('[role="alert"]');
      expect(alert).not.toBeNull();
      expect(alert?.textContent).toContain("Couldn't resolve");
    });
  });
});
