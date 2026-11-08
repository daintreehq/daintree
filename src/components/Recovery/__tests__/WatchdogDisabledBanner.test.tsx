// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import type { ActionDispatchResult } from "@shared/types/actions";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: vi.fn(),
  },
}));

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { WatchdogDisabledBanner } from "../WatchdogDisabledBanner";
import { usePanelStore } from "@/store/panelStore";
import { useGlobalBannerDismissalStore } from "@/store/globalBannerDismissalStore";
import { actionService } from "@/services/ActionService";
import { useDiagnosticsStore } from "@/store/diagnosticsStore";

const mockedDispatch = vi.mocked(actionService.dispatch);

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

beforeEach(() => {
  mockedDispatch.mockReset();
  mockedDispatch.mockResolvedValue({ ok: true, result: undefined } as never);
  usePanelStore.setState({ watchdogStatus: "active", watchdogDisabledInfo: null });
  cleanup();
});

describe("WatchdogDisabledBanner", () => {
  it("renders nothing while the watchdog is active", () => {
    const { container } = render(<WatchdogDisabledBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the alert when the watchdog is disabled", () => {
    usePanelStore.setState({
      watchdogStatus: "disabled",
      watchdogDisabledInfo: { attemptCount: 3, lastExitCode: 1, timestamp: 1700000000000 },
    });
    render(<WatchdogDisabledBanner />);
    expect(screen.getByText("Crash watchdog disabled")).toBeTruthy();
    expect(screen.getByText(/Deadlock detection stopped after 3 restart attempts/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Restart watchdog/i })).toBeTruthy();
  });

  it("falls back to generic copy when attemptCount is missing", () => {
    usePanelStore.setState({
      watchdogStatus: "disabled",
      watchdogDisabledInfo: null,
    });
    render(<WatchdogDisabledBanner />);
    expect(
      screen.getByText(/Deadlock detection stopped after repeated restart failures/i)
    ).toBeTruthy();
  });

  it("dispatches watchdog.restart when Restart watchdog is clicked", () => {
    usePanelStore.setState({
      watchdogStatus: "disabled",
      watchdogDisabledInfo: { attemptCount: 3, lastExitCode: null, timestamp: 0 },
    });
    render(<WatchdogDisabledBanner />);
    fireEvent.click(screen.getByRole("button", { name: /Restart watchdog/i }));
    expect(mockedDispatch).toHaveBeenCalledTimes(1);
    expect(mockedDispatch).toHaveBeenCalledWith("watchdog.restart", undefined, {
      source: "user",
    });
  });

  it("ignores rapid double-clicks while a restart is in flight", () => {
    usePanelStore.setState({
      watchdogStatus: "disabled",
      watchdogDisabledInfo: { attemptCount: 3, lastExitCode: null, timestamp: 0 },
    });
    render(<WatchdogDisabledBanner />);
    const button = screen.getByRole("button", { name: /Restart watchdog/i });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(mockedDispatch).toHaveBeenCalledTimes(1);
  });

  it("re-enables the button when dispatch returns ok=false", async () => {
    mockedDispatch.mockResolvedValueOnce({
      ok: false,
      error: { code: "EXECUTION_ERROR", message: "boom" },
    } as never);
    usePanelStore.setState({
      watchdogStatus: "disabled",
      watchdogDisabledInfo: { attemptCount: 3, lastExitCode: null, timestamp: 0 },
    });
    render(<WatchdogDisabledBanner />);
    const button = screen.getByRole("button", {
      name: /Restart watchdog/i,
    }) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(button);
    });
    expect(button.disabled).toBe(false);
    expect(button.textContent).toMatch(/Restart watchdog/);
  });

  describe("when the restart request fails", () => {
    const refused: ActionDispatchResult = {
      ok: false,
      error: { code: "EXECUTION_ERROR", message: "boom" },
    };

    const restartButton = () => screen.getByRole("button", { name: /Restart watchdog/i });
    const failureLine = () => screen.queryByTestId("watchdog-banner-restart-error");

    beforeEach(() => {
      usePanelStore.setState({
        watchdogStatus: "disabled",
        watchdogDisabledInfo: { attemptCount: 3, lastExitCode: null, timestamp: 0 },
      });
      useDiagnosticsStore.getState().reset();
    });

    it("says so on the banner and keeps Restart watchdog available", async () => {
      mockedDispatch.mockResolvedValueOnce(refused);
      render(<WatchdogDisabledBanner />);
      expect(failureLine()).toBeNull();
      expect(screen.queryByRole("button", { name: "Open Diagnostics" })).toBeNull();
      await act(async () => {
        fireEvent.click(restartButton());
      });
      expect(failureLine()?.textContent).toMatch(/Couldn't restart the crash watchdog/);
      expect(restartButton().getAttribute("aria-disabled")).toBeNull();
      // The standing explanation stays; the failure is added to it.
      expect(screen.getByText(/Deadlock detection stopped after 3 restart attempts/)).toBeTruthy();
    });

    it("reports a rejected dispatch the same way", async () => {
      mockedDispatch.mockRejectedValueOnce(new Error("IPC closed"));
      render(<WatchdogDisabledBanner />);
      await act(async () => {
        fireEvent.click(restartButton());
      });
      expect(failureLine()).not.toBeNull();
      expect(restartButton().getAttribute("aria-disabled")).toBeNull();
    });

    it("opens the Logs tab from the Diagnostics pointer", async () => {
      mockedDispatch.mockResolvedValueOnce(refused);
      render(<WatchdogDisabledBanner />);
      await act(async () => {
        fireEvent.click(restartButton());
      });
      fireEvent.click(screen.getByRole("button", { name: "Open Diagnostics" }));
      expect(useDiagnosticsStore.getState().isOpen).toBe(true);
      expect(useDiagnosticsStore.getState().activeTab).toBe("logs");
    });

    it("clears the line and the pointer when the retry starts, not when it ends", async () => {
      mockedDispatch.mockResolvedValueOnce(refused);
      render(<WatchdogDisabledBanner />);
      await act(async () => {
        fireEvent.click(restartButton());
      });
      expect(failureLine()).not.toBeNull();

      let settle!: (value: ActionDispatchResult) => void;
      mockedDispatch.mockReturnValueOnce(new Promise((resolve) => (settle = resolve)));
      await act(async () => {
        fireEvent.click(restartButton());
      });
      expect(mockedDispatch).toHaveBeenCalledTimes(2);
      expect(failureLine()).toBeNull();
      expect(screen.queryByRole("button", { name: "Open Diagnostics" })).toBeNull();
      expect(restartButton().getAttribute("aria-disabled")).toBe("true");

      await act(async () => settle({ ok: true, result: undefined }));
      expect(failureLine()).toBeNull();
    });
  });

  it("disappears when watchdogStatus transitions back to active", () => {
    usePanelStore.setState({
      watchdogStatus: "disabled",
      watchdogDisabledInfo: { attemptCount: 3, lastExitCode: null, timestamp: 0 },
    });
    const { container } = render(<WatchdogDisabledBanner />);
    expect(container.firstChild).not.toBeNull();
    act(() => {
      usePanelStore.setState({ watchdogStatus: "active", watchdogDisabledInfo: null });
    });
    expect(container.firstChild).toBeNull();
  });

  it("announces politely: a downed monitor is a standing condition, not an emergency", () => {
    usePanelStore.setState({
      watchdogStatus: "disabled",
      watchdogDisabledInfo: { attemptCount: 3, lastExitCode: null, timestamp: 0 },
    });
    render(<WatchdogDisabledBanner />);
    const status = screen.getByRole("status");
    expect(status.hasAttribute("aria-live")).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("× records a session dismissal for the coordinator rather than touching the watchdog", () => {
    usePanelStore.setState({
      watchdogStatus: "disabled",
      watchdogDisabledInfo: { attemptCount: 3, lastExitCode: null, timestamp: 0 },
    });
    useGlobalBannerDismissalStore.getState().reset("watchdog-disabled");
    render(<WatchdogDisabledBanner />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss watchdog warning" }));
    expect(useGlobalBannerDismissalStore.getState().dismissed.has("watchdog-disabled")).toBe(true);
    expect(usePanelStore.getState().watchdogStatus).toBe("disabled");
  });
});
