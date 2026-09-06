// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { DevPreviewPaneProps } from "../DevPreviewPane";
import { DevPreviewPane } from "../DevPreviewPane";
import { projectClient } from "@/clients";
import { actionService } from "@/services/ActionService";
import {
  buildDevPreviewProxyOrigin,
  DEV_PREVIEW_PROXY_STATUS_TEXT,
} from "@shared/utils/devPreviewProxy";
import type { NormalizeResult } from "@shared/utils/urlUtils";

const notifyMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/notify", () => ({
  notify: (args: unknown) => notifyMock(args),
}));

/**
 * One entry per `<webview>` element React actually created. `srcWrites` are seed writes
 * (React setting the attribute); `loadURLs` are imperative navigations. The mock's
 * `loadURL` also writes `src`, so without separating the two by origin a test cannot
 * tell a fresh guest's seed from a corrective load — which is the exact distinction
 * #12297 turns on.
 */
type GuestRecord = { srcWrites: string[]; loadURLs: string[] };
const guestLog: GuestRecord[] = [];

type MockWebviewElement = HTMLElement & {
  reload: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  setZoomFactor: ReturnType<typeof vi.fn>;
  getURL: ReturnType<typeof vi.fn>;
  isLoading: ReturnType<typeof vi.fn>;
  executeJavaScript: ReturnType<typeof vi.fn>;
  getWebContentsId: ReturnType<typeof vi.fn>;
  capturePage: ReturnType<typeof vi.fn>;
  setMockLoading: (value: boolean) => void;
};

// Opt-in for the next guest to report a load already in flight, so the pane's
// mount-time readiness probe leaves it unready (#12296).
let nextWebviewStartsLoading = false;

function decorateWebviewElement(element: HTMLElement): MockWebviewElement {
  let currentUrl = element.getAttribute("src") ?? "http://localhost:5173/";
  let loading = nextWebviewStartsLoading;
  const webview = element as MockWebviewElement;

  const record: GuestRecord = { srcWrites: [], loadURLs: [] };
  guestLog.push(record);
  let inLoadURL = false;
  const setAttributeDirect = element.setAttribute.bind(element);
  element.setAttribute = (name: string, value: string) => {
    if (name === "src" && !inLoadURL) record.srcWrites.push(value);
    setAttributeDirect(name, value);
  };

  const syncUrlFromAttribute = () => {
    const src = element.getAttribute("src");
    if (typeof src === "string" && src.length > 0) {
      currentUrl = src;
    }
  };

  webview.reload = vi.fn();
  webview.stop = vi.fn();
  webview.loadURL = vi.fn((url: string) => {
    record.loadURLs.push(url);
    currentUrl = url;
    inLoadURL = true;
    try {
      element.setAttribute("src", url);
    } finally {
      inLoadURL = false;
    }
  });
  webview.setZoomFactor = vi.fn();
  webview.getURL = vi.fn(() => {
    syncUrlFromAttribute();
    return currentUrl;
  });
  webview.isLoading = vi.fn(() => loading);
  webview.executeJavaScript = vi.fn().mockResolvedValue(0);
  webview.getWebContentsId = vi.fn(() => 42);
  webview.capturePage = vi.fn(() =>
    Promise.resolve({ toPNG: () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]) })
  );
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
  stop: ReturnType<typeof vi.fn>;
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
      stop: vi.fn(),
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

const { saveSettingsMock, projectClientGetSettingsMock } = vi.hoisted(() => {
  const saveSettingsMock = vi.fn().mockResolvedValue(undefined);
  const projectClientGetSettingsMock = vi.fn().mockResolvedValue({
    devServerCommand: "npm run dev",
    devServerAutoDetected: true,
    devServerDismissed: false,
    turbopackEnabled: true,
  });
  return { saveSettingsMock, projectClientGetSettingsMock };
});

vi.mock("@/hooks/useProjectSettings", () => ({
  useProjectSettings: () => ({
    saveSettings: saveSettingsMock,
    settings: null,
    detectedRunners: [],
    allDetectedRunners: [],
    isLoading: false,
    error: null,
    promoteToSaved: vi.fn().mockResolvedValue(undefined),
    removeFromSaved: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("@/clients", () => ({
  projectClient: {
    getSettings: projectClientGetSettingsMock,
    detectRunners: vi.fn().mockResolvedValue([]),
  },
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

// The props the tests actually read, named so recording them needs no type assertion.
// The index signature keeps every other prop flowing through untyped, as before.
type MockToolbarProps = {
  onNavigate: (url: string) => void;
  validateUrl?: (url: string) => NormalizeResult;
  onPromoteToPortal?: () => void;
  onCaptureScreenshot: () => Promise<boolean>;
} & Record<string, unknown>;

const { browserToolbarPropsSpy } = vi.hoisted(() => ({
  browserToolbarPropsSpy: vi.fn<(props: MockToolbarProps) => void>(),
}));
vi.mock("@/components/Browser/BrowserToolbar", () => ({
  BrowserToolbar: (props: MockToolbarProps) => {
    browserToolbarPropsSpy(props);
    return <div data-testid="browser-toolbar" />;
  },
}));

function latestToolbarProps(): MockToolbarProps {
  const call = browserToolbarPropsSpy.mock.calls.at(-1);
  if (!call) throw new Error("Expected BrowserToolbar to have rendered");
  return call[0];
}

const headerContentPointerDownSpy = vi.hoisted(() => vi.fn());

vi.mock("@/components/Panel", () => ({
  ContentPanel: ({
    children,
    headerContent,
  }: {
    children: React.ReactNode;
    headerContent?: React.ReactNode;
  }) => (
    <div data-testid="content-panel">
      {headerContent && (
        <div data-testid="panel-header-content" onPointerDown={headerContentPointerDownSpy}>
          {headerContent}
        </div>
      )}
      {children}
    </div>
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

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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

// The mocked `window.electron` needs a cast to be reachable at all; doing it once
// here keeps it out of every individual test.
function getElectronMock(): { webview: Record<string, unknown> } {
  return (window as unknown as { electron: { webview: Record<string, unknown> } }).electron;
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
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    scrollPositionRef.current = undefined;
    guestLog.length = 0;
    originalCreateElement = document.createElement.bind(document);
    document.createElement = ((tagName: string, options?: ElementCreationOptions) => {
      const element = originalCreateElement(tagName, options);
      if (String(tagName).toLowerCase() === "webview") {
        return decorateWebviewElement(element as HTMLElement);
      }
      return element;
    }) as typeof document.createElement;
    terminalStoreState.getTerminal.mockImplementation(() => ({
      kind: "dev-preview",
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
      stop: vi.fn(),
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
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
        writeImage: vi.fn().mockResolvedValue(undefined),
      },
      webview: {
        registerPanel: vi.fn(() => Promise.resolve()),
        onDialogRequest: vi.fn(() => vi.fn()),
        onFindShortcut: vi.fn(() => vi.fn()),
        onReloadShortcut: vi.fn(() => vi.fn()),
        onCloseShortcut: vi.fn(() => vi.fn()),
        onNavigationBlocked: vi.fn(() => vi.fn()),
        onOAuthLoopbackStatus: vi.fn(() => vi.fn()),
        setLifecycleState: vi.fn().mockResolvedValue(undefined),
        getScrollPosition: vi.fn().mockResolvedValue(0),
        startConsoleCapture: vi.fn(() => Promise.resolve()),
        stopConsoleCapture: vi.fn(() => Promise.resolve()),
        onConsoleMessage: vi.fn(() => vi.fn()),
        onConsoleContextCleared: vi.fn(() => vi.fn()),
        reloadIgnoringCache: vi.fn(() => Promise.resolve()),
        setDeviceEmulation: vi.fn(() => Promise.resolve({ applied: true })),
        onUnresponsive: vi.fn(() => vi.fn()),
        onResponsive: vi.fn(() => vi.fn()),
      },
    };
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

  it("hard-reloads the focused webview guest when onReloadShortcut fires for this panel (#9497)", async () => {
    let reloadCb: ((payload: { panelId: string }) => void) | undefined;
    const electron = getElectronMock();
    electron.webview.onReloadShortcut = vi.fn((cb: (payload: { panelId: string }) => void) => {
      reloadCb = cb;
      return vi.fn();
    });
    const reloadIgnoringCache = electron.webview.reloadIgnoringCache as ReturnType<typeof vi.fn>;

    const { container } = render(<DevPreviewPane {...baseProps} />);
    getWebviewElement(container);
    await act(async () => {
      await Promise.resolve();
    });

    expect(reloadCb).toBeDefined();

    // A shortcut targeting a different panel must not reload this one
    act(() => {
      reloadCb?.({ panelId: "some-other-panel" });
    });
    expect(reloadIgnoringCache).not.toHaveBeenCalled();

    // A shortcut targeting this panel triggers a cache-ignoring reload
    act(() => {
      reloadCb?.({ panelId: "dev-preview-panel-1" });
    });
    expect(reloadIgnoringCache).toHaveBeenCalledWith(42, "dev-preview-panel-1");
  });

  it("unsubscribes from onReloadShortcut on unmount (#9497)", () => {
    const unsubscribe = vi.fn();
    const electron = getElectronMock();
    electron.webview.onReloadShortcut = vi.fn(() => unsubscribe);

    const { unmount } = render(<DevPreviewPane {...baseProps} />);
    expect(electron.webview.onReloadShortcut).toHaveBeenCalled();
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("closes this panel when onCloseShortcut fires for it, and ignores other panels (#10859)", async () => {
    let closeCb: ((payload: { panelId: string }) => void) | undefined;
    const electron = getElectronMock();
    electron.webview.onCloseShortcut = vi.fn((cb: (payload: { panelId: string }) => void) => {
      closeCb = cb;
      return vi.fn();
    });
    const dispatchSpy = vi
      .spyOn(actionService, "dispatch")
      .mockResolvedValue({ ok: true } as Awaited<ReturnType<typeof actionService.dispatch>>);

    render(<DevPreviewPane {...baseProps} />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(closeCb).toBeDefined();

    // A shortcut targeting a different panel must not close this one
    act(() => {
      closeCb?.({ panelId: "some-other-panel" });
    });
    expect(dispatchSpy).not.toHaveBeenCalled();

    // A shortcut targeting this panel closes exactly this panel by id
    act(() => {
      closeCb?.({ panelId: "dev-preview-panel-1" });
    });
    expect(dispatchSpy).toHaveBeenCalledWith(
      "terminal.close",
      { terminalId: "dev-preview-panel-1" },
      { source: "keybinding" }
    );
  });

  it("unsubscribes from onCloseShortcut on unmount (#10859)", () => {
    const unsubscribe = vi.fn();
    const electron = getElectronMock();
    electron.webview.onCloseShortcut = vi.fn(() => unsubscribe);

    const { unmount } = render(<DevPreviewPane {...baseProps} />);
    expect(electron.webview.onCloseShortcut).toHaveBeenCalled();
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("binds loading listeners when webview mounts after initial waiting state", async () => {
    terminalStoreState.getTerminal.mockImplementation(() => ({
      kind: "dev-preview",
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
      stop: vi.fn(),
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
        kind: "dev-preview",
        id: "dev-preview-panel-1",
        browserHistory: { past: [], present: "http://localhost:5173/", future: [] },
        browserZoom: 1.4,
        devPreviewConsoleOpen: false,
        devCommand: "npm run dev",
        viewportPreset: preset,
      }));
    };

    // Emulation is a main-process IPC call keyed by the guest's webContents id.
    // The webview tag has no getWebContents(); mocking one is what made the
    // broken renderer-side path look tested (#12298).
    type EmulationPayload = { webContentsId: number; panelId: string; emulation: unknown };
    const setDeviceEmulationMock = () =>
      (window as unknown as { electron: { webview: { setDeviceEmulation: unknown } } }).electron
        .webview.setDeviceEmulation as unknown as {
        mock: { calls: Array<[EmulationPayload]> };
        mockClear: () => void;
      };
    const emulationCalls = (): EmulationPayload[] =>
      setDeviceEmulationMock().mock.calls.map(([payload]) => payload);

    it("applies device emulation for the active preset without reloading the page", async () => {
      withPreset("iphone");
      const { container } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      await act(async () => {
        await Promise.resolve();
      });

      expect(emulationCalls()).toContainEqual({
        webContentsId: 42,
        panelId: "dev-preview-panel-1",
        emulation: {
          params: {
            screenPosition: "mobile",
            screenSize: { width: 393, height: 852 },
            viewPosition: { x: 0, y: 0 },
            deviceScaleFactor: 1,
            viewSize: { width: 393, height: 852 },
            scale: 1,
          },
          userAgent: expect.stringContaining("iPhone"),
          touch: true,
        },
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

      setDeviceEmulationMock().mockClear();

      act(() => {
        emitWebviewEvent(webview, "did-finish-load");
      });
      await act(async () => {
        await Promise.resolve();
      });

      const firstCall = emulationCalls()[0];
      if (!firstCall) throw new Error("expected a device-emulation call");
      expect((firstCall.emulation as { params: unknown }).params).toEqual({
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

      setDeviceEmulationMock().mockClear();
      withPreset(undefined);
      rerender(<DevPreviewPane {...baseProps} />);

      await act(async () => {
        await Promise.resolve();
      });

      expect(emulationCalls()).toContainEqual({
        webContentsId: 42,
        panelId: "dev-preview-panel-1",
        emulation: null,
      });
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

    // The retry issues its own load, so the real sequence carries a load start
    // before the successful finish. Without it the failure latch from the first
    // did-fail-load would still be up and did-finish-load would (correctly) refuse
    // to treat this as a successful load.
    act(() => {
      emitWebviewEvent(webview, "did-start-loading");
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
        onReloadShortcut: vi.fn(() => vi.fn()),
        onCloseShortcut: vi.fn(() => vi.fn()),
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
        onReloadShortcut: vi.fn(() => vi.fn()),
        onCloseShortcut: vi.fn(() => vi.fn()),
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

  it("does not persist a failed CDP scroll read (null sentinel)", async () => {
    // handleGetScrollPosition answers `null` when it could not read at all, and
    // only then must the prior stored position survive. A genuine 0 is a real
    // position and is covered by the sibling test below (#12298).
    const getScrollPosition = vi.fn().mockResolvedValue(null);
    (window as unknown as { electron: Record<string, unknown> }).electron = {
      system: { openExternal: vi.fn() },
      window: { onDestroyHiddenWebviews: vi.fn(() => vi.fn()) },
      webview: {
        registerPanel: vi.fn(() => Promise.resolve()),
        onDialogRequest: vi.fn(() => vi.fn()),
        onFindShortcut: vi.fn(() => vi.fn()),
        onReloadShortcut: vi.fn(() => vi.fn()),
        onCloseShortcut: vi.fn(() => vi.fn()),
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

  it("persists a successful scrollY=0 so a return to the top overwrites a stale offset", async () => {
    const getScrollPosition = vi.fn().mockResolvedValue(0);
    (window as unknown as { electron: Record<string, unknown> }).electron = {
      system: { openExternal: vi.fn() },
      window: { onDestroyHiddenWebviews: vi.fn(() => vi.fn()) },
      webview: {
        registerPanel: vi.fn(() => Promise.resolve()),
        onDialogRequest: vi.fn(() => vi.fn()),
        onFindShortcut: vi.fn(() => vi.fn()),
        onReloadShortcut: vi.fn(() => vi.fn()),
        onCloseShortcut: vi.fn(() => vi.fn()),
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

    expect(terminalStoreState.setDevPreviewScrollPosition).toHaveBeenCalledWith(
      "dev-preview-panel-1",
      { url: "http://localhost:5173/", scrollY: 0 }
    );
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
      kind: "dev-preview",
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
    it("shows the phase label and escalation hint after the loading threshold", () => {
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
      // The escalation hint stays hidden until the first threshold (8s).
      expect(container.querySelector(".animate-hint-fade-in")).toBeNull();

      act(() => {
        vi.advanceTimersByTime(8000);
      });

      // The hint surfaces and names the current phase via its message prop,
      // rather than the generic "Still working…" copy.
      const hint = container.querySelector(".animate-hint-fade-in");
      expect(hint).not.toBeNull();
      expect(hint?.textContent).toContain("Loading preview");
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

    it("surfaces ERR_FILE_NOT_FOUND (-6) as a load failure", () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitWebviewEvent(webview, "did-fail-load", {
          errorCode: -6,
          errorDescription: "ERR_FILE_NOT_FOUND",
          isMainFrame: true,
          validatedURL: "http://localhost:5173/missing",
        });
      });

      expect(container.textContent).toContain("Page load failed");
      expect(container.textContent).toContain("ERR_FILE_NOT_FOUND");
    });

    it("cancels pending connection-refused retry when ERR_FILE_NOT_FOUND arrives", () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      // Fire a connection-refused to schedule a retry at 500ms
      act(() => {
        emitWebviewEvent(webview, "did-fail-load", {
          errorCode: -102,
          errorDescription: "ERR_CONNECTION_REFUSED",
          isMainFrame: true,
          validatedURL: "http://localhost:5173/",
        });
      });

      // Before the retry fires, a file-not-found error arrives
      act(() => {
        emitWebviewEvent(webview, "did-fail-load", {
          errorCode: -6,
          errorDescription: "ERR_FILE_NOT_FOUND",
          isMainFrame: true,
          validatedURL: "http://localhost:5173/missing",
        });
      });

      // Advance past the retry timeout
      act(() => {
        vi.advanceTimersByTime(1000);
      });

      // The stale retry must NOT have called loadURL
      expect(webview.loadURL).not.toHaveBeenCalled();
      // Failure overlay must be visible
      expect(container.textContent).toContain("Page load failed");
      expect(container.textContent).toContain("ERR_FILE_NOT_FOUND");
    });

    it("ignores subframe ERR_FILE_NOT_FOUND failures", () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitWebviewEvent(webview, "did-fail-load", {
          errorCode: -6,
          errorDescription: "ERR_FILE_NOT_FOUND",
          isMainFrame: false,
          validatedURL: "http://localhost:5173/iframe-asset",
        });
      });

      expect(container.textContent).not.toContain("Page load failed");
    });

    it("falls back to the numeric error code when errorDescription is empty", () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitWebviewEvent(webview, "did-fail-load", {
          errorCode: -6,
          errorDescription: "",
          isMainFrame: true,
          validatedURL: "http://localhost:5173/missing",
        });
      });

      expect(container.textContent).toContain("Page load failed");
      expect(container.textContent).toContain("Error code -6");
    });

    it("does not schedule a retry for ERR_FILE_NOT_FOUND", () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitWebviewEvent(webview, "did-fail-load", {
          errorCode: -6,
          errorDescription: "ERR_FILE_NOT_FOUND",
          isMainFrame: true,
          validatedURL: "http://localhost:5173/missing",
        });
      });

      // Advance beyond every backoff window
      act(() => {
        vi.advanceTimersByTime(8000);
      });

      expect(webview.loadURL).not.toHaveBeenCalled();
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

    it("shows certificate error overlay for ERR_CERT_AUTHORITY_INVALID (-202)", () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
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
      expect(container.textContent).toContain("localhost:8443");
      // Should NOT enter the connection-refused retry loop
      expect(container.textContent).not.toContain("Reconnecting");
    });

    it("copy button calls clipboard.writeText for cert errors", () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitWebviewEvent(webview, "did-fail-load", {
          errorCode: -202,
          errorDescription: "ERR_CERT_AUTHORITY_INVALID",
          isMainFrame: true,
          validatedURL: "https://localhost:8443/",
        });
      });

      // Find the copy button by its text content
      const buttons = Array.from(container.querySelectorAll("button"));
      const mkcertButton = buttons.find((btn) => btn.textContent?.includes("mkcert -install"));
      expect(mkcertButton).toBeTruthy();

      act(() => {
        mkcertButton!.click();
      });

      const electron = (window as unknown as { electron: Record<string, unknown> }).electron;
      const clipboard = electron.clipboard as { writeText: ReturnType<typeof vi.fn> };
      expect(clipboard.writeText).toHaveBeenCalledWith("mkcert -install");
    });

    it("shows SSL/TLS handshake message for ERR_SSL_PROTOCOL_ERROR (-107)", () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
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
      // -107 is also raised on protocol mismatch — the mkcert hint is wrong here
      expect(container.textContent).not.toContain("mkcert");
      // Should NOT enter the connection-refused retry loop
      expect(container.textContent).not.toContain("Reconnecting");
    });

    it("classifies -200 (cert range boundary) as cert error", () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitWebviewEvent(webview, "did-fail-load", {
          errorCode: -200,
          errorDescription: "ERR_CERT_COMMON_NAME_INVALID",
          isMainFrame: true,
          validatedURL: "https://example.com/",
        });
      });

      expect(container.textContent).toContain("Certificate error");
      expect(container.textContent).toContain("mkcert -install");
    });

    it("cancels pending connection-refused retry when cert error arrives", () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      // Fire a connection-refused to schedule a retry at 500ms
      act(() => {
        emitWebviewEvent(webview, "did-fail-load", {
          errorCode: -102,
          errorDescription: "ERR_CONNECTION_REFUSED",
          isMainFrame: true,
          validatedURL: "http://localhost:5173/",
        });
      });

      // Before the retry fires, a cert error arrives
      act(() => {
        emitWebviewEvent(webview, "did-fail-load", {
          errorCode: -202,
          errorDescription: "ERR_CERT_AUTHORITY_INVALID",
          isMainFrame: true,
          validatedURL: "https://localhost:8443/",
        });
      });

      // Advance past the retry timeout
      act(() => {
        vi.advanceTimersByTime(1000);
      });

      // The stale retry must NOT have called loadURL
      expect(webview.loadURL).not.toHaveBeenCalled();
      // Cert error overlay must be visible
      expect(container.textContent).toContain("Certificate error");
    });

    it("classifies -299 (cert range lower bound) as cert, -199 and -300 fall through", () => {
      const { container: c1 } = render(<DevPreviewPane {...baseProps} />);
      const w1 = getWebviewElement(c1);
      act(() => {
        emitWebviewEvent(w1, "did-fail-load", {
          errorCode: -299,
          errorDescription: "ERR_CERT_VALIDITY_TOO_LONG",
          isMainFrame: true,
          validatedURL: "https://example.com/",
        });
      });
      expect(c1.textContent).toContain("Certificate error");

      const { container: c2 } = render(<DevPreviewPane {...baseProps} />);
      const w2 = getWebviewElement(c2);
      act(() => {
        emitWebviewEvent(w2, "did-fail-load", {
          errorCode: -199,
          errorDescription: "ERR_CERT_END",
          isMainFrame: true,
          validatedURL: "https://example.com/",
        });
      });
      expect(c2.textContent).toContain("Page load failed");
      expect(c2.textContent).not.toContain("mkcert");

      const { container: c3 } = render(<DevPreviewPane {...baseProps} />);
      const w3 = getWebviewElement(c3);
      act(() => {
        emitWebviewEvent(w3, "did-fail-load", {
          errorCode: -300,
          errorDescription: "ERR_CERT_START",
          isMainFrame: true,
          validatedURL: "https://example.com/",
        });
      });
      expect(c3.textContent).toContain("Page load failed");
      expect(c3.textContent).not.toContain("mkcert");
    });

    it("shows Copied feedback on mkcert copy button click", async () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitWebviewEvent(webview, "did-fail-load", {
          errorCode: -202,
          errorDescription: "ERR_CERT_AUTHORITY_INVALID",
          isMainFrame: true,
          validatedURL: "https://localhost:8443/",
        });
      });

      const buttons = Array.from(container.querySelectorAll("button"));
      const mkcertButton = buttons.find((btn) => btn.textContent?.includes("mkcert -install"));
      expect(mkcertButton).toBeTruthy();

      await act(async () => {
        mkcertButton!.click();
        // Flush the microtask from the async clipboard handler
        await Promise.resolve();
      });

      expect(mkcertButton!.textContent).toContain("Copied");

      act(() => {
        vi.advanceTimersByTime(2500);
      });

      expect(mkcertButton!.textContent).toContain("mkcert -install");
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

  // #11114: the hook now exposes promotion failures; this covers the pane
  // actually rendering them, which is the half the hook's own tests can't see.
  describe("promote-to-portal failure banner (#11114)", () => {
    type DispatchResult = Awaited<ReturnType<typeof actionService.dispatch>>;
    const succeeded = (): DispatchResult => ({ ok: true, result: undefined });
    const failed = (message: string): DispatchResult => ({
      ok: false,
      error: { code: "EXECUTION_ERROR", message },
    });

    const getPromoteHandler = () => latestToolbarProps().onPromoteToPortal;

    it("renders the dispatch failure reason inline, without a global toast", async () => {
      const message = "Portal is already showing this URL";
      vi.spyOn(actionService, "dispatch").mockResolvedValue(failed(message));

      const { container } = render(<DevPreviewPane {...baseProps} />);
      const promote = getPromoteHandler();
      expect(promote).toBeDefined();

      await act(async () => {
        promote!();
      });

      expect(container.textContent).toContain(message);
      // Tier 3 is pane-local — the failure must not also fire a toast.
      expect(notifyMock).not.toHaveBeenCalled();
    });

    it("removes the banner once a retry succeeds", async () => {
      const message = "Portal promotion failed";
      const dispatchSpy = vi.spyOn(actionService, "dispatch").mockResolvedValue(failed(message));

      const { container } = render(<DevPreviewPane {...baseProps} />);
      await act(async () => {
        getPromoteHandler()!();
      });
      expect(container.textContent).toContain(message);

      dispatchSpy.mockResolvedValue(succeeded());
      const retry = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Retry")
      );
      expect(retry).toBeDefined();

      await act(async () => {
        retry!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      // Retry must re-run the action, not merely dismiss the banner.
      expect(dispatchSpy).toHaveBeenCalledTimes(2);
      expect(dispatchSpy).toHaveBeenLastCalledWith(
        "devPreview.promoteToPortal",
        expect.objectContaining({ panelId: "dev-preview-panel-1" }),
        { source: "user" }
      );
      expect(container.textContent).not.toContain(message);
    });
  });

  describe("screenshot capture", () => {
    const getToolbarCapture = () => latestToolbarProps().onCaptureScreenshot;

    const getWriteImageMock = () => {
      const electron = (window as unknown as { electron: { clipboard: Record<string, unknown> } })
        .electron;
      return electron.clipboard.writeImage as ReturnType<typeof vi.fn>;
    };

    it("resolves true after a successful capture and clipboard write", async () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitWebviewEvent(webview, "dom-ready");
      });

      let result: boolean | undefined;
      await act(async () => {
        result = await getToolbarCapture()();
      });

      expect(result).toBe(true);
      expect(getWriteImageMock()).toHaveBeenCalledTimes(1);
      expect(getWriteImageMock().mock.calls[0]![0]).toBeInstanceOf(Uint8Array);
      expect(notifyMock).not.toHaveBeenCalled();
    });

    it("resolves false without notifying when the URL is about:blank", async () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
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
      expect(getWriteImageMock()).not.toHaveBeenCalled();
      expect(notifyMock).not.toHaveBeenCalled();
    });

    it("resolves false and notifies when the clipboard write fails", async () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitWebviewEvent(webview, "dom-ready");
      });

      getWriteImageMock().mockRejectedValueOnce(new Error("clipboard unavailable"));

      let result: boolean | undefined;
      await act(async () => {
        result = await getToolbarCapture()();
      });

      expect(result).toBe(false);
      expect(notifyMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error", title: "Screenshot failed" })
      );
    });

    it("resolves false and notifies when capturePage rejects", async () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
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
      expect(getWriteImageMock()).not.toHaveBeenCalled();
    });

    it("resolves false for a second capture while the first is still in flight", async () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
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
      expect(getWriteImageMock()).toHaveBeenCalledTimes(1);
    });
  });

  describe("crash-loop notification", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      notifyMock.mockClear();
    });

    it("does not notify on the first crash", () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitWebviewEvent(webview, "render-process-gone", {
          details: { reason: "crashed", exitCode: 1 },
        });
      });

      expect(notifyMock).not.toHaveBeenCalled();
    });

    it("notifies on the second crash within 60 seconds", () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitWebviewEvent(webview, "render-process-gone", {
          details: { reason: "crashed", exitCode: 1 },
        });
      });

      act(() => {
        emitWebviewEvent(webview, "render-process-gone", {
          details: { reason: "crashed", exitCode: 1 },
        });
      });

      expect(notifyMock).toHaveBeenCalledTimes(1);
      expect(notifyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          title: "Preview process crashed repeatedly",
          priority: "high",
          duration: 0,
          supersedeKey: "dev-preview-crash-loop:dev-preview-panel-1",
          correlationId: "dev-preview-panel-1",
          context: expect.objectContaining({
            eventKind: "recovery",
            panelId: "dev-preview-panel-1",
          }),
        })
      );
    });

    it("does not notify on second crash when outside 60-second window", () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitWebviewEvent(webview, "render-process-gone", {
          details: { reason: "crashed", exitCode: 1 },
        });
      });

      act(() => {
        vi.advanceTimersByTime(61_000);
      });

      act(() => {
        emitWebviewEvent(webview, "render-process-gone", {
          details: { reason: "crashed", exitCode: 1 },
        });
      });

      expect(notifyMock).not.toHaveBeenCalled();
    });

    it("notifies on third and subsequent crashes with the same supersedeKey", () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitWebviewEvent(webview, "render-process-gone", {
          details: { reason: "crashed", exitCode: 1 },
        });
      });

      act(() => {
        emitWebviewEvent(webview, "render-process-gone", {
          details: { reason: "crashed", exitCode: 1 },
        });
      });

      act(() => {
        emitWebviewEvent(webview, "render-process-gone", {
          details: { reason: "crashed", exitCode: 1 },
        });
      });

      expect(notifyMock).toHaveBeenCalledTimes(2);
      expect(notifyMock.mock.calls[0]![0]!.supersedeKey).toBe(
        "dev-preview-crash-loop:dev-preview-panel-1"
      );
      expect(notifyMock.mock.calls[1]![0]!.supersedeKey).toBe(
        "dev-preview-crash-loop:dev-preview-panel-1"
      );
    });

    it("filters clean-exit events", () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitWebviewEvent(webview, "render-process-gone", {
          details: { reason: "clean-exit", exitCode: 0 },
        });
      });

      expect(notifyMock).not.toHaveBeenCalled();
    });
  });

  describe("crash banner persistence (#10363)", () => {
    it("keeps the crash banner visible while the URL is unchanged", () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitWebviewEvent(webview, "render-process-gone", {
          details: { reason: "crashed", exitCode: 1 },
        });
      });

      // The clearing effect must not self-reset crash state while currentUrl
      // is unchanged — the banner has to survive the post-crash render flush
      // so its Reload / Hard restart actions stay reachable.
      expect(container.textContent).toContain("Preview process crashed");
      expect(container.textContent).toContain("Reason: crashed (exit code 1)");
    });

    it("keeps the unresponsive banner visible while the URL is unchanged", () => {
      let unresponsiveCb: ((data: { panelId: string }) => void) | undefined;
      const electron = getElectronMock();
      electron.webview.onUnresponsive = vi.fn((cb: (data: { panelId: string }) => void) => {
        unresponsiveCb = cb;
        return vi.fn();
      });

      const { container } = render(<DevPreviewPane {...baseProps} />);
      getWebviewElement(container);

      expect(unresponsiveCb).toBeDefined();

      act(() => {
        unresponsiveCb?.({ panelId: "dev-preview-panel-1" });
      });

      expect(container.textContent).toContain("Preview is not responding");
    });

    it("clears the unresponsive banner when the guest becomes responsive again", () => {
      let unresponsiveCb: ((data: { panelId: string }) => void) | undefined;
      let responsiveCb: ((data: { panelId: string }) => void) | undefined;
      const electron = getElectronMock();
      electron.webview.onUnresponsive = vi.fn((cb: (data: { panelId: string }) => void) => {
        unresponsiveCb = cb;
        return vi.fn();
      });
      electron.webview.onResponsive = vi.fn((cb: (data: { panelId: string }) => void) => {
        responsiveCb = cb;
        return vi.fn();
      });

      const { container } = render(<DevPreviewPane {...baseProps} />);
      getWebviewElement(container);

      act(() => {
        unresponsiveCb?.({ panelId: "dev-preview-panel-1" });
      });
      expect(container.textContent).toContain("Preview is not responding");

      act(() => {
        responsiveCb?.({ panelId: "dev-preview-panel-1" });
      });
      expect(container.textContent).not.toContain("Preview is not responding");
    });

    it("does not clear a crashed banner when a stale responsive event arrives", () => {
      let responsiveCb: ((data: { panelId: string }) => void) | undefined;
      const electron = getElectronMock();
      electron.webview.onResponsive = vi.fn((cb: (data: { panelId: string }) => void) => {
        responsiveCb = cb;
        return vi.fn();
      });

      const { container } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitWebviewEvent(webview, "render-process-gone", {
          details: { reason: "crashed", exitCode: 1 },
        });
      });

      act(() => {
        responsiveCb?.({ panelId: "dev-preview-panel-1" });
      });
      expect(container.textContent).toContain("Preview process crashed");
    });

    it("ignores unresponsive events targeting a different panel", () => {
      let unresponsiveCb: ((data: { panelId: string }) => void) | undefined;
      const electron = getElectronMock();
      electron.webview.onUnresponsive = vi.fn((cb: (data: { panelId: string }) => void) => {
        unresponsiveCb = cb;
        return vi.fn();
      });

      const { container } = render(<DevPreviewPane {...baseProps} />);
      getWebviewElement(container);

      act(() => {
        unresponsiveCb?.({ panelId: "some-other-panel" });
      });
      expect(container.textContent).not.toContain("Preview is not responding");
    });

    it("clears the crash banner on a confirmed navigation to a new URL", () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitWebviewEvent(webview, "render-process-gone", {
          details: { reason: "crashed", exitCode: 1 },
        });
      });
      expect(container.textContent).toContain("Preview process crashed");

      act(() => {
        emitWebviewEvent(webview, "did-navigate", { url: "http://localhost:5173/about" });
      });
      expect(container.textContent).not.toContain("Preview process crashed");
    });

    it("does not resurface a stale crash banner after eviction and restore", async () => {
      terminalStoreState.activeDockTerminalId = "dev-preview-panel-1";
      let destroyHandler: ((payload: { tier: 1 | 2 }) => void) | undefined;
      const electron = (window as unknown as { electron: { window: Record<string, unknown> } })
        .electron;
      electron.window.onDestroyHiddenWebviews = vi.fn(
        (handler: (payload: { tier: 1 | 2 }) => void) => {
          destroyHandler = handler;
          return vi.fn();
        }
      );

      const { container, rerender } = render(<DevPreviewPane {...baseProps} location="dock" />);
      const webview = getWebviewElement(container);
      await act(async () => {
        await Promise.resolve();
      });

      act(() => {
        emitWebviewEvent(webview, "render-process-gone", {
          details: { reason: "crashed", exitCode: 1 },
        });
      });
      expect(container.textContent).toContain("Preview process crashed");

      // Panel is no longer the active dock panel — eviction is now valid.
      terminalStoreState.activeDockTerminalId = "other-panel";
      rerender(<DevPreviewPane {...baseProps} location="dock" />);
      await act(async () => {
        destroyHandler?.({ tier: 1 });
        await Promise.resolve();
      });
      expect(container.textContent).not.toContain("Preview process crashed");

      // Reactivate the panel — eviction auto-clears and the webview remounts.
      terminalStoreState.activeDockTerminalId = "dev-preview-panel-1";
      rerender(<DevPreviewPane {...baseProps} location="dock" />);
      await act(async () => {
        await Promise.resolve();
      });
      expect(container.textContent).not.toContain("Preview process crashed");
    });
  });

  describe("header script picker", () => {
    beforeEach(() => {
      projectClientGetSettingsMock.mockResolvedValue({
        devServerCommand: "npm run dev",
        devServerAutoDetected: true,
        devServerDismissed: false,
        turbopackEnabled: true,
      });
      saveSettingsMock.mockResolvedValue(undefined);
      devServerStateRef.current.stop = vi.fn();
    });

    it("hidden when unconfigured (no devCommand)", () => {
      terminalStoreState.getTerminal.mockImplementation(() => ({
        kind: "dev-preview",
        id: "dev-preview-panel-1",
        browserHistory: { past: [], present: "", future: [] },
        browserZoom: 1.0,
        devPreviewConsoleOpen: false,
      }));
      render(<DevPreviewPane {...baseProps} />);
      expect(screen.queryByTestId("panel-header-content")).toBeNull();
    });

    it("hidden when no candidates available", () => {
      render(<DevPreviewPane {...baseProps} />);
      expect(screen.queryByTestId("panel-header-content")).toBeNull();
    });

    it("visible when configured with candidates", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      useProjectSettingsStoreMock.mockImplementation((selector: (state: any) => unknown) => {
        const state = {
          projectId: "project-1",
          settings: {
            devServerCommand: "npm run dev",
            environmentVariables: { API_URL: "http://localhost:9000" },
            runCommands: [],
          },
          detectedRunners: [],
          allDetectedRunners: [
            { id: "r1", name: "Dev", command: "npm run dev", source: "package.json" as const },
            { id: "r2", name: "Start", command: "npm start", source: "package.json" as const },
          ],
          isLoading: false,
          error: null,
          loadSettings: vi.fn(),
          setSettings: vi.fn(),
        };
        return selector(state);
      });

      const { container } = render(<DevPreviewPane {...baseProps} />);
      expect(screen.getByTestId("panel-header-content")).toBeTruthy();
      expect(container.textContent).toContain("Dev");
    });

    it("shows raw command when no candidate matches", () => {
      terminalStoreState.getTerminal.mockImplementation(() => ({
        kind: "dev-preview",
        id: "dev-preview-panel-1",
        browserHistory: { past: [], present: "", future: [] },
        browserZoom: 1.0,
        devPreviewConsoleOpen: false,
        devCommand: "npm run custom",
        devPreviewScrollPosition: scrollPositionRef.current,
      }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      useProjectSettingsStoreMock.mockImplementation((selector: (state: any) => unknown) => {
        const state = {
          projectId: "project-1",
          settings: {
            devServerCommand: "npm run custom",
            environmentVariables: {},
            runCommands: [],
          },
          detectedRunners: [],
          allDetectedRunners: [
            { id: "r1", name: "Dev", command: "npm run dev", source: "package.json" as const },
          ],
          isLoading: false,
          error: null,
          loadSettings: vi.fn(),
          setSettings: vi.fn(),
        };
        return selector(state);
      });

      const { container } = render(<DevPreviewPane {...baseProps} />);
      expect(screen.getByTestId("panel-header-content")).toBeTruthy();
      expect(container.textContent).toContain("npm run custom");
    });

    it("does not propagate pointerdown from the trigger to header ancestors", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      useProjectSettingsStoreMock.mockImplementation((selector: (state: any) => unknown) => {
        const state = {
          projectId: "project-1",
          settings: {
            devServerCommand: "npm run dev",
            environmentVariables: {},
            runCommands: [],
          },
          detectedRunners: [],
          allDetectedRunners: [
            { id: "r1", name: "Dev", command: "npm run dev", source: "package.json" as const },
          ],
          isLoading: false,
          error: null,
          loadSettings: vi.fn(),
          setSettings: vi.fn(),
        };
        return selector(state);
      });

      render(<DevPreviewPane {...baseProps} />);
      headerContentPointerDownSpy.mockClear();
      const trigger = screen.getByLabelText("Switch dev script");
      fireEvent.pointerDown(trigger);
      expect(headerContentPointerDownSpy).not.toHaveBeenCalled();
    });
  });

  describe("auto-detected run button (#10419)", () => {
    const flushAutoDetect = async () => {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
    };

    type RunnerFixture = { id: string; name: string; command: string; source: "package.json" };

    const defaultRunners: RunnerFixture[] = [
      { id: "r1", name: "dev", command: "pnpm dev", source: "package.json" },
    ];

    const setSettingsStoreState = (devServerCommand: string, runners = defaultRunners) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      useProjectSettingsStoreMock.mockImplementation((selector: (state: any) => unknown) =>
        selector({
          projectId: "project-1",
          settings: {
            devServerCommand,
            environmentVariables: {},
            runCommands: [],
          },
          detectedRunners: [],
          allDetectedRunners: runners,
          isLoading: false,
          error: null,
          loadSettings: vi.fn(),
          setSettings: vi.fn(),
        })
      );
    };

    beforeEach(() => {
      terminalStoreState.getTerminal.mockImplementation(() => ({
        kind: "dev-preview",
        id: "dev-preview-panel-1",
        browserHistory: { past: [], present: "", future: [] },
        browserZoom: 1.0,
        devPreviewConsoleOpen: false,
        devCommand: "",
      }));
      setSettingsStoreState("");
      devServerStateRef.current = {
        ...devServerStateRef.current,
        status: "stopped",
        url: null,
      };
      projectClientGetSettingsMock.mockResolvedValue({
        devServerCommand: "",
        devServerAutoDetected: false,
        devServerDismissed: false,
        turbopackEnabled: true,
      });
      saveSettingsMock.mockResolvedValue(undefined);
    });

    const getRunButton = () => screen.getByRole("button", { name: "Run `pnpm dev`" });

    it("saves the displayed candidate command without re-running detection", async () => {
      render(<DevPreviewPane {...baseProps} />);

      fireEvent.click(getRunButton());
      await flushAutoDetect();

      expect(saveSettingsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          devServerCommand: "pnpm dev",
          devServerAutoDetected: true,
          devServerDismissed: false,
        })
      );
      expect(vi.mocked(projectClient.detectRunners)).not.toHaveBeenCalled();
    });

    it("shows an inline error banner with a retry action when saving fails", async () => {
      saveSettingsMock.mockRejectedValueOnce(new Error("save failed"));
      render(<DevPreviewPane {...baseProps} />);

      fireEvent.click(getRunButton());
      await flushAutoDetect();

      expect(screen.getByText("Couldn't start preview")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    });

    it("shows the error banner when project settings cannot be loaded", async () => {
      projectClientGetSettingsMock.mockResolvedValueOnce(null);
      render(<DevPreviewPane {...baseProps} />);

      fireEvent.click(getRunButton());
      await flushAutoDetect();

      expect(saveSettingsMock).not.toHaveBeenCalled();
      expect(screen.getByText("Couldn't start preview")).toBeTruthy();
    });

    it("shows the error banner when loading settings rejects", async () => {
      projectClientGetSettingsMock.mockRejectedValueOnce(new Error("IPC failure"));
      render(<DevPreviewPane {...baseProps} />);

      fireEvent.click(getRunButton());
      await flushAutoDetect();

      expect(saveSettingsMock).not.toHaveBeenCalled();
      expect(screen.getByText("Couldn't start preview")).toBeTruthy();
    });

    it("clears the banner on retry and saves the same command", async () => {
      saveSettingsMock.mockRejectedValueOnce(new Error("save failed"));
      render(<DevPreviewPane {...baseProps} />);

      fireEvent.click(getRunButton());
      await flushAutoDetect();
      expect(screen.getByText("Couldn't start preview")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await flushAutoDetect();

      expect(screen.queryByText("Couldn't start preview")).toBeNull();
      expect(saveSettingsMock).toHaveBeenCalledTimes(2);
      expect(saveSettingsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ devServerCommand: "pnpm dev" })
      );
    });

    it("retries the alternate command that failed, not the primary candidate", async () => {
      setSettingsStoreState("", [
        { id: "r1", name: "dev", command: "pnpm dev", source: "package.json" },
        { id: "r2", name: "start", command: "npm start", source: "package.json" },
      ]);
      saveSettingsMock.mockRejectedValueOnce(new Error("save failed"));
      render(<DevPreviewPane {...baseProps} />);

      // The popover mock renders the picker entries inline; pick the alternate.
      fireEvent.click(screen.getByText("npm start"));
      await flushAutoDetect();
      expect(screen.getByText("Couldn't start preview")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await flushAutoDetect();

      expect(saveSettingsMock).toHaveBeenCalledTimes(2);
      expect(saveSettingsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ devServerCommand: "npm start" })
      );
    });

    it("does not resurface a stale failure after the pane is reconfigured", async () => {
      saveSettingsMock.mockRejectedValueOnce(new Error("save failed"));
      const { rerender } = render(<DevPreviewPane {...baseProps} />);

      fireEvent.click(getRunButton());
      await flushAutoDetect();
      expect(screen.getByText("Couldn't start preview")).toBeTruthy();

      setSettingsStoreState("pnpm dev");
      rerender(<DevPreviewPane {...baseProps} />);
      await flushAutoDetect();

      setSettingsStoreState("");
      rerender(<DevPreviewPane {...baseProps} />);

      expect(screen.queryByText("Couldn't start preview")).toBeNull();
    });
  });

  describe("proxy 502 handling (#9948)", () => {
    it("shows the proxy-error overlay for a main-frame 502 and keeps it across did-finish-load", () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      // An HTTP 502 is a successful network load: did-frame-navigate carries the
      // status, then did-navigate + did-finish-load fire and would otherwise
      // clear the error. The overlay must survive both.
      act(() => {
        emitWebviewEvent(webview, "did-frame-navigate", {
          isMainFrame: true,
          httpResponseCode: 502,
          httpStatusText: DEV_PREVIEW_PROXY_STATUS_TEXT,
          url: "http://localhost:5173/",
        });
        emitWebviewEvent(webview, "did-navigate", { url: "http://localhost:5173/" });
        emitWebviewEvent(webview, "did-finish-load");
      });

      expect(container.textContent).toContain("Dev server unavailable");
    });

    it("routes the proxy 502 to the Restart dev server recovery branch, not the bare Retry", () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitWebviewEvent(webview, "did-frame-navigate", {
          isMainFrame: true,
          httpResponseCode: 502,
          httpStatusText: DEV_PREVIEW_PROXY_STATUS_TEXT,
          url: "http://localhost:5173/",
        });
      });

      // "Reload preview" only exists in the restart-action dropdown branch shared
      // with connection_refused — its presence proves proxy_error uses it.
      expect(container.textContent).toContain("Dev server unavailable");
      expect(container.textContent).toContain("Reload preview");
    });

    it("passes 4xx (bootstrap 403/405) through without an overlay", () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitWebviewEvent(webview, "did-frame-navigate", {
          isMainFrame: true,
          httpResponseCode: 403,
          url: "http://localhost:5173/",
        });
        emitWebviewEvent(webview, "did-finish-load");
      });

      expect(container.textContent).not.toContain("Dev server unavailable");
    });

    it("passes an upstream app 500/503/504 through without an overlay", () => {
      // The proxy forwards upstream responses untouched; only it self-generates
      // 502. A dev app's own 5xx error page must render, not be hidden/reloaded.
      for (const code of [500, 503, 504]) {
        const { container, unmount } = render(<DevPreviewPane {...baseProps} />);
        const webview = getWebviewElement(container);
        act(() => {
          emitWebviewEvent(webview, "did-frame-navigate", {
            isMainFrame: true,
            httpResponseCode: code,
            url: "http://localhost:5173/",
          });
          emitWebviewEvent(webview, "did-finish-load");
        });
        expect(container.textContent).not.toContain("Dev server unavailable");
        expect(webview.reload).not.toHaveBeenCalled();
        unmount();
      }
    });

    it("drops the automatic-reload promise from the message once the retry cap is hit", () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      const delays = [1000, 2000, 4000, 8000, 16000];
      for (let i = 0; i < 6; i++) {
        act(() => {
          emitWebviewEvent(webview, "did-start-loading");
          emitWebviewEvent(webview, "did-frame-navigate", {
            isMainFrame: true,
            httpResponseCode: 502,
            httpStatusText: DEV_PREVIEW_PROXY_STATUS_TEXT,
            url: "http://localhost:5173/",
          });
        });
        if (i < 5) {
          act(() => {
            vi.advanceTimersByTime(delays[i]!);
          });
        }
      }

      expect(container.textContent).toContain("Dev server unavailable");
      expect(container.textContent).not.toContain("reloads automatically");
      expect(container.textContent).toContain("Restart it or reload");
    });

    it("cancels the pending auto-retry on unmount", () => {
      const { container, unmount } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitWebviewEvent(webview, "did-frame-navigate", {
          isMainFrame: true,
          httpResponseCode: 502,
          httpStatusText: DEV_PREVIEW_PROXY_STATUS_TEXT,
          url: "http://localhost:5173/",
        });
      });

      unmount();
      act(() => {
        vi.advanceTimersByTime(16000);
      });

      expect(webview.reload).not.toHaveBeenCalled();
    });

    it("ignores a 502 from a non-main-frame navigation", () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitWebviewEvent(webview, "did-frame-navigate", {
          isMainFrame: false,
          httpResponseCode: 502,
          httpStatusText: DEV_PREVIEW_PROXY_STATUS_TEXT,
          url: "http://localhost:5173/iframe",
        });
        emitWebviewEvent(webview, "did-finish-load");
      });

      expect(container.textContent).not.toContain("Dev server unavailable");
    });

    it("auto-retries the load with backoff while the 502 persists", () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitWebviewEvent(webview, "did-frame-navigate", {
          isMainFrame: true,
          httpResponseCode: 502,
          httpStatusText: DEV_PREVIEW_PROXY_STATUS_TEXT,
          url: "http://localhost:5173/",
        });
      });

      // First retry fires after 1000ms (1000 * 2^0); not before.
      expect(webview.reload).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(webview.reload).toHaveBeenCalledTimes(1);
    });

    it("stops auto-retrying after the cap but keeps the overlay for manual recovery", () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      const delays = [1000, 2000, 4000, 8000, 16000];
      // Each cycle mimics a reload that 502s again: a fresh load (did-start-loading)
      // then another main-frame 502.
      for (let i = 0; i < 6; i++) {
        act(() => {
          emitWebviewEvent(webview, "did-start-loading");
          emitWebviewEvent(webview, "did-frame-navigate", {
            isMainFrame: true,
            httpResponseCode: 502,
            httpStatusText: DEV_PREVIEW_PROXY_STATUS_TEXT,
            url: "http://localhost:5173/",
          });
        });
        if (i < 5) {
          act(() => {
            vi.advanceTimersByTime(delays[i]!);
          });
        }
      }

      // The 6th 502 lands after the count hit the cap, so no further reload is scheduled.
      expect(webview.reload).toHaveBeenCalledTimes(5);
      expect(container.textContent).toContain("Dev server unavailable");
    });

    it("clears the proxy overlay once the upstream answers with a 2xx", () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitWebviewEvent(webview, "did-frame-navigate", {
          isMainFrame: true,
          httpResponseCode: 502,
          httpStatusText: DEV_PREVIEW_PROXY_STATUS_TEXT,
          url: "http://localhost:5173/",
        });
      });
      expect(container.textContent).toContain("Dev server unavailable");

      // Recovery: the retry reloads, the upstream is back, a 200 commits and finishes.
      act(() => {
        emitWebviewEvent(webview, "did-start-loading");
        emitWebviewEvent(webview, "did-frame-navigate", {
          isMainFrame: true,
          httpResponseCode: 200,
          url: "http://localhost:5173/",
        });
        emitWebviewEvent(webview, "did-navigate", { url: "http://localhost:5173/" });
        emitWebviewEvent(webview, "did-finish-load");
      });

      expect(container.textContent).not.toContain("Dev server unavailable");
    });
  });

  describe("failed-load and early-crash recovery (#12296)", () => {
    const REFUSED = {
      errorCode: -102,
      errorDescription: "ERR_CONNECTION_REFUSED",
      isMainFrame: true,
      validatedURL: "http://localhost:5173/",
    };

    // Render a pane whose guest reports isLoading() true from creation, so the
    // mount-time readiness probe leaves isWebviewReady false — the state of a
    // renderer that dies during its first load, before dom-ready ever fires.
    const renderNeverReadyPane = () => {
      nextWebviewStartsLoading = true;
      try {
        return render(<DevPreviewPane {...baseProps} />);
      } finally {
        nextWebviewStartsLoading = false;
      }
    };

    // Chromium commits its own error document when a main-frame load fails and
    // replays the whole lifecycle for it. This is the sequence captured from the
    // real guest against a closed port.
    const emitErrorDocumentTail = (webview: MockWebviewElement, url = "http://localhost:5173/") => {
      emitWebviewEvent(webview, "dom-ready");
      emitWebviewEvent(webview, "did-navigate", { url });
      emitWebviewEvent(webview, "did-finish-load");
      emitWebviewEvent(webview, "did-stop-loading");
    };

    it("keeps a terminal load error across the error document's own lifecycle", () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitWebviewEvent(webview, "did-start-loading");
        emitWebviewEvent(webview, "did-fail-load", {
          errorCode: -105,
          errorDescription: "ERR_NAME_NOT_RESOLVED",
          isMainFrame: true,
          validatedURL: "http://missing.test/",
        });
        emitErrorDocumentTail(webview, "http://missing.test/");
      });

      expect(container.textContent).toContain("Couldn't resolve address");
      expect(container.textContent).toContain("Couldn't resolve missing.test");
    });

    it("survives the exact captured sequence, with no did-navigate at all", () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      // Verbatim from the issue's real-Electron capture against a closed port:
      // did-start-loading → did-fail-load(-102) → dom-ready → did-finish-load →
      // did-stop-loading. Nothing in that tail may read as a successful load.
      act(() => {
        emitWebviewEvent(webview, "did-start-loading");
        emitWebviewEvent(webview, "did-fail-load", REFUSED);
        emitWebviewEvent(webview, "dom-ready");
        emitWebviewEvent(webview, "did-finish-load");
        emitWebviewEvent(webview, "did-stop-loading");
      });

      // The failure survived: the scheduled retry is still pending and fires with
      // the URL that failed, rather than having been cancelled by the tail.
      const loadsBefore = webview.loadURL.mock.calls.length;
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(webview.loadURL.mock.calls.length).toBe(loadsBefore + 1);
      expect(webview.loadURL).toHaveBeenLastCalledWith("http://localhost:5173/");
    });

    it("exhausts the connection-refused budget when each retry starts its own load", () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);
      const loadsBefore = webview.loadURL.mock.calls.length;

      // MAX_RETRIES = 5, so the 6th failure is the one that gives up. Every cycle
      // carries the load start the scheduled retry actually issues — the event that
      // used to refill the budget and make the cap unreachable.
      for (let i = 0; i < 6; i++) {
        act(() => {
          emitWebviewEvent(webview, "did-start-loading");
          emitWebviewEvent(webview, "did-fail-load", REFUSED);
          emitErrorDocumentTail(webview);
        });
        if (i < 5) {
          act(() => {
            vi.advanceTimersByTime(Math.min(500 * 2 ** i, 8000));
          });
        }
      }

      expect(webview.loadURL.mock.calls.length - loadsBefore).toBe(5);
      expect(webview.loadURL).toHaveBeenLastCalledWith("http://localhost:5173/");
      expect(container.textContent).toContain("Dev server unreachable");
      expect(container.textContent).toContain("Unable to connect to dev server");

      // Past every remaining backoff window, nothing more is scheduled: the cap
      // stops the loop rather than merely relabelling the overlay.
      act(() => {
        vi.advanceTimersByTime(30000);
      });
      expect(webview.loadURL.mock.calls.length - loadsBefore).toBe(5);
    });

    it("recovers when the dev server comes up mid retry loop", () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      for (let i = 0; i < 2; i++) {
        act(() => {
          emitWebviewEvent(webview, "did-start-loading");
          emitWebviewEvent(webview, "did-fail-load", REFUSED);
          emitErrorDocumentTail(webview);
        });
        act(() => {
          vi.advanceTimersByTime(Math.min(500 * 2 ** i, 8000));
        });
      }

      // The third attempt finds the server up.
      act(() => {
        emitWebviewEvent(webview, "did-start-loading");
        emitWebviewEvent(webview, "did-frame-navigate", {
          isMainFrame: true,
          httpResponseCode: 200,
          httpStatusText: "OK",
          url: "http://localhost:5173/",
        });
        emitWebviewEvent(webview, "did-navigate", { url: "http://localhost:5173/" });
        emitWebviewEvent(webview, "did-finish-load");
        emitWebviewEvent(webview, "did-stop-loading");
      });
      expect(container.textContent).not.toContain("Dev server unreachable");

      // A confirmed success returns the full budget: the next failure retries at
      // the first backoff step rather than partway up the ladder.
      const loadsBefore = webview.loadURL.mock.calls.length;
      act(() => {
        emitWebviewEvent(webview, "did-start-loading");
        emitWebviewEvent(webview, "did-fail-load", REFUSED);
        emitErrorDocumentTail(webview);
      });
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(webview.loadURL.mock.calls.length).toBe(loadsBefore + 1);
    });

    it("cancels a pending retry when a fresh navigation starts", () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitWebviewEvent(webview, "did-start-loading");
        emitWebviewEvent(webview, "did-fail-load", REFUSED);
        emitErrorDocumentTail(webview);
      });

      const loadsBefore = webview.loadURL.mock.calls.length;
      act(() => {
        emitWebviewEvent(webview, "did-start-loading");
      });
      act(() => {
        vi.advanceTimersByTime(8000);
      });

      expect(webview.loadURL.mock.calls.length).toBe(loadsBefore);
    });

    it("cancels a pending retry when the panel closes", () => {
      const { container, unmount } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        emitWebviewEvent(webview, "did-start-loading");
        emitWebviewEvent(webview, "did-fail-load", REFUSED);
        emitErrorDocumentTail(webview);
      });

      const loadsBefore = webview.loadURL.mock.calls.length;
      unmount();
      act(() => {
        vi.advanceTimersByTime(8000);
      });

      expect(webview.loadURL.mock.calls.length).toBe(loadsBefore);
    });

    it("hands the retry budget back when the user reloads after exhaustion", () => {
      let reloadCb: ((payload: { panelId: string }) => void) | undefined;
      const electron = getElectronMock();
      electron.webview.onReloadShortcut = vi.fn((cb: (payload: { panelId: string }) => void) => {
        reloadCb = cb;
        return vi.fn();
      });

      const { container } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      for (let i = 0; i < 6; i++) {
        act(() => {
          emitWebviewEvent(webview, "did-start-loading");
          emitWebviewEvent(webview, "did-fail-load", REFUSED);
          emitErrorDocumentTail(webview);
        });
        if (i < 5) {
          act(() => {
            vi.advanceTimersByTime(Math.min(500 * 2 ** i, 8000));
          });
        }
      }
      expect(container.textContent).toContain("Unable to connect to dev server");

      // Manual recovery must not inherit the exhausted budget now that a load
      // start no longer refills it.
      act(() => {
        reloadCb?.({ panelId: "dev-preview-panel-1" });
      });

      const loadsBefore = webview.loadURL.mock.calls.length;
      act(() => {
        emitWebviewEvent(webview, "did-start-loading");
        emitWebviewEvent(webview, "did-fail-load", REFUSED);
        emitErrorDocumentTail(webview);
      });
      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(webview.loadURL.mock.calls.length).toBeGreaterThan(loadsBefore);
    });

    it("lifts the blocking overlay at dom-ready while a subresource is still pending", () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      act(() => {
        webview.setMockLoading(true);
        emitWebviewEvent(webview, "did-start-loading");
      });
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(container.textContent).toContain("Loading preview");

      // The document is committed and usable; a hanging image means
      // did-stop-loading never arrives. dom-ready is the shared finish boundary,
      // so the overlay lifts and the watchdog it used to silently outlive is gone.
      act(() => {
        emitWebviewEvent(webview, "dom-ready");
      });
      expect(container.textContent).not.toContain("Loading preview");

      act(() => {
        vi.advanceTimersByTime(60000);
      });
      expect(webview.stop).not.toHaveBeenCalled();
      expect(container.textContent).not.toContain("Page load timed out");
    });

    it("still times out when the main document never reaches dom-ready", () => {
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
      expect(container.textContent).toContain("Page load timed out");
    });

    it("renders an application 502 instead of the proxy outage overlay", () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      // Same status code, different provenance: the proxy forwarded this one from
      // the developer's app, so its error page has to stay inspectable.
      act(() => {
        emitWebviewEvent(webview, "did-start-loading");
        emitWebviewEvent(webview, "did-frame-navigate", {
          isMainFrame: true,
          httpResponseCode: 502,
          httpStatusText: "Bad Gateway",
          url: "http://localhost:5173/",
        });
        emitWebviewEvent(webview, "did-navigate", { url: "http://localhost:5173/" });
        emitWebviewEvent(webview, "did-finish-load");
      });

      expect(container.textContent).not.toContain("Dev server unavailable");
      act(() => {
        vi.advanceTimersByTime(16000);
      });
      expect(webview.reload).not.toHaveBeenCalled();
    });

    it("reloads a guest that crashed before its first dom-ready", () => {
      const electron = getElectronMock();
      const reloadIgnoringCache = electron.webview.reloadIgnoringCache as ReturnType<typeof vi.fn>;

      const { container } = renderNeverReadyPane();
      const webview = getWebviewElement(container);

      // Auto-recovery on the first crash routes through the same reload the manual
      // action uses; both used to return early while isWebviewReady was false.
      act(() => {
        emitWebviewEvent(webview, "render-process-gone", {
          details: { reason: "crashed", exitCode: 1 },
        });
      });

      // It has to reach the guest directly: the cache-ignoring IPC only acts on a
      // panel registered at dom-ready, so for this guest it would resolve having
      // done nothing at all.
      expect(webview.reload).toHaveBeenCalledTimes(1);
      expect(reloadIgnoringCache).not.toHaveBeenCalled();
    });

    it("uses the cache-ignoring reload once the guest has reached dom-ready", () => {
      const electron = getElectronMock();
      const reloadIgnoringCache = electron.webview.reloadIgnoringCache as ReturnType<typeof vi.fn>;

      const { container } = renderNeverReadyPane();
      const webview = getWebviewElement(container);

      act(() => {
        emitWebviewEvent(webview, "dom-ready");
      });
      act(() => {
        emitWebviewEvent(webview, "render-process-gone", {
          details: { reason: "crashed", exitCode: 1 },
        });
      });

      expect(reloadIgnoringCache).toHaveBeenCalledWith(42, "dev-preview-panel-1");
      expect(webview.reload).not.toHaveBeenCalled();
    });

    it("clears the crash banner only once the reload is actually issued", () => {
      let reloadCb: ((payload: { panelId: string }) => void) | undefined;
      const electron = getElectronMock();
      electron.webview.onReloadShortcut = vi.fn((cb: (payload: { panelId: string }) => void) => {
        reloadCb = cb;
        return vi.fn();
      });
      const { container } = renderNeverReadyPane();
      const webview = getWebviewElement(container);

      // Two crashes inside the 60s window: auto-recovery stops, so the banner and
      // its manual actions are the only way out.
      act(() => {
        emitWebviewEvent(webview, "render-process-gone", {
          details: { reason: "crashed", exitCode: 1 },
        });
        emitWebviewEvent(webview, "render-process-gone", {
          details: { reason: "crashed", exitCode: 1 },
        });
      });
      expect(container.textContent).toContain("Preview process crashed");

      webview.reload.mockClear();
      act(() => {
        reloadCb?.({ panelId: "dev-preview-panel-1" });
      });

      expect(webview.reload).toHaveBeenCalledTimes(1);
      expect(container.textContent).not.toContain("Preview process crashed");
    });

    it("recreates the guest when it can no longer be reloaded in place", () => {
      let reloadCb: ((payload: { panelId: string }) => void) | undefined;
      const electron = getElectronMock();
      electron.webview.onReloadShortcut = vi.fn((cb: (payload: { panelId: string }) => void) => {
        reloadCb = cb;
        return vi.fn();
      });

      const { container } = renderNeverReadyPane();
      const webview = getWebviewElement(container);

      // A renderer that died before it was ever attached has no WebContents to
      // reach, so recovery falls through to a fresh guest rather than doing
      // nothing.
      webview.getWebContentsId.mockImplementation(() => {
        throw new Error("The WebView must be attached to the DOM");
      });
      webview.reload.mockImplementation(() => {
        throw new Error("The WebView must be attached to the DOM");
      });

      act(() => {
        reloadCb?.({ panelId: "dev-preview-panel-1" });
      });

      expect(getWebviewElement(container)).not.toBe(webview);
    });
  });

  describe("src binding regression (#9940)", () => {
    it("seeds src once at mount", () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);
      expect(webview.getAttribute("src")).toBe("http://localhost:5173/");
    });

    it("does not issue a redundant loadURL on first ready when the seed matches history", async () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      // Let the ready probe run. Because lastSetUrlRef is seeded to the mount
      // URL, the isWebviewReady navigation effect must not re-load the same URL.
      await act(async () => {
        await Promise.resolve();
      });

      expect(webview.loadURL).not.toHaveBeenCalled();
    });

    it("does not re-bind src or re-load after an in-page guest navigation", async () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      await act(async () => {
        await Promise.resolve();
      });

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

    it("does not re-bind src or re-load after a full guest navigation", async () => {
      const { container } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      await act(async () => {
        await Promise.resolve();
      });

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

    it("navigates imperatively when the dev-server URL changes (src is seed-only)", async () => {
      const { container, rerender } = render(<DevPreviewPane {...baseProps} />);
      const webview = getWebviewElement(container);

      await act(async () => {
        await Promise.resolve();
      });

      // A dev-server restart shifts the origin (port 5173 -> 5174). Because `src`
      // no longer re-binds to currentUrl, the imperative navigation effect MUST
      // drive the loadURL — otherwise the guest would be stranded on the old URL.
      webview.loadURL.mockClear();
      devServerStateRef.current = {
        ...devServerStateRef.current,
        url: "http://localhost:5174/",
      };

      await act(async () => {
        rerender(<DevPreviewPane {...baseProps} />);
        await Promise.resolve();
      });

      expect(webview.loadURL).toHaveBeenCalledWith("http://localhost:5174/");
    });
  });

  // #12297 — crossing onto the stable proxy origin used to lose the route. `showEmptyState`
  // unmounts the `<webview>` while `isProxyUrlPending` is true, and the replacement guest was
  // seeded from `webviewSeedUrl`, which is captured once per session. These tests run the
  // *configured proxy* path the existing coverage never reached, and assert call counts so a
  // fix that re-requests a consumed callback would fail here.
  describe("proxy-origin route preservation (#12297)", () => {
    const PROXY_PORT = 43000;
    const PROXY = buildDevPreviewProxyOrigin(PROXY_PORT, "project-1", "dev-preview-panel-1");

    function enableProxyMode(port = PROXY_PORT) {
      Object.assign(window.electron, {
        devPreview: {
          getProxyPort: vi.fn().mockResolvedValue({ port }),
          mintBrowserToken: vi
            .fn()
            .mockResolvedValue({ bootstrapUrl: `${PROXY}/_daintree/bootstrap` }),
        },
      });
    }

    function setSavedHistory(history: { past: string[]; present: string; future: string[] }) {
      terminalStoreState.getTerminal.mockImplementation(() => ({
        kind: "dev-preview",
        id: "dev-preview-panel-1",
        browserHistory: history,
        browserZoom: 1.4,
        devPreviewConsoleOpen: false,
        devCommand: "npm run dev",
        devPreviewScrollPosition: scrollPositionRef.current,
      }));
    }

    // Let the proxy-port promise resolve and every dependent effect flush.
    async function settle() {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    function seedsAcrossGuests(): string[] {
      return guestLog.flatMap((g) => g.srcWrites);
    }

    function loadsAcrossGuests(): string[] {
      return guestLog.flatMap((g) => g.loadURLs);
    }

    beforeEach(() => {
      enableProxyMode();
    });

    it("seeds a replacement guest from the migrated route, not the session's first URL", async () => {
      // A session that persisted a raw upstream URL: the pane gates the webview out while it
      // migrates onto the proxy origin, then mounts a fresh guest. Before the fix that guest
      // was seeded with the stale `webviewSeedUrl` and landed on "/".
      setSavedHistory({
        past: [],
        present: "http://localhost:5173/consume?token=audit-single-use#done",
        future: [],
      });
      const { container } = render(<DevPreviewPane {...baseProps} />);
      await settle();

      const webview = getWebviewElement(container);
      const expected = `${PROXY}/consume?token=audit-single-use#done`;

      expect(webview.getAttribute("src")).toBe(expected);
      // Path, query and fragment all survive the origin change.
      expect(seedsAcrossGuests()).not.toContain(`${PROXY}/`);
      expect(seedsAcrossGuests().at(-1)).toBe(expected);
    });

    it("does not re-request the destination after seeding a replacement guest", async () => {
      // The seed navigates the guest by itself, so a corrective loadURL on top of it would be
      // a second request — exactly the callback replay the issue rules out.
      setSavedHistory({ past: [], present: "http://localhost:5173/once", future: [] });
      const { container } = render(<DevPreviewPane {...baseProps} />);
      await settle();

      const webview = getWebviewElement(container);
      await act(async () => {
        emitWebviewEvent(webview, "dom-ready");
        await Promise.resolve();
      });

      expect(webview.getAttribute("src")).toBe(`${PROXY}/once`);
      // Both halves matter: no corrective load, and no second guest seeded with the same
      // route — either one would be a second request for the destination.
      expect(loadsAcrossGuests()).toEqual([]);
      expect(seedsAcrossGuests()).toEqual([`${PROXY}/once`]);
      expect(webview.reload).not.toHaveBeenCalled();
    });

    it("creates exactly one guest, seeded once, while migrating", async () => {
      setSavedHistory({ past: [], present: "http://localhost:5173/deep/route?a=1", future: [] });
      render(<DevPreviewPane {...baseProps} />);
      await settle();

      // Exact, not "at most": two guests each seeded with the destination would request it
      // twice while still satisfying a loadURL-only assertion.
      expect(guestLog).toHaveLength(1);
      expect(seedsAcrossGuests()).toEqual([`${PROXY}/deep/route?a=1`]);
      expect(loadsAcrossGuests()).toEqual([]);
    });

    it("re-seeds a genuine replacement guest when a redirect crosses off the proxy origin", async () => {
      // The reported sequence, end to end, against an ALREADY-MOUNTED guest — the case the
      // gated-first-mount tests above cannot reach. The guest is on the proxy origin, follows
      // an absolute upstream redirect off it, which gates the webview out; the pane migrates
      // the route back onto the proxy origin and mounts a REPLACEMENT guest. That guest must
      // start from the callback route, not from the origin's root.
      setSavedHistory({ past: [], present: `${PROXY}/once`, future: [] });
      const { container } = render(<DevPreviewPane {...baseProps} />);
      await settle();

      const firstGuest = getWebviewElement(container);
      await act(async () => {
        emitWebviewEvent(firstGuest, "dom-ready");
        await Promise.resolve();
      });
      expect(guestLog).toHaveLength(1);
      expect(seedsAcrossGuests()).toEqual([`${PROXY}/once`]);

      // The guest followed the upstream's absolute redirect and committed off-origin.
      await act(async () => {
        emitWebviewEvent(firstGuest, "did-navigate", {
          url: "http://localhost:5173/consume?token=audit-single-use#done",
        });
        await Promise.resolve();
      });
      await settle();

      const expected = `${PROXY}/consume?token=audit-single-use#done`;
      // A replacement guest was created, and it starts from the callback route with its
      // query and fragment intact — before the fix it started from the frozen session seed.
      expect(guestLog.length).toBeGreaterThan(1);
      expect(seedsAcrossGuests().at(-1)).toBe(expected);
      expect(seedsAcrossGuests()).not.toContain(`${PROXY}/`);
      // The seed navigates the replacement guest by itself; a corrective load on top would
      // be a second request for a single-use callback.
      expect(loadsAcrossGuests()).toEqual([]);
      expect(getWebviewElement(container).getAttribute("src")).toBe(expected);
    });

    it("keeps a replacement guest's seed current across repeated origin crossings", async () => {
      // Guards specifically against a fix that refreshes the seed once and then re-freezes:
      // the second crossing must be seeded from the second destination, not the first.
      setSavedHistory({ past: [], present: `${PROXY}/start`, future: [] });
      const { container } = render(<DevPreviewPane {...baseProps} />);
      await settle();

      for (const route of ["/first?n=1", "/second?n=2"]) {
        const guest = getWebviewElement(container);
        await act(async () => {
          emitWebviewEvent(guest, "dom-ready");
          await Promise.resolve();
        });
        await act(async () => {
          emitWebviewEvent(guest, "did-navigate", { url: `http://localhost:5173${route}` });
          await Promise.resolve();
        });
        await settle();
        expect(seedsAcrossGuests().at(-1)).toBe(`${PROXY}${route}`);
      }

      expect(loadsAcrossGuests()).toEqual([]);
    });

    it("hands the toolbar a validator that accepts the panel's own origin", async () => {
      setSavedHistory({ past: [], present: `${PROXY}/`, future: [] });
      render(<DevPreviewPane {...baseProps} />);
      await settle();

      const props = latestToolbarProps();
      expect(props.validateUrl).toBeTypeOf("function");
      // The reported failure: this returned "Only localhost URLs are allowed".
      expect(props.validateUrl!(`${PROXY}/typed-route`)).toEqual({ url: `${PROXY}/typed-route` });
      // A raw upstream address is retargeted rather than pushed off-origin.
      expect(props.validateUrl!("http://localhost:5173/typed-route").url).toBe(
        `${PROXY}/typed-route`
      );
      // Still no blanket acceptance of external hosts.
      expect(props.validateUrl!("http://example.com/x").url).toBeUndefined();
    });

    it("navigates the live guest to a submitted route without remounting it", async () => {
      setSavedHistory({ past: [], present: `${PROXY}/`, future: [] });
      const { container } = render(<DevPreviewPane {...baseProps} />);
      await settle();

      const webview = getWebviewElement(container);
      await act(async () => {
        emitWebviewEvent(webview, "dom-ready");
        await Promise.resolve();
      });
      const guestsBefore = guestLog.length;
      const props = latestToolbarProps();

      await act(async () => {
        props.onNavigate(`${PROXY}/typed?x=1#s`);
        await Promise.resolve();
      });

      // Same guest, one imperative load, and `src` genuinely was not re-bound (#9940) —
      // the seed write count must not have grown.
      expect(guestLog.length).toBe(guestsBefore);
      expect(guestLog.at(-1)!.loadURLs).toEqual([`${PROXY}/typed?x=1#s`]);
      expect(guestLog.at(-1)!.srcWrites).toEqual([`${PROXY}/`]);
    });

    it("retargets a raw upstream address onto the proxy origin, requesting it once", async () => {
      setSavedHistory({ past: [], present: `${PROXY}/`, future: [] });
      const { container } = render(<DevPreviewPane {...baseProps} />);
      await settle();

      const webview = getWebviewElement(container);
      await act(async () => {
        emitWebviewEvent(webview, "dom-ready");
        await Promise.resolve();
      });
      const props = latestToolbarProps();

      await act(async () => {
        props.onNavigate("http://localhost:5173/once");
        await Promise.resolve();
      });

      // Never lands on the raw origin, so the pane never gates the guest out and never
      // re-requests the route from a replacement guest.
      expect(loadsAcrossGuests()).toEqual([`${PROXY}/once`]);
      expect(loadsAcrossGuests()).not.toContain("http://localhost:5173/once");
      // One guest throughout, seeded once — the destination is requested exactly once.
      expect(guestLog).toHaveLength(1);
      expect(seedsAcrossGuests()).toEqual([`${PROXY}/`]);
    });

    it("ignores a rejected address entirely — no load, no mount, no history entry", async () => {
      setSavedHistory({ past: [], present: `${PROXY}/`, future: [] });
      const { container } = render(<DevPreviewPane {...baseProps} />);
      await settle();

      const webview = getWebviewElement(container);
      await act(async () => {
        emitWebviewEvent(webview, "dom-ready");
        await Promise.resolve();
      });
      const guestsBefore = guestLog.length;
      const loadsBefore = loadsAcrossGuests().length;
      const props = latestToolbarProps();

      await act(async () => {
        props.onNavigate("http://evil.localhost:43000/x");
        await Promise.resolve();
      });

      expect(guestLog.length).toBe(guestsBefore);
      expect(loadsAcrossGuests()).toHaveLength(loadsBefore);
    });

    it("does not treat a prefix-matching port as the proxy origin", async () => {
      // The ports must be this way round: `"…:43000/x".startsWith("…:4300")` is TRUE, so the
      // old check called the pane settled and left the guest on an origin it never proxied.
      // (The reverse arrangement is rejected by `startsWith` too, and proves nothing.)
      const shortPortProxy = buildDevPreviewProxyOrigin(4300, "project-1", "dev-preview-panel-1");
      enableProxyMode(4300);
      setSavedHistory({ past: [], present: `${PROXY}/x`, future: [] });

      render(<DevPreviewPane {...baseProps} />);
      await settle();

      expect(seedsAcrossGuests().at(-1)).toBe(`${shortPortProxy}/x`);
      // Never seeded on the longer-port origin that merely has the real one as a prefix.
      expect(seedsAcrossGuests()).not.toContain(`${PROXY}/x`);
    });
  });
});
