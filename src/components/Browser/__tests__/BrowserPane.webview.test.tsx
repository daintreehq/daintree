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

const { terminalStoreState, useTerminalStoreMock, useIsDraggingMock, actionDispatchMock } =
  vi.hoisted(() => {
    const terminalStoreState = {
      getTerminal: vi.fn(),
      setBrowserUrl: vi.fn(),
      setBrowserHistory: vi.fn(),
      setBrowserZoom: vi.fn(),
    };
    const useTerminalStoreMock = vi.fn((selector: (state: typeof terminalStoreState) => unknown) =>
      selector(terminalStoreState)
    );
    (useTerminalStoreMock as unknown as { getState: () => typeof terminalStoreState }).getState =
      () => terminalStoreState;
    const useIsDraggingMock = vi.fn(() => false);
    const actionDispatchMock = vi.fn();
    return { terminalStoreState, useTerminalStoreMock, useIsDraggingMock, actionDispatchMock };
  });

vi.mock("@/store", () => ({
  useTerminalStore: useTerminalStoreMock,
}));

vi.mock("@/components/DragDrop", () => ({
  useIsDragging: useIsDraggingMock,
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: actionDispatchMock,
  },
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
});
