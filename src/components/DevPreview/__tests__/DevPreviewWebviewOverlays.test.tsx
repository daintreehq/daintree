// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { DevPreviewWebviewOverlays } from "../DevPreviewWebviewOverlays";
import {
  webviewLoadErrorHeading,
  type WebviewLoadError,
  type WebviewLoadErrorCode,
} from "../useDevPreviewLoadLifecycle";
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
vi.mock("@/components/ui/PaneLoadingState", () => ({
  PaneLoadingState: ({ phaseLabel }: { phaseLabel: string }) => (
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

  it("wires the retry click through to onRetryWebviewLoad for a generic error", () => {
    const error: WebviewLoadError = { code: "failed", message: "Page failed to load" };
    const onRetryWebviewLoad = vi.fn();
    render(
      <DevPreviewWebviewOverlays {...baseProps({ webviewLoadError: error, onRetryWebviewLoad })} />
    );
    screen.getByRole("button", { name: /^retry$/i }).click();
    expect(onRetryWebviewLoad).toHaveBeenCalledTimes(1);
  });
});

describe("DevPreviewWebviewOverlays — a stopped load is not a failure", () => {
  it("draws a stopped load as a polite status with the info mark, and offers Reload", () => {
    const onRetryWebviewLoad = vi.fn();
    const error: WebviewLoadError = {
      code: "aborted",
      message: "You stopped this page before it finished loading.",
    };
    const { container } = render(
      <DevPreviewWebviewOverlays {...baseProps({ webviewLoadError: error, onRetryWebviewLoad })} />
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[role="status"]')?.getAttribute("aria-live")).toBe("polite");
    expect(container.querySelector("svg.lucide-info")).not.toBeNull();
    expect(container.querySelector("svg.lucide-circle-x")).toBeNull();
    expect(screen.queryByRole("button", { name: /^retry$/i })).toBeNull();
    screen.getByRole("button", { name: /^reload$/i }).click();
    expect(onRetryWebviewLoad).toHaveBeenCalledTimes(1);
  });

  it.each(["timeout", "connection_refused", "cert", "failed"] as const)(
    "draws a %s failure as an alert with the error mark",
    (code) => {
      const error: WebviewLoadError = { code, message: "The load failed." };
      const { container } = render(
        <DevPreviewWebviewOverlays {...baseProps({ webviewLoadError: error })} />
      );
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
      expect(container.querySelector("svg.lucide-circle-x")).not.toBeNull();
      expect(container.querySelector("svg.lucide-info")).toBeNull();
      expect(screen.queryByRole("button", { name: /^reload$/i })).toBeNull();
    }
  );

  it("keeps the certificate failure's copy and retry actions", () => {
    const onRetryWebviewLoad = vi.fn();
    const error: WebviewLoadError = { code: "cert", message: "Run `mkcert -install`." };
    const { container } = render(
      <DevPreviewWebviewOverlays {...baseProps({ webviewLoadError: error, onRetryWebviewLoad })} />
    );
    expect(screen.getByRole("button", { name: /copy mkcert -install/i })).toBeTruthy();
    screen.getByRole("button", { name: /^retry$/i }).click();
    expect(onRetryWebviewLoad).toHaveBeenCalledTimes(1);
    // The command is drawn as code, not between literal backticks.
    expect(container.querySelector("code")?.textContent).toBe("mkcert -install");
    expect(container.textContent).not.toContain("`");
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
    expect(screen.queryByText(/hard restart/i)).toBeNull();
    screen.getByRole("button", { name: /dismiss/i }).click();
    expect(onCloseCrash).toHaveBeenCalledTimes(1);
  });

  it("labels the restart action 'Restart dev server' on both banners", async () => {
    const onRestartDevServer = vi.fn();
    const props = { onRestartDevServer, onRequestRestartAndClearCache: vi.fn() };
    const { unmount } = render(
      <DevPreviewWebviewOverlays {...baseProps({ ...props, crashState: "crashed" })} />
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "More preview recovery options" }), {
      key: "Enter",
    });
    const item = await screen.findByRole("menuitem", { name: "Restart dev server" });
    expect(item.textContent).toBe("Restart dev server");
    fireEvent.click(item);
    expect(onRestartDevServer).toHaveBeenCalledTimes(1);
    unmount();

    render(<DevPreviewWebviewOverlays {...baseProps({ ...props, crashState: "unresponsive" })} />);
    const button = screen.getByRole("button", { name: "Restart dev server" });
    expect(button.textContent).toBe("Restart dev server");
    button.click();
    expect(onRestartDevServer).toHaveBeenCalledTimes(2);
  });

  it("uses the console drawer's endpoint label on both banners without cache actions", async () => {
    const { unmount } = render(
      <DevPreviewWebviewOverlays
        {...baseProps({ crashState: "unresponsive", onRequestRestartAndClearCache: undefined })}
      />
    );
    expect(
      screen.getByRole("button", { name: "Pause and resume resource environment" }).textContent
    ).toBe("Pause and resume resource environment");
    unmount();
    render(
      <DevPreviewWebviewOverlays
        {...baseProps({ crashState: "crashed", onRequestRestartAndClearCache: undefined })}
      />
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "More preview recovery options" }), {
      key: "Enter",
    });
    const endpointItem = await screen.findByRole("menuitem", {
      name: "Pause and resume resource environment",
    });
    expect(endpointItem.textContent).toBe("Pause and resume resource environment");
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
});

describe("webview load-error heading", () => {
  it("renders every WebviewLoadErrorCode in sentence case with no trailing period", () => {
    const codes: WebviewLoadErrorCode[] = [
      "aborted",
      "timeout",
      "name_not_resolved",
      "internet_disconnected",
      "connection_refused",
      "cert",
      "ssl_protocol",
      "failed",
    ];
    for (const code of codes) {
      const heading = webviewLoadErrorHeading(code);
      // Sentence-case invariant: the first character is uppercase, no interior
      // word starts with an uppercase letter, and there is no trailing period.
      const firstChar = heading.charAt(0);
      expect(firstChar).toBe(firstChar.toUpperCase());
      const interiorWords = heading.split(" ").slice(1);
      expect(interiorWords.every((w) => w === w.toLowerCase())).toBe(true);
      expect(heading.endsWith(".")).toBe(false);
    }
  });
});
