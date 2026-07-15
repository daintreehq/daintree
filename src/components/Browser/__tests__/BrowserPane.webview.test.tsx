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
  canGoBack: ReturnType<typeof vi.fn>;
  canGoForward: ReturnType<typeof vi.fn>;
  goBack: ReturnType<typeof vi.fn>;
  goForward: ReturnType<typeof vi.fn>;
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
  // Default to no navigable history; tests override via mockReturnValue.
  webview.canGoBack = vi.fn(() => false);
  webview.canGoForward = vi.fn(() => false);
  webview.goBack = vi.fn();
  webview.goForward = vi.fn();
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
  const projectStoreState: { currentProject: { id: string } | null } = {
    currentProject: { id: "test-project" },
  };
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

const { browserToolbarPropsSpy, contentPanelPropsSpy } = vi.hoisted(() => ({
  browserToolbarPropsSpy: vi.fn(),
  contentPanelPropsSpy: vi.fn(),
}));
vi.mock("@/components/Browser/BrowserToolbar", () => ({
  BrowserToolbar: (props: Record<string, unknown>) => {
    browserToolbarPropsSpy(props);
    return <div data-testid="browser-toolbar" />;
  },
}));

const { notifyMock } = vi.hoisted(() => ({
  notifyMock: vi.fn(),
}));
vi.mock("@/lib/notify", () => ({
  notify: notifyMock,
}));

vi.mock("@/components/Panel", () => ({
  ContentPanel: (props: {
    children: React.ReactNode;
    toolbar?: React.ReactNode;
    [key: string]: unknown;
  }) => {
    contentPanelPropsSpy(props);
    return (
      <div data-testid="content-panel">
        {props.toolbar}
        {props.children}
      </div>
    );
  },
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
    // dispatch() resolves an ActionDispatchResult union and never rejects;
    // callers branch on `.ok`, so the mock must honour that shape.
    actionDispatchMock.mockResolvedValue({ ok: true, result: undefined });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).window = globalThis.window ?? {};
    // InlineStatusBanner reads window.matchMedia at render time; jsdom does
    // not implement it, so provide a no-op stub.
    if (typeof window.matchMedia !== "function") {
      Object.defineProperty(window, "matchMedia", {
        writable: true,
        configurable: true,
        value: vi.fn().mockImplementation((query: string) => ({
          matches: false,
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        })),
      });
    }
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
        onUnresponsive: vi.fn(() => vi.fn()),
        onResponsive: vi.fn(() => vi.fn()),
        onCloseShortcut: vi.fn(() => vi.fn()),
        getNavigationHistory: vi.fn(() =>
          Promise.resolve({ entries: [], activeIndex: 0, canGoBack: false, canGoForward: false })
        ),
        goToHistoryIndex: vi.fn(() => Promise.resolve()),
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

  it("forwards the single-panel dock restore control", () => {
    render(<BrowserPane {...baseProps} location="dock" showRestoreControl />);

    expect(contentPanelPropsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ showRestoreControl: true })
    );
  });

  describe("per-project session partition (#9965)", () => {
    const restoreProjectMock = () =>
      useProjectStoreMock.mockImplementation((selector) =>
        selector({ currentProject: { id: "test-project" } })
      );

    afterEach(() => {
      restoreProjectMock();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (window as any).__DAINTREE_INITIAL_PROJECT__;
    });

    it("scopes the webview partition to the current project", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);
      expect(webview.getAttribute("partition")).toBe("persist:browser-test-project");
    });

    it("falls back to the synchronously-seeded project id when the store has not resolved", () => {
      useProjectStoreMock.mockImplementation((selector) => selector({ currentProject: null }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__DAINTREE_INITIAL_PROJECT__ = { id: "seeded-project" };

      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);
      // Must NOT attach with the shared default partition — that would leak the
      // session across projects, which is the bug this fix closes.
      expect(webview.getAttribute("partition")).toBe("persist:browser-seeded-project");
    });

    it("uses the default partition only when no project id is available at all", () => {
      useProjectStoreMock.mockImplementation((selector) => selector({ currentProject: null }));

      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);
      expect(webview.getAttribute("partition")).toBe("persist:browser-default");
    });
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
    expect(container.textContent).toContain("Page load timed out");
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

  it("exposes the loading overlay to screen readers via role=status (#9964)", () => {
    const { container, getByRole } = render(<BrowserPane {...baseProps} />);
    const webview = getWebviewElement(container);

    act(() => {
      webview.setMockLoading(true);
      emitWebviewEvent(webview, "did-start-loading");
    });

    // The overlay is Doherty-gated — it only mounts after the 400ms threshold.
    act(() => {
      vi.advanceTimersByTime(401);
    });

    const status = getByRole("status");
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(status.getAttribute("aria-label")).toBe("Loading…");
    expect(status.textContent).toContain("Loading…");
  });

  it("announces the slow-load escalation via a polite live region (#9964)", () => {
    // aria-busy on the status wrapper suppresses inner live regions, so the
    // escalation must flow through the sibling aria-live span.
    const { container } = render(<BrowserPane {...baseProps} />);
    const webview = getWebviewElement(container);

    act(() => {
      webview.setMockLoading(true);
      emitWebviewEvent(webview, "did-start-loading");
    });

    act(() => {
      vi.advanceTimersByTime(401);
    });

    const liveRegion = container.querySelector('[aria-live="polite"]');
    expect(liveRegion).not.toBeNull();
    expect(liveRegion?.textContent).toBe("");

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(liveRegion?.textContent).toContain("taking longer than usual");
  });

  it("removes the loading status region after did-stop-loading (#9964)", () => {
    const { container, queryByRole } = render(<BrowserPane {...baseProps} />);
    const webview = getWebviewElement(container);

    act(() => {
      webview.setMockLoading(true);
      emitWebviewEvent(webview, "did-start-loading");
    });
    act(() => {
      vi.advanceTimersByTime(401);
    });
    expect(queryByRole("status")).not.toBeNull();

    act(() => {
      webview.setMockLoading(false);
      emitWebviewEvent(webview, "did-stop-loading");
    });
    act(() => {
      vi.advanceTimersByTime(401);
    });

    expect(queryByRole("status")).toBeNull();
  });

  describe("back/forward navigation guard (#9942)", () => {
    function getLoadingOverlay(container: HTMLElement): Element | null {
      return container.querySelector(".bg-daintree-bg.z-10");
    }

    function settleLoaded(webview: MockWebviewElement) {
      // dom-ready arms isWebviewReady; did-stop-loading clears the initial
      // isLoading so the Doherty overlay isn't already showing.
      act(() => {
        emitWebviewEvent(webview, "dom-ready");
        webview.setMockLoading(false);
        emitWebviewEvent(webview, "did-stop-loading");
      });
    }

    it("does not enter a stuck loading state when back is pressed with no history", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);
      settleLoaded(webview);
      webview.canGoBack.mockReturnValue(false);

      act(() => {
        window.dispatchEvent(
          new CustomEvent("daintree:browser-back", { detail: { id: "browser-panel-1" } })
        );
      });
      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(webview.goBack).not.toHaveBeenCalled();
      // No navigation fired, so no load event would ever clear the spinner —
      // the overlay must never appear in the first place.
      expect(getLoadingOverlay(container)).toBeNull();
    });

    it("does not enter a stuck loading state when forward is pressed with no history", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);
      settleLoaded(webview);
      webview.canGoForward.mockReturnValue(false);

      act(() => {
        window.dispatchEvent(
          new CustomEvent("daintree:browser-forward", { detail: { id: "browser-panel-1" } })
        );
      });
      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(webview.goForward).not.toHaveBeenCalled();
      expect(getLoadingOverlay(container)).toBeNull();
    });

    it("navigates and shows the loading overlay when back is possible", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);
      settleLoaded(webview);
      webview.canGoBack.mockReturnValue(true);

      act(() => {
        window.dispatchEvent(
          new CustomEvent("daintree:browser-back", { detail: { id: "browser-panel-1" } })
        );
      });
      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(webview.goBack).toHaveBeenCalledTimes(1);
      expect(getLoadingOverlay(container)).not.toBeNull();
    });

    it("falls back to app history when native back history is unavailable after address navigation", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);
      settleLoaded(webview);
      webview.canGoBack.mockReturnValue(false);

      act(() => {
        window.dispatchEvent(
          new CustomEvent("daintree:browser-navigate", {
            detail: { id: "browser-panel-1", url: "http://localhost:5173/page-a" },
          })
        );
      });

      let toolbarProps = browserToolbarPropsSpy.mock.calls.at(-1)![0] as Record<string, unknown>;
      expect(toolbarProps.canGoBack).toBe(true);

      act(() => {
        window.dispatchEvent(
          new CustomEvent("daintree:browser-back", { detail: { id: "browser-panel-1" } })
        );
      });

      expect(webview.goBack).not.toHaveBeenCalled();
      expect(webview.loadURL).toHaveBeenLastCalledWith("http://localhost:5173/");
      toolbarProps = browserToolbarPropsSpy.mock.calls.at(-1)![0] as Record<string, unknown>;
      expect(toolbarProps.canGoForward).toBe(true);
    });

    it("navigates and shows the loading overlay when forward is possible", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);
      settleLoaded(webview);
      webview.canGoForward.mockReturnValue(true);

      act(() => {
        window.dispatchEvent(
          new CustomEvent("daintree:browser-forward", { detail: { id: "browser-panel-1" } })
        );
      });
      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(webview.goForward).toHaveBeenCalledTimes(1);
      expect(getLoadingOverlay(container)).not.toBeNull();
    });

    it("does not dismiss the blocked-navigation banner when back is a no-op", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);
      settleLoaded(webview);
      webview.canGoBack.mockReturnValue(false);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const onBlocked = (window as any).electron.webview.onNavigationBlocked.mock.calls.at(-1)![0];
      act(() => {
        onBlocked({
          panelId: "browser-panel-1",
          url: "https://oauth.example.com/authorize",
          canOpenExternal: true,
        });
        vi.advanceTimersByTime(150);
      });
      expect(container.textContent).toContain("oauth.example.com");

      act(() => {
        window.dispatchEvent(
          new CustomEvent("daintree:browser-back", { detail: { id: "browser-panel-1" } })
        );
      });

      // A no-op Back must not clear the banner — setBlockedNav(null) is gated.
      expect(webview.goBack).not.toHaveBeenCalled();
      expect(container.textContent).toContain("oauth.example.com");
    });
  });

  describe("history dropdown navigation (#9942)", () => {
    // The mock webview reports an already-loaded URL at mount, so BrowserPane
    // settles isWebviewReady/!isLoading immediately and fires its history-refresh
    // effect once. Stub getNavigationHistory BEFORE render so that mount-time
    // refresh captures the snapshot, then flush the async chain.
    async function renderWithSnapshot(snapshot: {
      entries: Array<{ index: number; url: string; title: string }>;
      activeIndex: number;
      canGoBack: boolean;
      canGoForward: boolean;
    }) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).electron.webview.getNavigationHistory.mockImplementation(() =>
        Promise.resolve(snapshot)
      );
      let result!: ReturnType<typeof render>;
      await act(async () => {
        result = render(<BrowserPane {...baseProps} />);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      return result;
    }

    function getOnGoToHistoryIndex(): (index: number) => Promise<void> {
      const props = browserToolbarPropsSpy.mock.calls.at(-1)![0] as Record<string, unknown>;
      return props.onGoToHistoryIndex as (index: number) => Promise<void>;
    }

    it("resolves the entry by its Chromium index field, not array position", async () => {
      // Sparse history: entries filtered upstream keep their original Chromium
      // .index (0,3,6). Positional lookup of index 3 would read entries[3]
      // (undefined) and no-op; find-by-field must resolve entries[1].
      await renderWithSnapshot({
        entries: [
          { index: 0, url: "http://localhost:5173/a", title: "A" },
          { index: 3, url: "http://localhost:5173/b", title: "B" },
          { index: 6, url: "http://localhost:5173/c", title: "C" },
        ],
        activeIndex: 6,
        canGoBack: true,
        canGoForward: false,
      });

      const goTo = getOnGoToHistoryIndex();
      await act(async () => {
        await goTo(3);
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const goToHistoryIndex = (window as any).electron.webview.goToHistoryIndex;
      expect(goToHistoryIndex).toHaveBeenCalledWith(42, 3);
    });

    it("does not navigate to a history entry whose URL fails normalization", async () => {
      const { container } = await renderWithSnapshot({
        entries: [
          { index: 0, url: "http://localhost:5173/a", title: "A" },
          { index: 1, url: "chrome://settings", title: "Settings" },
        ],
        activeIndex: 0,
        canGoBack: false,
        canGoForward: true,
      });

      const goTo = getOnGoToHistoryIndex();
      await act(async () => {
        await goTo(1);
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const goToHistoryIndex = (window as any).electron.webview.goToHistoryIndex;
      expect(goToHistoryIndex).not.toHaveBeenCalled();
      expect(container.textContent).not.toContain("Allow");
    });

    it("requires host approval before navigating to an unapproved history entry", async () => {
      const { container } = await renderWithSnapshot({
        entries: [
          { index: 0, url: "http://localhost:5173/a", title: "A" },
          { index: 1, url: "https://example.com/page", title: "Example" },
        ],
        activeIndex: 0,
        canGoBack: false,
        canGoForward: true,
      });

      const goTo = getOnGoToHistoryIndex();
      await act(async () => {
        await goTo(1);
      });

      // Unapproved host: surface the approval prompt, do not navigate yet.
      expect(container.textContent).toContain("example.com");
      expect(container.textContent).toContain("Allow browser panel to load");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const goToHistoryIndex = (window as any).electron.webview.goToHistoryIndex;
      expect(goToHistoryIndex).not.toHaveBeenCalled();
    });
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

    // #11114: dispatch() resolves {ok:false} rather than rejecting, so the old
    // handler cleared the notice unconditionally — destroying the user's only
    // route to the blocked URL whenever the external open actually failed.
    describe("failed external open (#11114)", () => {
      const OPEN_FAILED = {
        ok: false,
        error: { code: "EXECUTION_ERROR", message: "xdg-open exited with code 3" },
      };

      function blockNavigation(container: HTMLElement, url: string) {
        const callback = getNavigationBlockedCallback();
        act(() => {
          callback({ panelId: "browser-panel-1", url, canOpenExternal: true });
          vi.advanceTimersByTime(150);
        });
        return container;
      }

      function findButton(container: HTMLElement, text: string) {
        return Array.from(container.querySelectorAll("button")).find((b) =>
          b.textContent?.includes(text)
        );
      }

      // Deferred on purpose: the old code cleared the notice synchronously, so a
      // test that only checks the end state would pass on the pre-fix build. The
      // load-bearing assertion is that the notice SURVIVES until the result lands.
      it("holds the notice open until the external open resolves, then clears it", async () => {
        let resolveOpen: (value: unknown) => void = () => {};
        actionDispatchMock.mockReturnValue(
          new Promise((resolve) => {
            resolveOpen = resolve;
          })
        );
        const { container } = render(<BrowserPane {...baseProps} />);
        blockNavigation(container, "https://oauth.provider.com/auth");

        act(() => {
          findButton(container, "Open in external browser")!.dispatchEvent(
            new MouseEvent("click", { bubbles: true })
          );
        });

        // Still pending: the notice must not be torn down before we know the outcome.
        expect(container.textContent).toContain("oauth.provider.com");
        expect(findButton(container, "Opening…")?.hasAttribute("disabled")).toBe(true);

        await act(async () => {
          resolveOpen({ ok: true, result: undefined });
        });

        expect(container.textContent).not.toContain("oauth.provider.com");
      });

      it("keeps the notice and surfaces the reason when the external open fails", async () => {
        actionDispatchMock.mockResolvedValue(OPEN_FAILED);
        const { container } = render(<BrowserPane {...baseProps} />);
        blockNavigation(container, "https://oauth.provider.com/auth");

        await act(async () => {
          findButton(container, "Open in external browser")!.dispatchEvent(
            new MouseEvent("click", { bubbles: true })
          );
        });

        // The failure reason reaches the user, the blocked host is still named,
        // and the recovery route survives.
        expect(container.textContent).toContain(OPEN_FAILED.error.message);
        expect(container.textContent).toContain("oauth.provider.com");
        expect(findButton(container, "Retry")).toBeDefined();
        // Tier 3 is pane-local: no redundant global toast.
        expect(notifyMock).not.toHaveBeenCalled();
      });

      it("does not auto-dismiss a failed notice after the 10s blocked-notice timeout", async () => {
        actionDispatchMock.mockResolvedValue(OPEN_FAILED);
        const { container } = render(<BrowserPane {...baseProps} />);
        blockNavigation(container, "https://oauth.provider.com/auth");

        await act(async () => {
          findButton(container, "Open in external browser")!.dispatchEvent(
            new MouseEvent("click", { bubbles: true })
          );
        });

        act(() => {
          vi.advanceTimersByTime(20_000);
        });

        // The auto-dismiss timer only owns the untouched notice — otherwise the
        // error banner would silently delete itself and take the recovery with it.
        expect(container.textContent).toContain(OPEN_FAILED.error.message);
        expect(findButton(container, "Retry")).toBeDefined();
      });

      // The auto-dismiss timer is armed while the notice is "blocked". Its callback
      // can still be picked up by the event loop after the user clicks — cleanup
      // can't cancel a callback already in flight — so the callback itself has to
      // re-check ownership. Otherwise it nulls the notice mid-attempt and the
      // failure below has nothing left to attach to.
      it("does not let a queued auto-dismiss timer destroy a notice that is mid-attempt", async () => {
        let resolveOpen: (value: unknown) => void = () => {};
        actionDispatchMock.mockReturnValue(
          new Promise((resolve) => {
            resolveOpen = resolve;
          })
        );
        const { container } = render(<BrowserPane {...baseProps} />);
        blockNavigation(container, "https://oauth.provider.com/auth");

        act(() => {
          findButton(container, "Open in external browser")!.dispatchEvent(
            new MouseEvent("click", { bubbles: true })
          );
          // Fires the timer armed by the "blocked" render, in the same batch.
          vi.advanceTimersByTime(10_000);
        });

        await act(async () => {
          resolveOpen(OPEN_FAILED);
        });

        expect(container.textContent).toContain(OPEN_FAILED.error.message);
        expect(findButton(container, "Retry")).toBeDefined();
      });

      it("retries the same URL from the error banner and clears the notice once it succeeds", async () => {
        actionDispatchMock.mockResolvedValue(OPEN_FAILED);
        const { container } = render(<BrowserPane {...baseProps} />);
        blockNavigation(container, "https://oauth.provider.com/auth");

        await act(async () => {
          findButton(container, "Open in external browser")!.dispatchEvent(
            new MouseEvent("click", { bubbles: true })
          );
        });

        actionDispatchMock.mockResolvedValue({ ok: true, result: undefined });
        await act(async () => {
          findButton(container, "Retry")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });

        expect(actionDispatchMock).toHaveBeenLastCalledWith(
          "browser.openExternal",
          { terminalId: "browser-panel-1", url: "https://oauth.provider.com/auth" },
          { source: "user" }
        );
        expect(container.textContent).not.toContain("oauth.provider.com");
      });

      it("does not let a superseded notice's failure overwrite a newer blocked navigation", async () => {
        let resolveOpen: (value: unknown) => void = () => {};
        actionDispatchMock.mockReturnValue(
          new Promise((resolve) => {
            resolveOpen = resolve;
          })
        );
        const { container } = render(<BrowserPane {...baseProps} />);
        blockNavigation(container, "https://first.com/auth");

        act(() => {
          findButton(container, "Open in external browser")!.dispatchEvent(
            new MouseEvent("click", { bubbles: true })
          );
        });

        // The first notice is still alive and mid-attempt (the old code had
        // already destroyed it here, which is what made its result harmless).
        expect(container.textContent).toContain("first.com");

        // A second navigation is blocked while the first open is still in flight.
        blockNavigation(container, "https://second.com/auth");

        await act(async () => {
          resolveOpen(OPEN_FAILED);
        });

        // The stale failure belongs to first.com's notice, which no longer exists.
        expect(container.textContent).toContain("second.com");
        expect(container.textContent).not.toContain(OPEN_FAILED.error.message);
      });
    });

    it("closes this panel when onCloseShortcut fires for it, and ignores other panels (#10859)", () => {
      render(<BrowserPane {...baseProps} />);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mock = (window as any).electron.webview.onCloseShortcut;
      const closeCb = mock.mock.calls[mock.mock.calls.length - 1][0] as (payload: {
        panelId: string;
      }) => void;

      // A shortcut targeting a different panel must not close this one
      act(() => {
        closeCb({ panelId: "some-other-panel" });
      });
      expect(actionDispatchMock).not.toHaveBeenCalledWith(
        "terminal.close",
        expect.anything(),
        expect.anything()
      );

      // A shortcut targeting this panel closes exactly this panel by id
      act(() => {
        closeCb({ panelId: "browser-panel-1" });
      });
      expect(actionDispatchMock).toHaveBeenCalledWith(
        "terminal.close",
        { terminalId: "browser-panel-1" },
        { source: "keybinding" }
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

    it("surfaces an error notification when the clipboard write fails", async () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitWebviewEvent(webview, "dom-ready");
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).electron.clipboard.writeImage.mockRejectedValueOnce(
        new Error("clipboard unavailable")
      );

      await act(async () => {
        window.dispatchEvent(
          new CustomEvent("daintree:browser-capture-screenshot", {
            detail: { id: "browser-panel-1" },
          })
        );
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(notifyMock).toHaveBeenCalledTimes(1);
      expect(notifyMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error", title: "Screenshot failed" })
      );
    });
  });

  describe("screenshot capture via toolbar prop", () => {
    const getToolbarCapture = () => {
      const props = browserToolbarPropsSpy.mock.calls.at(-1)?.[0] as {
        onCaptureScreenshot: () => Promise<boolean>;
      };
      return props.onCaptureScreenshot;
    };

    it("resolves true after a successful capture and clipboard write", async () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitWebviewEvent(webview, "dom-ready");
      });

      let result: boolean | undefined;
      await act(async () => {
        result = await getToolbarCapture()();
      });

      expect(result).toBe(true);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((window as any).electron.clipboard.writeImage).toHaveBeenCalledTimes(1);
    });

    it("resolves false and notifies when the clipboard write fails", async () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitWebviewEvent(webview, "dom-ready");
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).electron.clipboard.writeImage.mockRejectedValueOnce(
        new Error("clipboard unavailable")
      );

      let result: boolean | undefined;
      await act(async () => {
        result = await getToolbarCapture()();
      });

      expect(result).toBe(false);
      expect(notifyMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error", title: "Screenshot failed" })
      );
    });

    it("resolves false without notifying when the URL is about:blank", async () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitWebviewEvent(webview, "dom-ready");
      });

      webview.getURL.mockReturnValue("about:blank");

      let result: boolean | undefined;
      await act(async () => {
        result = await getToolbarCapture()();
      });

      expect(result).toBe(false);
      expect(notifyMock).not.toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((window as any).electron.clipboard.writeImage).not.toHaveBeenCalled();
    });

    it("resolves false and notifies when capturePage rejects", async () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitWebviewEvent(webview, "dom-ready");
      });

      webview.capturePage.mockRejectedValueOnce(new Error("capture failed"));

      let result: boolean | undefined;
      await act(async () => {
        result = await getToolbarCapture()();
      });

      expect(result).toBe(false);
      expect(notifyMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error", title: "Screenshot failed" })
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((window as any).electron.clipboard.writeImage).not.toHaveBeenCalled();
    });

    it("resolves false for a second capture while the first is still in flight", async () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitWebviewEvent(webview, "dom-ready");
      });

      let resolveCapture: (value: { toPNG: () => Uint8Array }) => void;
      webview.capturePage.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveCapture = resolve;
        })
      );

      let first: Promise<boolean>;
      let second: boolean | undefined;
      await act(async () => {
        first = getToolbarCapture()();
        second = await getToolbarCapture()();
        resolveCapture!({ toPNG: () => new Uint8Array([0x89]) });
        await first;
      });

      expect(second).toBe(false);
      await expect(first!).resolves.toBe(true);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((window as any).electron.clipboard.writeImage).toHaveBeenCalledTimes(1);
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
      expect(container.textContent).toContain("Page load timed out");
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

      expect(container.textContent).toContain("Certificate error");
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

      expect(container.textContent).toContain("Certificate error");
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

      expect(container.textContent).toContain("Unable to display page");
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

      expect(container.textContent).not.toContain("Unable to display page");
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
      expect(container.textContent).toContain("Page load timed out");
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
      expect(container.textContent).toContain("Page load timed out");
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

      expect(container.textContent).toContain("Connection failed");
      expect(container.textContent).toContain("timed out");
      expect(container.textContent).not.toContain("Unable to display page");
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

  describe("crash and unresponsive recovery (#9212)", () => {
    function emitRenderProcessGone(
      webview: MockWebviewElement,
      reason: string,
      exitCode = 1
    ): void {
      emitWebviewEvent(webview, "render-process-gone", {
        details: { reason, exitCode },
      });
    }

    function getUnresponsiveCallback(): (payload: { panelId: string }) => void {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mock = (window as any).electron.webview.onUnresponsive;
      const lastCall = mock.mock.calls[mock.mock.calls.length - 1];
      return lastCall[0];
    }

    function getResponsiveCallback(): (payload: { panelId: string }) => void {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mock = (window as any).electron.webview.onResponsive;
      const lastCall = mock.mock.calls[mock.mock.calls.length - 1];
      return lastCall[0];
    }

    it("auto-reloads silently on the first crash within 60s and surfaces the banner", () => {
      // The auto-reload runs in the background to recover from a one-off crash,
      // and the banner stays up so the user has explicit recovery if the reload
      // does not succeed. A second crash within the window stops auto-reloading
      // (see next test) to avoid a reload loop.
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitRenderProcessGone(webview, "crashed");
      });

      expect(webview.reload).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain("Page process crashed");
    });

    it("does not auto-reload on a second crash within the 60s window", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitRenderProcessGone(webview, "crashed");
      });
      act(() => {
        emitRenderProcessGone(webview, "oom", 9);
      });

      expect(webview.reload).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain("Page process crashed");
      expect(container.textContent).toContain("Reason: oom (exit code 9)");
    });

    it("does not emit a durable notification on the first crash (#9964)", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitRenderProcessGone(webview, "crashed");
      });

      expect(notifyMock).not.toHaveBeenCalled();
    });

    it("emits a durable high-priority notification on the second crash within 60s (#9964)", () => {
      // A crash loop in a background pane is otherwise silent — the in-flow
      // banner is only visible when the pane is. Mirrors DevPreviewPane.
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitRenderProcessGone(webview, "crashed");
      });
      act(() => {
        emitRenderProcessGone(webview, "oom", 9);
      });

      expect(notifyMock).toHaveBeenCalledTimes(1);
      expect(notifyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          title: "Page crashed repeatedly",
          message: expect.stringContaining("oom"),
          priority: "high",
          duration: 0,
          supersedeKey: "browser-pane-crash-loop:browser-panel-1",
          correlationId: "browser-panel-1",
          context: expect.objectContaining({
            eventKind: "recovery",
            panelId: "browser-panel-1",
          }),
        })
      );
    });

    it("surfaces the banner on OS-pressure memory-eviction (no Daintree eviction in flight)", () => {
      // Chromium reports `memory-eviction` for two distinct paths:
      //   (1) Daintree's own about:blank src swap from useWebviewEviction
      //       (gated by evictingRef.current and handled by the eviction
      //       placeholder).
      //   (2) The OS killing the renderer under system memory pressure on a
      //       visible panel. In path (2) evictingRef stays false and the
      //       eviction placeholder never renders — the pane would go blank
      //       silently without a crash banner. #9212.
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitRenderProcessGone(webview, "memory-eviction");
      });

      expect(webview.reload).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain("Page process crashed");
    });

    it("ignores clean-exit reason — intentional renderer shutdown", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitRenderProcessGone(webview, "clean-exit", 0);
        emitRenderProcessGone(webview, "clean-exit", 0);
      });

      expect(webview.reload).not.toHaveBeenCalled();
      expect(container.textContent).not.toContain("Page process crashed");
    });

    it("shows the unresponsive banner when WEBVIEW_UNRESPONSIVE fires for this panel", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const onUnresponsive = getUnresponsiveCallback();

      act(() => {
        onUnresponsive({ panelId: "browser-panel-1" });
      });

      expect(container.textContent).toContain("Page not responding");
    });

    it("ignores WEBVIEW_UNRESPONSIVE for a different panel", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const onUnresponsive = getUnresponsiveCallback();

      act(() => {
        onUnresponsive({ panelId: "some-other-panel" });
      });

      expect(container.textContent).not.toContain("Page not responding");
    });

    it("auto-clears the unresponsive banner when WEBVIEW_RESPONSIVE fires", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const onUnresponsive = getUnresponsiveCallback();
      const onResponsive = getResponsiveCallback();

      act(() => {
        onUnresponsive({ panelId: "browser-panel-1" });
      });
      expect(container.textContent).toContain("Page not responding");

      act(() => {
        onResponsive({ panelId: "browser-panel-1" });
      });
      expect(container.textContent).not.toContain("Page not responding");
    });

    it("does not downgrade a crashed banner when a stale responsive event fires", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);
      const onResponsive = getResponsiveCallback();

      act(() => {
        emitRenderProcessGone(webview, "crashed");
        emitRenderProcessGone(webview, "crashed");
      });
      expect(container.textContent).toContain("Page process crashed");

      act(() => {
        onResponsive({ panelId: "browser-panel-1" });
      });
      expect(container.textContent).toContain("Page process crashed");
    });

    it("does not let a stale unresponsive event replace a crashed banner", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);
      const onUnresponsive = getUnresponsiveCallback();

      act(() => {
        emitRenderProcessGone(webview, "crashed");
      });
      expect(container.textContent).toContain("Page process crashed");

      act(() => {
        onUnresponsive({ panelId: "browser-panel-1" });
      });
      expect(container.textContent).toContain("Page process crashed");
      expect(container.textContent).not.toContain("Page not responding");
    });

    it("clears stuck-load timer so a load timeout does not replace the crash banner", () => {
      // The load-error overlay is rendered as absolute z-30 over the entire
      // pane — without clearing the slow-load timer on crash, a pending 30s
      // timeout would fire after the crash and stack a "Page load timed out"
      // overlay on top of the in-flow crash banner, hiding it entirely.
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        webview.setMockLoading(true);
        emitWebviewEvent(webview, "did-start-loading");
      });
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      act(() => {
        emitRenderProcessGone(webview, "crashed");
      });
      act(() => {
        vi.advanceTimersByTime(30_000);
      });

      expect(webview.stop).not.toHaveBeenCalled();
      expect(container.textContent).toContain("Page process crashed");
      expect(container.textContent).not.toContain("Page load timed out");
    });

    it("auto-reloads again on a crash that lands just outside the 60s window", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitRenderProcessGone(webview, "crashed");
      });
      act(() => {
        vi.advanceTimersByTime(60_001);
      });
      act(() => {
        emitRenderProcessGone(webview, "crashed");
      });

      expect(webview.reload).toHaveBeenCalledTimes(2);
      expect(container.textContent).toContain("Page process crashed");
    });

    it("does not auto-reload on a crash just inside the 60s window", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitRenderProcessGone(webview, "crashed");
      });
      act(() => {
        vi.advanceTimersByTime(59_999);
      });
      act(() => {
        emitRenderProcessGone(webview, "crashed");
      });

      expect(webview.reload).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain("Page process crashed");
    });
  });

  describe("src binding regression (#9940)", () => {
    it("seeds src once at mount", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);
      expect(webview.getAttribute("src")).toBe("http://localhost:5173/");
    });

    it("does not re-bind src or re-load after an in-page guest navigation", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);

      // A guest SPA navigation (pushState) is reported via did-navigate-in-page.
      // The resulting history update must NOT feed back into the src attribute
      // (which Electron's SrcAttribute observer would turn into a full reload).
      webview.loadURL.mockClear();
      const setAttributeSpy = vi.spyOn(webview, "setAttribute");

      act(() => {
        emitWebviewEvent(webview, "did-navigate-in-page", {
          url: "http://localhost:5173/spa/route",
          isMainFrame: true,
        });
      });

      expect(webview.loadURL).not.toHaveBeenCalled();
      expect(setAttributeSpy.mock.calls.filter(([name]) => name === "src")).toHaveLength(0);
      expect(webview.getAttribute("src")).toBe("http://localhost:5173/");
    });

    it("does not re-bind src or re-load after a full guest navigation", () => {
      const { container } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);

      webview.loadURL.mockClear();
      const setAttributeSpy = vi.spyOn(webview, "setAttribute");

      act(() => {
        emitWebviewEvent(webview, "did-navigate", {
          url: "http://localhost:5173/page-2",
        });
      });

      expect(webview.loadURL).not.toHaveBeenCalled();
      expect(setAttributeSpy.mock.calls.filter(([name]) => name === "src")).toHaveLength(0);
      expect(webview.getAttribute("src")).toBe("http://localhost:5173/");
    });

    it("re-seeds src to the current URL when a partition change remounts the webview", () => {
      const { container, rerender } = render(<BrowserPane {...baseProps} />);
      const webview = getWebviewElement(container);
      expect(webview.getAttribute("src")).toBe("http://localhost:5173/");

      // Guest navigates to a new route.
      act(() => {
        emitWebviewEvent(webview, "did-navigate", { url: "http://localhost:5173/dashboard" });
      });

      // The project id resolves to a different value, changing webviewPartition,
      // which remounts the <webview> via its key. The fresh element must seed to
      // the URL the user is currently on — not the URL captured at mount (#9940).
      useProjectStoreMock.mockImplementation(
        (selector: (state: { currentProject: { id: string } | null }) => unknown) =>
          selector({ currentProject: { id: "other-project" } })
      );

      act(() => {
        rerender(<BrowserPane {...baseProps} />);
      });

      const remountedWebview = getWebviewElement(container);
      expect(remountedWebview.getAttribute("src")).toBe("http://localhost:5173/dashboard");
    });
  });

  // #9941: BrowserPane must wire `validateUrl` into the toolbar so the address bar
  // honors the extended host policy (allowedHosts defaults to [] here, i.e. LAN/
  // reserved-TLD hosts are implicitly allowed). Removing the prop regresses this —
  // the toolbar would fall back to strict localhost-only validation.
  describe("address bar host policy (#9941)", () => {
    it("passes an extended-policy validateUrl that accepts LAN hosts", () => {
      render(<BrowserPane {...baseProps} />);
      expect(browserToolbarPropsSpy).toHaveBeenCalled();
      const props = browserToolbarPropsSpy.mock.calls.at(-1)![0] as Record<string, unknown>;
      const validateUrl = props.validateUrl as
        | ((url: string) => { url?: string; error?: string })
        | undefined;

      expect(typeof validateUrl).toBe("function");
      // LAN host is implicitly allowed under the extended policy — no error.
      expect(validateUrl!("192.168.1.10:3000")).toMatchObject({
        url: "http://192.168.1.10:3000/",
      });
      // Reserved TLD likewise passes without error.
      expect(validateUrl!("printer.local").error).toBeUndefined();
    });
  });
});
