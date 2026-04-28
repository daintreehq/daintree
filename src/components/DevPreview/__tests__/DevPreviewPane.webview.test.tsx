// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { DevPreviewPaneProps } from "../DevPreviewPane";
import { DevPreviewPane } from "../DevPreviewPane";

type MockWebviewElement = HTMLElement & {
  reload: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  setZoomFactor: ReturnType<typeof vi.fn>;
  getURL: ReturnType<typeof vi.fn>;
  isLoading: ReturnType<typeof vi.fn>;
  executeJavaScript: ReturnType<typeof vi.fn>;
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
  webview.executeJavaScript = vi.fn().mockResolvedValue(0);
  webview.setMockLoading = (value: boolean) => {
    loading = value;
  };

  return webview;
}

type DevServerState = {
  status: "stopped" | "starting" | "installing" | "running" | "error";
  url: string | null;
  terminalId: string | null;
  error: { type: "unknown" | "port-conflict" | "missing-dependencies"; message: string } | null;
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
    getTerminal: vi.fn(),
    setBrowserUrl: vi.fn(),
    setBrowserHistory: vi.fn(),
    setBrowserZoom: vi.fn(),
    setDevPreviewConsoleOpen: vi.fn(),
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

vi.mock("@/components/DevPreview/ConsoleDrawer", () => ({
  ConsoleDrawer: ({ onHardRestart }: { onHardRestart?: () => void }) => (
    <button
      type="button"
      data-testid="hard-restart"
      onClick={() => onHardRestart?.()}
      aria-label="hard-restart"
    >
      Hard restart
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

    expect(webview.reload).toHaveBeenCalledTimes(1);
  });

  it("reloads webview when loading remains stuck for 30s", () => {
    const { container } = render(<DevPreviewPane {...baseProps} />);
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

  it("clears stuck-load timeout when loading fails", () => {
    const { container } = render(<DevPreviewPane {...baseProps} />);
    const webview = getWebviewElement(container);

    act(() => {
      webview.setMockLoading(true);
      emitWebviewEvent(webview, "did-start-loading");
      emitWebviewEvent(webview, "did-fail-load", {
        errorCode: -105,
      });
    });

    act(() => {
      vi.advanceTimersByTime(30000);
    });

    expect(webview.reload).not.toHaveBeenCalled();
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
    expect(devServerStateRef.current.restart).toHaveBeenCalledTimes(1);
    expect(terminalStoreState.setBrowserUrl).toHaveBeenCalledWith("dev-preview-panel-1", "");
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

    // Should NOT reload at 30s
    act(() => {
      vi.advanceTimersByTime(30000);
    });
    expect(webview.reload).not.toHaveBeenCalled();

    // Should reload at 60s
    act(() => {
      vi.advanceTimersByTime(30000);
    });
    expect(webview.reload).toHaveBeenCalledTimes(1);

    if (origSettings) useProjectSettingsStoreMock.mockImplementation(origSettings);
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

    expect(container.textContent).toContain("Dev Server Unreachable");
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

    expect(container.textContent).toContain("Dev Server Unreachable");

    fireEvent.click(screen.getByTestId("hard-restart"));

    expect(container.textContent).not.toContain("Dev Server Unreachable");
  });
});
