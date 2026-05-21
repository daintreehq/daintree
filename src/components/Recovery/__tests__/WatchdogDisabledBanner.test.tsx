// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
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
import { actionService } from "@/services/ActionService";

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

  it("uses role=alert without redundant aria-live", () => {
    usePanelStore.setState({
      watchdogStatus: "disabled",
      watchdogDisabledInfo: { attemptCount: 3, lastExitCode: null, timestamp: 0 },
    });
    render(<WatchdogDisabledBanner />);
    const alert = screen.getByRole("alert");
    expect(alert.hasAttribute("aria-live")).toBe(false);
  });

  it("does not render a dismiss button", () => {
    usePanelStore.setState({
      watchdogStatus: "disabled",
      watchdogDisabledInfo: { attemptCount: 3, lastExitCode: null, timestamp: 0 },
    });
    render(<WatchdogDisabledBanner />);
    expect(screen.queryByRole("button", { name: /dismiss/i })).toBeNull();
  });
});
