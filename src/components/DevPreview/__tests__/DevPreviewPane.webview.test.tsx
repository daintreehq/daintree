// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { DevPreviewPaneProps } from "../DevPreviewPane";
import { DevPreviewPane } from "../DevPreviewPane";

type MockWebContents = {
  setUserAgent: ReturnType<typeof vi.fn>;
  getUserAgent: ReturnType<typeof vi.fn>;
  enableDeviceEmulation: ReturnType<typeof vi.fn>;
  disableDeviceEmulation: ReturnType<typeof vi.fn>;
};

type MockWebviewElement = HTMLElement & {
  reload: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  setZoomFactor: ReturnType<typeof vi.fn>;
  getURL: ReturnType<typeof vi.fn>;
  isLoading: ReturnType<typeof vi.fn>;
  executeJavaScript: ReturnType<typeof vi.fn>;
  getWebContentsId: ReturnType<typeof vi.fn>;
  getWebContents: () => MockWebContents;
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
  webview.executeJavaScript = vi.fn().mockResolvedValue(0);
  webview.getWebContentsId = vi.fn(() => 42);
  const mockWc = {
    setUserAgent: vi.fn(),
    getUserAgent: vi.fn(() => "original-ua"),
    enableDeviceEmulation: vi.fn(),
    disableDeviceEmulation: vi.fn(),
  };
  webview.getWebContents = vi.fn(() => mockWc);
  webview.setMockLoading = (value: boolean) => {
    loading = value;
  };

  return webview;
}

type DevServerState = {
  status: "stopped" | "starting" | "installing" | "running" | "error";
  url: string | null;
  terminalId: string | null;
  error: {
    type: "unknown" | "port-conflict" | "missing-dependencies" | "permission";
    message: string;
    port?: string;
    module?: string;
  } | null;
  start: ReturnType<typeof vi.fn>;
  restart: ReturnType<typeof vi.fn>;
  isRestarting: boolean;
};

const {
  terminalStoreState,
  scrollPositionRef,
  usePanelStoreMock,
  useProjectStoreMock,
  useProjectSettingsStoreMock,
  devServerStateRef,
  useDevServerMock,
  useIsDraggingMock,
} = vi.hoisted(() => {
  const scrollPositionRef: { current: { url: string; scrollY: number } | undefined } = {
    current: undefined,
  };
  const terminalStoreState = {
    activeDockTerminalId: undefined as string | undefined,
    panelsById: {} as Record<string, unknown>,
    getTerminal: vi.fn(),
    setBrowserUrl: vi.fn(),
    setBrowserHistory: vi.fn(),
    setBrowserZoom: vi.fn(),
    setDevPreviewConsoleOpen: vi.fn(),
    setDevPreviewConsoleTab: vi.fn(),
    setViewportPreset: vi.fn(),
    setDevPreviewScrollPosition: vi.fn(
      (_id: string, position: { url: string; scrollY: number } | undefined) => {
        scrollPositionRef.current = position;
      }
    ),
  };
  const usePanelStoreMock = Object.assign(
    vi.fn((selector: (state: typeof terminalStoreState) => unknown) =>
      selector(terminalStoreState)
    ),
    { getState: () => terminalStoreState }
  );

  const projectStoreState = {
    currentProject: { id: "project-1" } as { id: string } | null,
  };
  const useProjectStoreMock = vi.fn((selector: (state: typeof projectStoreState) => unknown) =>
    selector(projectStoreState)
  );

  const projectSettingsStoreState = {
    projectId: "project-1",
    settings: {
      devServerCommand: "npm run dev",
      environmentVariables: { API_URL: "http://localhost:9000" },
      runCommands: [],
    },
    detectedRunners: [],
    allDetectedRunners: [],
    isLoading: false,
    error: null,
    loadSettings: vi.fn(),
    setSettings: vi.fn(),
  };
  const useProjectSettingsStoreMock = vi.fn(
    (selector: (state: typeof projectSettingsStoreState) => unknown) =>
      selector(projectSettingsStoreState)
  );

  const devServerStateRef: { current: DevServerState } = {
    current: {
      status: "running",
      url: "http://localhost:5173/",
      terminalId: "dev-terminal-1",
      error: null,
      start: vi.fn(),
      restart: vi.fn().mockResolvedValue(undefined),
      isRestarting: false,
    },
  };
  const useDevServerMock = vi.fn(() => devServerStateRef.current);

  const useIsDraggingMock = vi.fn(() => false);

  return {
    terminalStoreState,
    scrollPositionRef,
    usePanelStoreMock,
    useProjectStoreMock,
    useProjectSettingsStoreMock,
    devServerStateRef,
    useDevServerMock,
    useIsDraggingMock,
  };
});

vi.mock("@/store", () => ({
  usePanelStore: usePanelStoreMock,
  usePortalStore: () => ({ isOpen: false, width: 0 }),
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: useProjectStoreMock,
}));

vi.mock("@/store/projectSettingsStore", () => ({
  useProjectSettingsStore: useProjectSettingsStoreMock,
}));

vi.mock("@/hooks/useDevServer", () => ({
  useDevServer: useDevServerMock,
}));

vi.mock("@/components/DragDrop", () => ({
  useIsDragging: useIsDraggingMock,
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
  ContentPanel: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="content-panel">{children}</div>
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuItem: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuSeparator: () => null,
}));

vi.mock("@/components/ui/ConfirmDialog", () => ({
  ConfirmDialog: () => null,
}));

vi.mock("@/components/DevPreview/ConsoleDrawer", () => ({
  ConsoleDrawer: ({ onRestartDevServer }: { onRestartDevServer?: () => void }) => (
    <button
      type="button"
      data-testid="hard-restart"
      onClick={() => onRestartDevServer?.()}
      aria-label="hard-restart"
    >
      Restart dev server
    </button>
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

describe("DevPreviewPane webview lifecycle regression", () => {
  let originalCreateElement: typeof document.createElement;

  const baseProps: DevPreviewPaneProps = {
    id: "dev-preview-panel-1",
    title: "Dev Preview",
    cwd: "/repo",
    isFocused: true,
    onFocus: vi.fn(),
    onClose: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    scrollPositionRef.current = undefined;
    originalCreateElement = document.createElement.bind(document);
    document.createElement = ((tagName: string, options?: ElementCreationOptions) => {
      const element = originalCreateElement(tagName, options);
      if (String(tagName).toLowerCase() === "webview") {
        return decorateWebviewElement(element as HTMLElement);
      }
      return element;
    }) as typeof document.createElement;
    terminalStoreState.getTerminal.mockImplementation(() => ({
      id: "dev-preview-panel-1",
      browserHistory: {
        past: [],
        present: "http://localhost:5173/",
        future: [],
      },
      browserZoom: 1.4,
      devPreviewConsoleOpen: false,
      devCommand: "npm run dev",
      devPreviewScrollPosition: scrollPositionRef.current,
    }));
    devServerStateRef.current = {
      status: "running",
      url: "http://localhost:5173/",
      terminalId: "dev-terminal-1",
      error: null,
      start: vi.fn(),
      restart: vi.fn().mockResolvedValue(undefined),
      isRestarting: false,
    };
    terminalStoreState.activeDockTerminalId = undefined;
    (window as unknown as { electron: Record<string, unknown> }).electron = {
      system: {
        openExternal: vi.fn(),
      },
      window: {
        onDestroyHiddenWebviews: vi.fn(() => vi.fn()),
      },
      webview: {
        registerPanel: vi.fn(() => Promise.resolve()),
        onDialogRequest: vi.fn(() => vi.fn()),
        onFindShortcut: vi.fn(() => vi.fn()),
        onNavigationBlocked: vi.fn(() => vi.fn()),
        onOAuthLoopbackStatus: vi.fn(() => vi.fn()),
        setLifecycleState: vi.fn().mockResolvedValue(undefined),
        getScrollPosition: vi.fn().mockResolvedValue(0),
        startConsoleCapture: vi.fn(() => Promise.resolve()),
        stopConsoleCapture: vi.fn(() => Promise.resolve()),
        onConsoleMessage: vi.fn(() => vi.fn()),
        onConsoleContextCleared: vi.fn(() => vi.fn()),
        reloadIgnoringCache: vi.fn(() => Promise.resolve()),
        onUnresponsive: vi.fn(() => vi.fn()),
        onResponsive: vi.fn(() => vi.fn()),
      },
    };
  });

  it("uses theme-backed preview chrome surfaces", () => {
    const { container } = render(<DevPreviewPane {...baseProps} />);
    const themedSurface = container.querySelector(".bg-surface-canvas");
    expect(themedSurface).toBeTruthy();
    expect(container.querySelector(".bg-white")).toBeNull();
  });

  afterEach(() => {
    document.createElement = originalCreateElement;
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("renders webview with allowpopups attribute for target=_blank support", () => {
    const { container } = render(<DevPreviewPane {...baseProps} />);
    const webview = getWebviewElement(container);
    expect(webview.hasAttribute("allowpopups")).toBe(true);
  });

  it("recovers ready state from an already-loaded webview and reapplies zoom", async () => {
    const { container } = render(<DevPreviewPane {...baseProps} />);
    const webview = getWebviewElement(container);

    await act(async () => {
      await Promise.resolve();
    });

    expect(webview.setZoomFactor).toHaveBeenCalledWith(1.4);
  });

  it("binds loading listeners when webview mounts after initial waiting state", async () => {
    terminalStoreState.getTerminal.mockImplementation(() => ({
      id: "dev-preview-panel-1",
      browserHistory: {
        past: [],
        present: "",
        future: [],
      },
      browserZoom: 1.4,
      devPreviewConsoleOpen: false,
      devCommand: "npm run dev",
    }));
    devServerStateRef.current = {
      status: "starting",
      url: null,
      terminalId: "dev-terminal-1",
      error: null,
      start: vi.fn(),
      restart: vi.fn().mockResolvedValue(undefined),
      isRestarting: false,
    };

    const { container, rerender } = render(<DevPreviewPane {...baseProps} />);
    expect(container.querySelector("webview")).toBeNull();

    devServerStateRef.current = {
      ...devServerStateRef.current,
      status: "running",
      url: "http://localhost:5173/",
    };
    rerender(<DevPreviewPane {...baseProps} />);

    await act(async () => {
      await Promise.resolve();
    });

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
  });

  it("stops webview and shows timeout error after 30s when loading is stuck", () => {
    const { container } = render(<DevPreviewPane {...baseProps} />);
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

  it("clears stuck-load timeout when loading fails", () => {
    const { container } = render(<DevPreviewPane {...baseProps} />);
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

  it("clears pending timeout when hard restart is triggered", () => {
    const { container } = render(<DevPreviewPane {...baseProps} />);
    const webview = getWebviewElement(container);

    act(() => {
      webview.setMockLoading(true);
      emitWebviewEvent(webview, "did-start-loading");
    });

    fireEvent.click(screen.getByTestId("hard-restart"));

    act(() => {
      vi.advanceTimersByTime(30000);
    });

    expect(webview.reload).not.toHaveBeenCalled();
    expect(webview.stop).not.toHaveBeenCalled();
    expect(devServerStateRef.current.restart).toHaveBeenCalledTimes(1);
    expect(terminalStoreState.setBrowserUrl).toHaveBeenCalledWith("dev-preview-panel-1", "");
  });

  describe("viewport device emulation", () => {
    const withPreset = (preset: string | undefined) => {
      terminalStoreState.getTerminal.mockImplementation(() => ({
        id: "dev-preview-panel-1",
        browserHistory: { past: [], present: "http://localhost:5173/", future: [] },
        browserZoom: 1.4,
        devPreviewConsoleOpen: false,
        devCommand: "npm run dev",
        viewportPreset: preset,
      }));
    };

    const getEmulationMock = (container: HTMLElement) =>
      getWebviewElement(container).getWebContents().enableDeviceEmulation;
    const getDisableEmulationMock = (container: HTMLElement) =>
      getWebviewElement(container).getWebContents().disableDeviceEmulation;

    it("applies device emulation for the active preset without reloading the page", async () => {
      withPreset("iphone");
      const { container } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      await act(async () => {
        await Promise.resolve();
      });

      expect(getEmulationMock(container)).toHaveBeenCalledWith({
        screenPosition: "mobile",
        screenSize: { width: 393, height: 852 },
        viewPosition: { x: 0, y: 0 },
        deviceScaleFactor: 1,
        viewSize: { width: 393, height: 852 },
        scale: 1,
      });
      expect(webview.reload).not.toHaveBeenCalled();
    });

    it("re-applies device emulation on did-finish-load (cross-origin nav drops it)", async () => {
      withPreset("galaxy");
      const { container } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      await act(async () => {
        await Promise.resolve();
      });

      getEmulationMock(container).mockClear();

      act(() => {
        emitWebviewEvent(webview, "did-finish-load");
      });

      expect(getEmulationMock(container)).toHaveBeenCalledWith({
        screenPosition: "mobile",
        screenSize: { width: 360, height: 780 },
        viewPosition: { x: 0, y: 0 },
        deviceScaleFactor: 1,
        viewSize: { width: 360, height: 780 },
        scale: 1,
      });
    });

    it("clears device emulation when the viewport preset is removed", async () => {
      withPreset("iphone");
      const { container, rerender } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      await act(async () => {
        await Promise.resolve();
      });

      getEmulationMock(container).mockClear();
      withPreset(undefined);
      rerender(<DevPreviewPane {...baseProps} />);

      await act(async () => {
        await Promise.resolve();
      });

      expect(getDisableEmulationMock(container)).toHaveBeenCalled();
      expect(webview.reload).not.toHaveBeenCalled();
    });
  });

  it("retries loadURL with exponential backoff when did-fail-load fires with ERR_CONNECTION_REFUSED", async () => {
    const { container } = render(<DevPreviewPane {...baseProps} />);
    const webview = getWebviewElement(container);

    act(() => {
      emitWebviewEvent(webview, "did-fail-load", {
        errorCode: -102,
        errorDescription: "ERR_CONNECTION_REFUSED",
        isMainFrame: true,
        validatedURL: "http://localhost:5173/",
      });
    });

    // First retry fires after 500ms (backoff: 500 * 2^0 = 500ms)
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(webview.loadURL).toHaveBeenCalled();
  });

  it("stops retrying after a successful load following did-fail-load", async () => {
    const { container } = render(<DevPreviewPane {...baseProps} />);
    const webview = getWebviewElement(container);

    act(() => {
      emitWebviewEvent(webview, "did-fail-load", {
        errorCode: -102,
        errorDescription: "ERR_CONNECTION_REFUSED",
        isMainFrame: true,
        validatedURL: "http://localhost:5173/",
      });
    });

    act(() => {
      vi.advanceTimersByTime(500);
    });

    const callsAfterFirstRetry = webview.loadURL.mock.calls.length;

    // Successful load resets retry counter
    act(() => {
      emitWebviewEvent(webview, "did-finish-load");
    });

    // Fail again — retry counter was reset so retry fires at 500ms again
    act(() => {
      emitWebviewEvent(webview, "did-fail-load", {
        errorCode: -102,
        errorDescription: "ERR_CONNECTION_REFUSED",
        isMainFrame: true,
        validatedURL: "http://localhost:5173/",
      });
    });

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(webview.loadURL.mock.calls.length).toBeGreaterThan(callsAfterFirstRetry);
  });

  it("does not retry did-fail-load for non-connection errors", () => {
    const { container } = render(<DevPreviewPane {...baseProps} />);
    const webview = getWebviewElement(container);

    act(() => {
      emitWebviewEvent(webview, "did-fail-load", {
        errorCode: -3,
        errorDescription: "ERR_ABORTED",
        isMainFrame: true,
        validatedURL: "http://localhost:5173/",
      });
    });

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(webview.loadURL).not.toHaveBeenCalled();
  });

  it("renders drag protection overlay and hides webview when isDragging is true", () => {
    useIsDraggingMock.mockReturnValue(true);
    const { container } = render(<DevPreviewPane {...baseProps} />);

    const overlay = container.querySelector(".z-10.bg-transparent");
    expect(overlay).not.toBeNull();

    const webview = container.querySelector("webview");
    expect(webview?.className).toContain("invisible");
    expect(webview?.className).toContain("pointer-events-none");
  });

  it("does not render drag protection overlay when isDragging is false", () => {
    useIsDraggingMock.mockReturnValue(false);
    const { container } = render(<DevPreviewPane {...baseProps} />);

    const overlay = container.querySelector(".z-10.bg-transparent");
    expect(overlay).toBeNull();

    const webview = container.querySelector("webview");
    expect(webview?.className).not.toContain("invisible");
    expect(webview?.className).not.toContain("pointer-events-none");
  });

  it("cleans pending timeout on unmount", () => {
    const { container, unmount } = render(<DevPreviewPane {...baseProps} />);
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

  it("uses configurable load timeout from project settings", () => {
    const origSettings = useProjectSettingsStoreMock.getMockImplementation();
    useProjectSettingsStoreMock.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (selector: (state: any) => unknown) =>
        selector({
          projectId: "project-1",
          settings: {
            devServerCommand: "npm run dev",
            devServerLoadTimeout: 60,
            environmentVariables: {},
            runCommands: [],
          },
          detectedRunners: [],
          allDetectedRunners: [],
          isLoading: false,
          error: null,
        })
    );

    const { container } = render(<DevPreviewPane {...baseProps} />);
    const webview = getWebviewElement(container);

    act(() => {
      webview.setMockLoading(true);
      emitWebviewEvent(webview, "did-start-loading");
    });

    // Should NOT stop at 30s
    act(() => {
      vi.advanceTimersByTime(30000);
    });
    expect(webview.stop).not.toHaveBeenCalled();

    // Should stop at 60s
    act(() => {
      vi.advanceTimersByTime(30000);
    });
    expect(webview.stop).toHaveBeenCalledTimes(1);
    expect(webview.reload).not.toHaveBeenCalled();

    if (origSettings) useProjectSettingsStoreMock.mockImplementation(origSettings);
  });

  it("captures scroll position via CDP when memory-pressure eviction fires (#8281)", async () => {
    // Eviction-path regression: useWebviewThrottle freezes hidden dock panels via
    // CDP Page.setWebLifecycleState after 500ms. On a frozen page,
    // executeJavaScript("window.scrollY") hangs indefinitely (WICG frozen-state
    // spec suspends the JS task queue), so the previous capture path lost the
    // scroll position. The fix reads scroll via main-process CDP getLayoutMetrics.
    terminalStoreState.activeDockTerminalId = "dev-preview-panel-1";
    let destroyHandler: ((payload: { tier: 1 | 2 }) => void) | undefined;
    const onDestroyHiddenWebviews = vi.fn((handler: (payload: { tier: 1 | 2 }) => void) => {
      destroyHandler = handler;
      return vi.fn();
    });
    const getScrollPosition = vi.fn().mockResolvedValue(250);
    (window as unknown as { electron: Record<string, unknown> }).electron = {
      system: { openExternal: vi.fn() },
      window: { onDestroyHiddenWebviews },
      webview: {
        registerPanel: vi.fn(() => Promise.resolve()),
        onDialogRequest: vi.fn(() => vi.fn()),
        onFindShortcut: vi.fn(() => vi.fn()),
        onNavigationBlocked: vi.fn(() => vi.fn()),
        onOAuthLoopbackStatus: vi.fn(() => vi.fn()),
        onUnresponsive: vi.fn(() => vi.fn()),
        onResponsive: vi.fn(() => vi.fn()),
        setLifecycleState: vi.fn().mockResolvedValue(undefined),
        getScrollPosition,
        startConsoleCapture: vi.fn(() => Promise.resolve()),
        stopConsoleCapture: vi.fn(() => Promise.resolve()),
        onConsoleMessage: vi.fn(() => vi.fn()),
        onConsoleContextCleared: vi.fn(() => vi.fn()),
      },
    };

    const { container, rerender } = render(<DevPreviewPane {...baseProps} location="dock" />);
    const webview = getWebviewElement(container);

    await act(async () => {
      await Promise.resolve();
    });

    // Panel is no longer the active dock panel — eviction is now valid.
    terminalStoreState.activeDockTerminalId = "other-panel";
    rerender(<DevPreviewPane {...baseProps} location="dock" />);

    await act(async () => {
      destroyHandler?.({ tier: 1 });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getScrollPosition).toHaveBeenCalledWith(42);
    // Capture must run exactly once — the setWebviewNode(null) ref-cleanup and
    // the eviction useEffect are not allowed to both fire and race with each
    // other (the slower call could clobber the faster with scrollY=0 if the
    // page has already committed to about:blank).
    expect(getScrollPosition).toHaveBeenCalledTimes(1);
    expect(terminalStoreState.setDevPreviewScrollPosition).toHaveBeenCalledWith(
      "dev-preview-panel-1",
      { url: "http://localhost:5173/", scrollY: 250 }
    );
    // The frozen-page path must NOT be used for the eviction capture.
    expect(webview.executeJavaScript).not.toHaveBeenCalledWith("window.scrollY");
  });

  it("captures scroll position via CDP in setWebviewNode ref cleanup (#8281)", async () => {
    // Ref-cleanup regression: when the <webview> JSX is unmounted (e.g. on
    // panel unmount or eviction-driven branch switch), the React ref callback
    // fires with null. Previously, this path also relied on
    // executeJavaScript("window.scrollY"), which hangs on a frozen page. The
    // fix routes both capture sites through the main-process CDP path.
    const getScrollPosition = vi.fn().mockResolvedValue(310);
    (window as unknown as { electron: Record<string, unknown> }).electron = {
      system: { openExternal: vi.fn() },
      window: { onDestroyHiddenWebviews: vi.fn(() => vi.fn()) },
      webview: {
        registerPanel: vi.fn(() => Promise.resolve()),
        onDialogRequest: vi.fn(() => vi.fn()),
        onFindShortcut: vi.fn(() => vi.fn()),
        onNavigationBlocked: vi.fn(() => vi.fn()),
        onOAuthLoopbackStatus: vi.fn(() => vi.fn()),
        onUnresponsive: vi.fn(() => vi.fn()),
        onResponsive: vi.fn(() => vi.fn()),
        setLifecycleState: vi.fn().mockResolvedValue(undefined),
        getScrollPosition,
        startConsoleCapture: vi.fn(() => Promise.resolve()),
        stopConsoleCapture: vi.fn(() => Promise.resolve()),
        onConsoleMessage: vi.fn(() => vi.fn()),
        onConsoleContextCleared: vi.fn(() => vi.fn()),
      },
    };

    const { container, unmount } = render(<DevPreviewPane {...baseProps} />);
    const webview = getWebviewElement(container);

    await act(async () => {
      await Promise.resolve();
    });

    // Unmount triggers ref-callback(null) → setWebviewNode cleanup path.
    await act(async () => {
      unmount();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getScrollPosition).toHaveBeenCalledWith(42);
    expect(terminalStoreState.setDevPreviewScrollPosition).toHaveBeenCalledWith(
      "dev-preview-panel-1",
      { url: "http://localhost:5173/", scrollY: 310 }
    );
    // Frozen-page path must NOT be used for ref-cleanup capture.
    expect(webview.executeJavaScript).not.toHaveBeenCalledWith("window.scrollY");
  });

  it("does not persist scrollY=0 from CDP (avoids clobbering prior position)", async () => {
    // Defense: handleGetScrollPosition returns 0 on CDP error. If we persisted
    // {scrollY: 0}, an earlier captured position could be silently overwritten.
    // The renderer guard `> 0` keeps the prior value intact.
    const getScrollPosition = vi.fn().mockResolvedValue(0);
    (window as unknown as { electron: Record<string, unknown> }).electron = {
      system: { openExternal: vi.fn() },
      window: { onDestroyHiddenWebviews: vi.fn(() => vi.fn()) },
      webview: {
        registerPanel: vi.fn(() => Promise.resolve()),
        onDialogRequest: vi.fn(() => vi.fn()),
        onFindShortcut: vi.fn(() => vi.fn()),
        onNavigationBlocked: vi.fn(() => vi.fn()),
        onOAuthLoopbackStatus: vi.fn(() => vi.fn()),
        onUnresponsive: vi.fn(() => vi.fn()),
        onResponsive: vi.fn(() => vi.fn()),
        setLifecycleState: vi.fn().mockResolvedValue(undefined),
        getScrollPosition,
        startConsoleCapture: vi.fn(() => Promise.resolve()),
        stopConsoleCapture: vi.fn(() => Promise.resolve()),
        onConsoleMessage: vi.fn(() => vi.fn()),
        onConsoleContextCleared: vi.fn(() => vi.fn()),
      },
    };

    const { unmount } = render(<DevPreviewPane {...baseProps} />);

    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      unmount();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getScrollPosition).toHaveBeenCalled();
    expect(terminalStoreState.setDevPreviewScrollPosition).not.toHaveBeenCalled();
  });

  it("captures scroll position when status transitions from running", async () => {
    const { container, rerender } = render(<DevPreviewPane {...baseProps} />);
    const webview = getWebviewElement(container);
    webview.executeJavaScript.mockResolvedValue(250);

    // Transition to stopped
    devServerStateRef.current = {
      ...devServerStateRef.current,
      status: "stopped",
      url: null,
    };
    rerender(<DevPreviewPane {...baseProps} />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(webview.executeJavaScript).toHaveBeenCalledWith("window.scrollY");
    expect(terminalStoreState.setDevPreviewScrollPosition).toHaveBeenCalledWith(
      "dev-preview-panel-1",
      { url: "http://localhost:5173/", scrollY: 250 }
    );
  });

  it("restores scroll position on dom-ready after remount", async () => {
    const { container, rerender } = render(<DevPreviewPane {...baseProps} />);
    const webview = getWebviewElement(container);
    webview.executeJavaScript.mockResolvedValue(250);

    // Capture scroll by transitioning to stopped
    devServerStateRef.current = {
      ...devServerStateRef.current,
      status: "stopped",
      url: null,
    };
    rerender(<DevPreviewPane {...baseProps} />);

    await act(async () => {
      await Promise.resolve();
    });

    // Go back to running (remount webview)
    devServerStateRef.current = {
      ...devServerStateRef.current,
      status: "running",
      url: "http://localhost:5173/",
    };
    rerender(<DevPreviewPane {...baseProps} />);

    await act(async () => {
      await Promise.resolve();
    });

    const newWebview = getWebviewElement(container);

    act(() => {
      emitWebviewEvent(newWebview, "dom-ready");
    });

    expect(newWebview.executeJavaScript).toHaveBeenCalledWith(
      "requestAnimationFrame(() => window.scrollTo(0, 250))"
    );
  });

  it("clears scroll cache on hard restart", async () => {
    const { container, rerender } = render(<DevPreviewPane {...baseProps} />);
    const webview = getWebviewElement(container);
    webview.executeJavaScript.mockResolvedValue(100);

    // Capture scroll
    devServerStateRef.current = {
      ...devServerStateRef.current,
      status: "stopped",
      url: null,
    };
    rerender(<DevPreviewPane {...baseProps} />);

    await act(async () => {
      await Promise.resolve();
    });

    // Go back to running
    devServerStateRef.current = {
      ...devServerStateRef.current,
      status: "running",
      url: "http://localhost:5173/",
    };
    rerender(<DevPreviewPane {...baseProps} />);

    await act(async () => {
      await Promise.resolve();
    });

    // Hard restart clears cache
    fireEvent.click(screen.getByTestId("hard-restart"));

    expect(terminalStoreState.setDevPreviewScrollPosition).toHaveBeenCalledWith(
      "dev-preview-panel-1",
      undefined
    );

    // Remount
    devServerStateRef.current = {
      ...devServerStateRef.current,
      status: "running",
      url: "http://localhost:5173/",
    };
    rerender(<DevPreviewPane {...baseProps} />);

    await act(async () => {
      await Promise.resolve();
    });

    const newWebview = getWebviewElement(container);
    newWebview.executeJavaScript.mockClear();

    act(() => {
      emitWebviewEvent(newWebview, "dom-ready");
    });

    // Should NOT call scrollTo since cache was cleared
    const scrollToCalls = newWebview.executeJavaScript.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("scrollTo")
    );
    expect(scrollToCalls).toHaveLength(0);
  });

  it("ignores in-flight scroll captures that resolve after hard restart", async () => {
    const { container, rerender } = render(<DevPreviewPane {...baseProps} />);
    const webview = getWebviewElement(container);

    // Build a manually-resolvable promise so we can interleave the hard restart
    // before the capture promise resolves.
    let resolveScrollY: (v: number) => void = () => {};
    const pending = new Promise<number>((resolve) => {
      resolveScrollY = resolve;
    });
    webview.executeJavaScript.mockImplementationOnce(() => pending);

    // Trigger a capture by transitioning away from running. The capture promise
    // is now in-flight and parked on `pending`.
    devServerStateRef.current = {
      ...devServerStateRef.current,
      status: "stopped",
      url: null,
    };
    rerender(<DevPreviewPane {...baseProps} />);

    await act(async () => {
      await Promise.resolve();
    });

    // Hard restart fires before the in-flight capture resolves.
    fireEvent.click(screen.getByTestId("hard-restart"));

    // The clear must have happened.
    expect(terminalStoreState.setDevPreviewScrollPosition).toHaveBeenCalledWith(
      "dev-preview-panel-1",
      undefined
    );

    terminalStoreState.setDevPreviewScrollPosition.mockClear();

    // Now resolve the previously parked capture.
    await act(async () => {
      resolveScrollY(987);
      await Promise.resolve();
      await Promise.resolve();
    });

    // The stale capture must not have written anything back over the cleared state.
    expect(terminalStoreState.setDevPreviewScrollPosition).not.toHaveBeenCalled();
  });

  it("does not restore scroll when saved URL differs from loaded URL", async () => {
    scrollPositionRef.current = { url: "http://localhost:5173/old", scrollY: 250 };
    const { container } = render(<DevPreviewPane {...baseProps} />);
    const webview = getWebviewElement(container);
    webview.executeJavaScript.mockClear();

    act(() => {
      emitWebviewEvent(webview, "dom-ready");
    });

    const scrollToCalls = webview.executeJavaScript.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("scrollTo")
    );
    expect(scrollToCalls).toHaveLength(0);
  });

  it("does not restore scroll when saved scrollY is 0", async () => {
    scrollPositionRef.current = { url: "http://localhost:5173/", scrollY: 0 };
    const { container } = render(<DevPreviewPane {...baseProps} />);
    const webview = getWebviewElement(container);
    webview.executeJavaScript.mockClear();

    act(() => {
      emitWebviewEvent(webview, "dom-ready");
    });

    const scrollToCalls = webview.executeJavaScript.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("scrollTo")
    );
    expect(scrollToCalls).toHaveLength(0);
  });

  it("clears stale browserUrl when panel becomes unconfigured after settings load", async () => {
    // Start with settings loading (isUnconfigured = false during load)
    useProjectSettingsStoreMock.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (selector: (state: any) => unknown) =>
        selector({
          projectId: "project-1",
          settings: {
            devServerCommand: "",
            environmentVariables: {},
            runCommands: [],
          },
          detectedRunners: [],
          allDetectedRunners: [],
          isLoading: true,
          error: null,
        })
    );
    terminalStoreState.getTerminal.mockImplementation(() => ({
      id: "dev-preview-panel-1",
      browserHistory: {
        past: ["http://localhost:3000/old"],
        present: "http://localhost:3000/stale",
        future: [],
      },
      browserZoom: 1.0,
      devPreviewConsoleOpen: false,
      devCommand: "",
    }));
    devServerStateRef.current = {
      ...devServerStateRef.current,
      status: "stopped",
      url: null,
    };

    const { rerender } = render(<DevPreviewPane {...baseProps} />);

    // Now settings finish loading — isUnconfigured becomes true
    useProjectSettingsStoreMock.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (selector: (state: any) => unknown) =>
        selector({
          projectId: "project-1",
          settings: {
            devServerCommand: "",
            environmentVariables: {},
            runCommands: [],
          },
          detectedRunners: [],
          allDetectedRunners: [],
          isLoading: false,
          error: null,
        })
    );
    rerender(<DevPreviewPane {...baseProps} />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(terminalStoreState.setBrowserUrl).toHaveBeenCalledWith("dev-preview-panel-1", "");
  });

  it("shows retry-exhausted error overlay after MAX_RETRIES connection failures", async () => {
    const { container } = render(<DevPreviewPane {...baseProps} />);
    const webview = getWebviewElement(container);

    // Fire 6 failures (MAX_RETRIES = 5, so the 6th triggers the error)
    for (let i = 0; i < 6; i++) {
      act(() => {
        emitWebviewEvent(webview, "did-fail-load", {
          errorCode: -102,
          errorDescription: "ERR_CONNECTION_REFUSED",
          isMainFrame: true,
          validatedURL: "http://localhost:5173/",
        });
      });
      if (i < 5) {
        act(() => {
          vi.advanceTimersByTime(Math.min(500 * 2 ** i, 8000));
        });
      }
    }

    expect(container.textContent).toContain("Dev server unreachable");
    expect(container.textContent).toContain("Unable to connect to dev server");
  });

  it("clears retry-exhausted error on hard restart", async () => {
    const { container } = render(<DevPreviewPane {...baseProps} />);
    const webview = getWebviewElement(container);

    // Exhaust retries
    for (let i = 0; i < 6; i++) {
      act(() => {
        emitWebviewEvent(webview, "did-fail-load", {
          errorCode: -102,
          errorDescription: "ERR_CONNECTION_REFUSED",
          isMainFrame: true,
          validatedURL: "http://localhost:5173/",
        });
      });
      if (i < 5) {
        act(() => {
          vi.advanceTimersByTime(Math.min(500 * 2 ** i, 8000));
        });
      }
    }

    expect(container.textContent).toContain("Dev server unreachable");

    fireEvent.click(screen.getByTestId("hard-restart"));

    expect(container.textContent).not.toContain("Dev server unreachable");
  });

  describe("slow-load and timeout escalation", () => {
    it("shows phase label and Still working hint after loading threshold", () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        webview.setMockLoading(true);
        emitWebviewEvent(webview, "did-start-loading");
      });

      expect(container.textContent).not.toContain("Loading preview");

      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(container.textContent).toContain("Loading preview");

      act(() => {
        vi.advanceTimersByTime(6000);
      });

      expect(container.textContent).toContain("Still working");
    });

    it("Cancel appears after action threshold and stops the webview", () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        webview.setMockLoading(true);
        emitWebviewEvent(webview, "did-start-loading");
      });

      act(() => {
        vi.advanceTimersByTime(500);
      });

      act(() => {
        vi.advanceTimersByTime(16000);
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
    });

    it("timeout calls webview.stop() instead of reload", () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
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

    it("Retry from timeout clears error and loads current URL", () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
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

    it("clears slow timer when did-fail-load fires", () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
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

    it("shows DNS failure for -105 in webviewLoadError", () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
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

    it("shows no-internet for -106 in webviewLoadError", () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
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

    it("retry-exhausted error includes URL", () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      for (let i = 0; i < 6; i++) {
        act(() => {
          emitWebviewEvent(webview, "did-fail-load", {
            errorCode: -102,
            errorDescription: "ERR_CONNECTION_REFUSED",
            isMainFrame: true,
            validatedURL: "http://localhost:5173/",
          });
        });
        if (i < 5) {
          act(() => {
            vi.advanceTimersByTime(Math.min(500 * 2 ** i, 8000));
          });
        }
      }

      expect(container.textContent).toContain("localhost:5173");
    });

    it("cleans slow timer on unmount", () => {
      const { container, unmount } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        webview.setMockLoading(true);
        emitWebviewEvent(webview, "did-start-loading");
      });

      unmount();

      act(() => {
        vi.advanceTimersByTime(5000);
      });

      expect(container.textContent).not.toContain("Taking longer than usual");
    });
  });
});
