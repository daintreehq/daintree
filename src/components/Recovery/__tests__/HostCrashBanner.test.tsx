// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import type { CrashType } from "@shared/types/pty-host";

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

import { HostCrashBanner } from "../HostCrashBanner";
import { usePanelStore } from "@/store/panelStore";
import { actionService } from "@/services/ActionService";

const mockedDispatch = vi.mocked(actionService.dispatch);

beforeEach(() => {
  mockedDispatch.mockReset();
  mockedDispatch.mockResolvedValue({ ok: true, result: undefined } as never);
  usePanelStore.setState({ backendStatus: "connected", lastCrashType: null });
  cleanup();
});

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

describe("HostCrashBanner", () => {
  it("renders nothing when backend is connected", () => {
    const { container } = render(<HostCrashBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when backend is recovering (sub-Doherty gate)", () => {
    usePanelStore.setState({ backendStatus: "recovering" });
    const { container } = render(<HostCrashBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("announces an automatic restart politely; only the exhausted crash is an alert", () => {
    vi.useFakeTimers();
    usePanelStore.setState({ backendStatus: "recovering" });
    render(<HostCrashBanner />);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    vi.useRealTimers();
  });

  it("renders recovering banner after Doherty threshold", () => {
    vi.useFakeTimers();
    usePanelStore.setState({ backendStatus: "recovering" });
    const { container } = render(<HostCrashBanner />);
    expect(container.firstChild).toBeNull();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(container.firstChild).not.toBeNull();
    vi.useRealTimers();
  });

  it("shows spinner and restarting copy in recovering variant", () => {
    vi.useFakeTimers();
    usePanelStore.setState({ backendStatus: "recovering" });
    render(<HostCrashBanner />);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.getByText("Terminal service restarting")).toBeTruthy();
    expect(
      screen.getByText(/The terminal backend stopped and is restarting automatically/)
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Restart service/i })).toBeNull();
    vi.useRealTimers();
  });

  it("hides recovering banner when recovering resolves within Doherty threshold", () => {
    vi.useFakeTimers();
    usePanelStore.setState({ backendStatus: "recovering" });
    const { container } = render(<HostCrashBanner />);
    act(() => {
      usePanelStore.setState({ backendStatus: "connected", lastCrashType: null });
    });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(container.firstChild).toBeNull();
    vi.useRealTimers();
  });

  it("renders the OUT_OF_MEMORY copy when applicable", () => {
    usePanelStore.setState({ backendStatus: "disconnected", lastCrashType: "OUT_OF_MEMORY" });
    render(<HostCrashBanner />);
    expect(screen.getByText("Terminal service ran out of memory")).toBeTruthy();
    expect(screen.getByText(/Close unused terminals/i)).toBeTruthy();
  });

  it("renders the SIGNAL_TERMINATED copy when applicable", () => {
    usePanelStore.setState({ backendStatus: "disconnected", lastCrashType: "SIGNAL_TERMINATED" });
    render(<HostCrashBanner />);
    expect(screen.getByText("Terminal service was terminated")).toBeTruthy();
  });

  it("renders the ASSERTION_FAILURE copy when applicable", () => {
    usePanelStore.setState({ backendStatus: "disconnected", lastCrashType: "ASSERTION_FAILURE" });
    render(<HostCrashBanner />);
    expect(screen.getByText("Terminal service hit an assertion failure")).toBeTruthy();
  });

  it("renders the CLEAN_EXIT copy when applicable", () => {
    usePanelStore.setState({ backendStatus: "disconnected", lastCrashType: "CLEAN_EXIT" });
    render(<HostCrashBanner />);
    expect(screen.getByText("Terminal service stopped unexpectedly")).toBeTruthy();
  });

  it("renders generic copy for UNKNOWN_CRASH", () => {
    usePanelStore.setState({ backendStatus: "disconnected", lastCrashType: "UNKNOWN_CRASH" });
    render(<HostCrashBanner />);
    expect(screen.getByText("Terminal service crashed")).toBeTruthy();
  });

  it("falls back to generic copy when lastCrashType is null", () => {
    usePanelStore.setState({ backendStatus: "disconnected", lastCrashType: null });
    render(<HostCrashBanner />);
    expect(screen.getByText("Terminal service crashed")).toBeTruthy();
  });

  it("uses role=alert without redundant aria-live", () => {
    usePanelStore.setState({ backendStatus: "disconnected", lastCrashType: null });
    render(<HostCrashBanner />);
    const alert = screen.getByRole("alert");
    expect(alert.hasAttribute("aria-live")).toBe(false);
  });

  it("does not render a dismiss button", () => {
    usePanelStore.setState({ backendStatus: "disconnected", lastCrashType: null });
    render(<HostCrashBanner />);
    expect(screen.queryByRole("button", { name: /dismiss/i })).toBeNull();
  });

  it("dispatches terminal.restartService when Restart service is clicked", () => {
    usePanelStore.setState({ backendStatus: "disconnected", lastCrashType: null });
    render(<HostCrashBanner />);
    fireEvent.click(screen.getByRole("button", { name: /Restart service/i }));
    expect(mockedDispatch).toHaveBeenCalledTimes(1);
    expect(mockedDispatch).toHaveBeenCalledWith("terminal.restartService", undefined, {
      source: "user",
    });
  });

  it("ignores rapid double-clicks while a restart is in flight", () => {
    usePanelStore.setState({ backendStatus: "disconnected", lastCrashType: null });
    render(<HostCrashBanner />);
    const button = screen.getByRole("button", { name: /Restart service/i });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(mockedDispatch).toHaveBeenCalledTimes(1);
  });

  it("re-enables the button when the dispatch returns ok=false", async () => {
    mockedDispatch.mockResolvedValueOnce({
      ok: false,
      error: { code: "EXECUTION_ERROR", message: "boom" },
    } as never);
    usePanelStore.setState({ backendStatus: "disconnected", lastCrashType: null });
    render(<HostCrashBanner />);
    const button = screen.getByRole("button", { name: /Restart service/i }) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(button);
    });
    expect(button.disabled).toBe(false);
    expect(button.textContent).toMatch(/Restart service/);
  });

  it("re-enables the button when the dispatch returns DISABLED", async () => {
    mockedDispatch.mockResolvedValueOnce({
      ok: false,
      error: { code: "DISABLED" },
    } as never);
    usePanelStore.setState({ backendStatus: "disconnected", lastCrashType: null });
    render(<HostCrashBanner />);
    const button = screen.getByRole("button", { name: /Restart service/i }) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(button);
    });
    expect(button.disabled).toBe(false);
  });

  it("disappears when backend transitions back to connected", () => {
    usePanelStore.setState({ backendStatus: "disconnected", lastCrashType: "UNKNOWN_CRASH" });
    const { container } = render(<HostCrashBanner />);
    expect(container.firstChild).not.toBeNull();
    act(() => {
      usePanelStore.setState({ backendStatus: "connected", lastCrashType: null });
    });
    expect(container.firstChild).toBeNull();
  });

  it("covers all CrashType variants with distinct titles", () => {
    const expected: Array<[CrashType, string]> = [
      ["OUT_OF_MEMORY", "Terminal service ran out of memory"],
      ["ASSERTION_FAILURE", "Terminal service hit an assertion failure"],
      ["SIGNAL_TERMINATED", "Terminal service was terminated"],
      ["UNKNOWN_CRASH", "Terminal service crashed"],
      ["CLEAN_EXIT", "Terminal service stopped unexpectedly"],
    ];
    for (const [type, title] of expected) {
      usePanelStore.setState({ backendStatus: "disconnected", lastCrashType: type });
      const { unmount } = render(<HostCrashBanner />);
      expect(screen.getByRole("alert")).toBeTruthy();
      expect(screen.getByText(title)).toBeTruthy();
      expect(screen.getByRole("button", { name: /Restart service/i })).toBeTruthy();
      unmount();
    }
  });
});
