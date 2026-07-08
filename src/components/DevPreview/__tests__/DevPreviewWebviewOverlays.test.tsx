// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DevPreviewWebviewOverlays } from "../DevPreviewWebviewOverlays";
import type { WebviewLoadError } from "../useDevPreviewLoadLifecycle";
import type { FindInPageState } from "@/hooks/useFindInPage";

vi.mock("../BlockedNavBanner", () => ({
  BlockedNavBanner: ({ state }: { state: unknown }) =>
    state ? <div data-testid="blocked-nav-banner" /> : null,
}));
vi.mock("../../Browser/WebviewDialog", () => ({
  WebviewDialog: ({ dialog }: { dialog: unknown }) =>
    dialog ? <div data-testid="webview-dialog" /> : null,
}));
vi.mock("../../Browser/FindBar", () => ({
  FindBar: () => <div data-testid="find-bar" />,
}));
vi.mock("../DevPreviewLoadingState", () => ({
  DevPreviewLoadingState: ({ phaseLabel }: { phaseLabel: string }) => (
    <div data-testid="loading-state">{phaseLabel}</div>
  ),
}));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
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
});

const findInPage: FindInPageState = {
  isOpen: false,
  query: "",
  activeMatch: 0,
  matchCount: 0,
  matchCase: false,
  inputRef: { current: null },
  isComposingRef: { current: false },
  open: vi.fn(),
  close: vi.fn(),
  setQuery: vi.fn(),
  goNext: vi.fn(),
  goPrev: vi.fn(),
  toggleMatchCase: vi.fn(),
};

function baseProps(
  overrides: Partial<React.ComponentProps<typeof DevPreviewWebviewOverlays>> = {}
) {
  return {
    reconnectAttempt: 0,
    webviewLoadError: null,
    certCopied: false,
    onCopyMkcert: vi.fn(),
    isRestarting: false,
    onRestartDevServer: vi.fn(),
    onHardReload: vi.fn(),
    onRequestRestartAndClearCache: vi.fn(),
    onRequestReinstallAndRestart: vi.fn(),
    onRetryWebviewLoad: vi.fn(),
    currentUrl: "http://localhost:3000",
    onOpenExternal: vi.fn(),
    blockedNav: null,
    panelId: "pane-1",
    webviewElement: null,
    onDispatchBlockedNav: vi.fn(),
    crashState: "none" as const,
    crashDetails: null,
    onCloseCrash: vi.fn(),
    onCloseUnresponsive: vi.fn(),
    isLoading: false,
    onCancelLoad: vi.fn(),
    showRecoverySpinner: false,
    isRecoveringFromEviction: false,
    isDragging: false,
    findInPage,
    currentDialog: null,
    onDialogRespond: vi.fn(),
    children: <div data-testid="webview-slot" />,
    ...overrides,
  };
}

describe("DevPreviewWebviewOverlays — reconnect + load-error", () => {
  it("shows the reconnect toast when attempts are pending and there's no load error", () => {
    render(<DevPreviewWebviewOverlays {...baseProps({ reconnectAttempt: 2 })} />);
    expect(screen.getByText(/reconnecting \(attempt 2 of 5\)/i)).toBeTruthy();
  });

  it("suppresses the reconnect toast once a load error takes over", () => {
    const error: WebviewLoadError = { code: "timeout", message: "Timed out" };
    render(
      <DevPreviewWebviewOverlays {...baseProps({ reconnectAttempt: 2, webviewLoadError: error })} />
    );
    expect(screen.queryByText(/reconnecting/i)).toBeNull();
  });

  it("renders a restart-dropdown for a connection_refused error, not the plain retry button", () => {
    const error: WebviewLoadError = { code: "connection_refused", message: "Unreachable" };
    render(<DevPreviewWebviewOverlays {...baseProps({ webviewLoadError: error })} />);
    expect(screen.getByRole("button", { name: /restart dev server/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^retry$/i })).toBeNull();
  });

  it("renders a plain retry button for a generic load error", () => {
    const error: WebviewLoadError = { code: "failed", message: "Page failed to load" };
    render(<DevPreviewWebviewOverlays {...baseProps({ webviewLoadError: error })} />);
    expect(screen.getByRole("button", { name: /^retry$/i })).toBeTruthy();
  });

  it("wires the retry click through to onRetryWebviewLoad for a generic error", () => {
    const error: WebviewLoadError = { code: "failed", message: "Page failed to load" };
    const onRetryWebviewLoad = vi.fn();
    render(
      <DevPreviewWebviewOverlays {...baseProps({ webviewLoadError: error, onRetryWebviewLoad })} />
    );
    screen.getByRole("button", { name: /^retry$/i }).click();
    expect(onRetryWebviewLoad).toHaveBeenCalledTimes(1);
  });

  it("shows the mkcert copy action only for a cert error", () => {
    const error: WebviewLoadError = { code: "cert", message: "Cert invalid" };
    render(<DevPreviewWebviewOverlays {...baseProps({ webviewLoadError: error })} />);
    expect(screen.getByRole("button", { name: /copy `mkcert -install`/i })).toBeTruthy();
  });
});

describe("DevPreviewWebviewOverlays — crash banners", () => {
  it("renders the crashed banner with details and wires reload/close/hard-restart", () => {
    const onHardReload = vi.fn();
    const onCloseCrash = vi.fn();
    render(
      <DevPreviewWebviewOverlays
        {...baseProps({
          crashState: "crashed",
          crashDetails: { reason: "crashed", exitCode: 1 },
          onHardReload,
          onCloseCrash,
        })}
      />
    );
    expect(screen.getByText(/reason: crashed \(exit code 1\)/i)).toBeTruthy();
    screen.getByRole("button", { name: /reload preview page/i }).click();
    expect(onHardReload).toHaveBeenCalledTimes(1);
    screen.getByRole("button", { name: /dismiss/i }).click();
    expect(onCloseCrash).toHaveBeenCalledTimes(1);
  });

  it("renders the unresponsive banner distinctly and wires its own close handler", () => {
    const onCloseUnresponsive = vi.fn();
    render(
      <DevPreviewWebviewOverlays
        {...baseProps({ crashState: "unresponsive", onCloseUnresponsive })}
      />
    );
    expect(screen.getByText(/preview is not responding/i)).toBeTruthy();
    screen.getByRole("button", { name: /dismiss/i }).click();
    expect(onCloseUnresponsive).toHaveBeenCalledTimes(1);
  });

  it("renders neither crash banner when crashState is none", () => {
    render(<DevPreviewWebviewOverlays {...baseProps({ crashState: "none" })} />);
    expect(screen.queryByText(/preview process crashed/i)).toBeNull();
    expect(screen.queryByText(/preview is not responding/i)).toBeNull();
  });
});

describe("DevPreviewWebviewOverlays — loading/eviction/drag/find-in-page", () => {
  it("shows the loading overlay when isLoading", () => {
    render(<DevPreviewWebviewOverlays {...baseProps({ isLoading: true })} />);
    expect(screen.getByText("Loading preview")).toBeTruthy();
  });

  it("shows the recovery overlay only when there's no load error", () => {
    render(<DevPreviewWebviewOverlays {...baseProps({ showRecoverySpinner: true })} />);
    expect(screen.getByText("Rehydrating preview")).toBeTruthy();
  });

  it("suppresses the recovery overlay once a load error appears", () => {
    const error: WebviewLoadError = { code: "failed", message: "boom" };
    render(
      <DevPreviewWebviewOverlays
        {...baseProps({ showRecoverySpinner: true, webviewLoadError: error })}
      />
    );
    expect(screen.queryByText("Rehydrating preview")).toBeNull();
  });

  it("renders the find bar only when findInPage.isOpen", () => {
    const { rerender } = render(<DevPreviewWebviewOverlays {...baseProps()} />);
    expect(screen.queryByTestId("find-bar")).toBeNull();
    rerender(
      <DevPreviewWebviewOverlays {...baseProps({ findInPage: { ...findInPage, isOpen: true } })} />
    );
    expect(screen.getByTestId("find-bar")).toBeTruthy();
  });

  it("always renders the passed-in webview slot children", () => {
    render(<DevPreviewWebviewOverlays {...baseProps()} />);
    expect(screen.getByTestId("webview-slot")).toBeTruthy();
  });
});
