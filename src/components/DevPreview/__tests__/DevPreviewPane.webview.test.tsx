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
  useTerminalStoreMock,
  useProjectStoreMock,
  useProjectSettingsStoreMock,
  devServerStateRef,
  useDevServerMock,
  useIsDraggingMock,
} = vi.hoisted(() => {
  const terminalStoreState = {
    getTerminal: vi.fn(),
    setBrowserUrl: vi.fn(),
    setBrowserHistory: vi.fn(),
    setBrowserZoom: vi.fn(),
    setDevPreviewConsoleOpen: vi.fn(),
  };
  const useTerminalStoreMock = vi.fn((selector: (state: typeof terminalStoreState) => unknown) =>
    selector(terminalStoreState)
  );

  const projectStoreState = {
    currentProject: { id: "project-1" } as { id: string } | null,
  };
  const useProjectStoreMock = vi.fn((selector: (state: typeof projectStoreState) => unknown) =>
    selector(projectStoreState)
  );

  const projectSettingsStoreState = {
    settings: {
      devServerCommand: "npm run dev",
      environmentVariables: { API_URL: "http://localhost:9000" },
    },
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
    useTerminalStoreMock,
    useProjectStoreMock,
    useProjectSettingsStoreMock,
    devServerStateRef,
    useDevServerMock,
    useIsDraggingMock,
  };
});

vi.mock("@/store", () => ({
  useTerminalStore: useTerminalStoreMock,
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
    };
  });

  afterEach(() => {
    document.createElement = originalCreateElement;
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("recovers ready state from an already-loaded webview and reapplies zoom", async () => {
    const { container } = render(<DevPreviewPane {...baseProps} />);
    const webview = getWebviewElement(container);

    await act(async () => {
      await Promise.resolve();
    });

    expect(webview.setZoomFactor).toHaveBeenCalledWith(1.4);
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
});
