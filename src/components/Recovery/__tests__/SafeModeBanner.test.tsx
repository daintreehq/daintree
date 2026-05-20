// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act, within, waitFor } from "@testing-library/react";
import { SafeModeBanner } from "../SafeModeBanner";
import { useSafeModeStore } from "@/store/safeModeStore";

const resetAndRelaunch = vi.fn();
const clearQuarantinedPanel = vi.fn();

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

import { actionService } from "@/services/ActionService";

const mockedDispatch = vi.mocked(actionService.dispatch);

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
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
  resetAndRelaunch.mockReset();
  resetAndRelaunch.mockResolvedValue(undefined);
  clearQuarantinedPanel.mockReset();
  clearQuarantinedPanel.mockResolvedValue({ cleared: true });
  mockedDispatch.mockReset();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  mockedDispatch.mockResolvedValue({ ok: true, result: undefined } as never);
  // Minimal stub of window.electron.app for the restart action
  Object.defineProperty(window, "electron", {
    value: { app: { resetAndRelaunch, clearQuarantinedPanel } },
    writable: true,
    configurable: true,
  });
  useSafeModeStore.setState({
    safeMode: false,
    dismissed: false,
    crashCount: undefined,
    skippedPanelCount: undefined,
    lastCrashAt: undefined,
    quarantinedPanels: undefined,
  });
  cleanup();
});

describe("SafeModeBanner", () => {
  it("renders nothing when safe mode is inactive", () => {
    const { container } = render(<SafeModeBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when dismissed", () => {
    useSafeModeStore.setState({ safeMode: true, dismissed: true });
    const { container } = render(<SafeModeBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the calm headline without crash count or relative time", () => {
    useSafeModeStore.setState({
      safeMode: true,
      crashCount: 3,
      skippedPanelCount: 4,
      lastCrashAt: Date.now() - 30 * 60_000,
    });
    render(<SafeModeBanner />);
    expect(screen.getByText("Safe mode — panels weren't restored")).toBeTruthy();
    expect(screen.queryByText(/\d+ crash/)).toBeNull();
    expect(screen.queryByText(/\d+ panel/)).toBeNull();
    expect(screen.queryByText(/ago/)).toBeNull();
  });

  it("surfaces crash count and relative time inside the details popover", () => {
    useSafeModeStore.setState({
      safeMode: true,
      crashCount: 3,
      lastCrashAt: Date.now() - 30 * 60_000,
    });
    render(<SafeModeBanner />);
    fireEvent.click(screen.getByRole("button", { name: /Show details/i }));
    expect(screen.getByText(/3 crashes detected, last 30m ago/)).toBeTruthy();
  });

  it("renders 'Last crash {time}' when only a timestamp is present", () => {
    useSafeModeStore.setState({
      safeMode: true,
      crashCount: undefined,
      lastCrashAt: Date.now() - 30 * 60_000,
    });
    render(<SafeModeBanner />);
    fireEvent.click(screen.getByRole("button", { name: /Show details/i }));
    expect(screen.getByText(/Last crash 30m ago/)).toBeTruthy();
  });

  it("uses singular forms for one crash and one skipped panel", () => {
    useSafeModeStore.setState({
      safeMode: true,
      crashCount: 1,
      skippedPanelCount: 1,
    });
    render(<SafeModeBanner />);
    fireEvent.click(screen.getByRole("button", { name: /Show details/i }));
    expect(screen.getByText(/^1 crash detected$/)).toBeTruthy();
    expect(screen.getByText(/1 panel was skipped/)).toBeTruthy();
  });

  it("hides Show details when no crash data and no skipped panels", () => {
    useSafeModeStore.setState({ safeMode: true, skippedPanelCount: 0 });
    render(<SafeModeBanner />);
    expect(screen.queryByRole("button", { name: /Show details/i })).toBeNull();
  });

  it("hides Show details when crash fields contain non-finite values", () => {
    useSafeModeStore.setState({
      safeMode: true,
      crashCount: Number.NaN,
      lastCrashAt: Number.NaN,
      skippedPanelCount: 0,
    });
    render(<SafeModeBanner />);
    expect(screen.queryByRole("button", { name: /Show details/i })).toBeNull();
  });

  it("shows Show details when panels were skipped", () => {
    useSafeModeStore.setState({ safeMode: true, skippedPanelCount: 4 });
    render(<SafeModeBanner />);
    expect(screen.getByRole("button", { name: /Show details/i })).toBeTruthy();
  });

  it("shows Show details when crashes exist but no panels were skipped", () => {
    useSafeModeStore.setState({
      safeMode: true,
      crashCount: 2,
      skippedPanelCount: 0,
    });
    render(<SafeModeBanner />);
    expect(screen.getByRole("button", { name: /Show details/i })).toBeTruthy();
  });

  it("opens confirm dialog when Restart normally is clicked, does not call resetAndRelaunch", () => {
    useSafeModeStore.setState({ safeMode: true });
    render(<SafeModeBanner />);
    fireEvent.click(screen.getByRole("button", { name: /Restart normally/i }));
    expect(screen.getByText("Restart Daintree normally?")).toBeTruthy();
    expect(
      screen.getByText(/All running terminals and agent sessions will be killed/)
    ).toBeTruthy();
    expect(resetAndRelaunch).not.toHaveBeenCalled();
  });

  it("confirming the dialog calls resetAndRelaunch", () => {
    useSafeModeStore.setState({ safeMode: true });
    render(<SafeModeBanner />);
    fireEvent.click(screen.getByRole("button", { name: /Restart normally/i }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: /^Restart normally$/ })
    );
    expect(resetAndRelaunch).toHaveBeenCalledTimes(1);
  });

  it("canceling the dialog does not call resetAndRelaunch", async () => {
    useSafeModeStore.setState({ safeMode: true });
    render(<SafeModeBanner />);
    fireEvent.click(screen.getByRole("button", { name: /Restart normally/i }));
    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));
    expect(resetAndRelaunch).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByText("Restart Daintree normally?")).toBeNull();
    });
  });

  it("View logs dispatches logs.openFile", () => {
    useSafeModeStore.setState({ safeMode: true });
    render(<SafeModeBanner />);
    fireEvent.click(screen.getByRole("button", { name: /Restart normally/i }));
    fireEvent.click(screen.getByRole("button", { name: /View logs/i }));
    expect(mockedDispatch).toHaveBeenCalledWith("logs.openFile", undefined, { source: "user" });
  });

  it("re-enables the restart button when resetAndRelaunch rejects", async () => {
    resetAndRelaunch.mockRejectedValueOnce(new Error("EROFS"));
    useSafeModeStore.setState({ safeMode: true });
    render(<SafeModeBanner />);
    const button = screen.getByRole("button", { name: /Restart normally/i }) as HTMLButtonElement;
    fireEvent.click(button);
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: /^Restart normally$/ })
    );
    expect(button.disabled).toBe(true);
    await act(async () => {
      await Promise.resolve();
    });
    expect(button.disabled).toBe(false);
    expect(button.textContent).toMatch(/Restart normally/);
  });

  it("uses role=status without redundant aria-live", () => {
    useSafeModeStore.setState({ safeMode: true });
    render(<SafeModeBanner />);
    const region = screen.getByRole("status");
    expect(region).toBeTruthy();
    expect(region.hasAttribute("aria-live")).toBe(false);
  });

  it("renders one row per quarantined panel inside the popover", () => {
    useSafeModeStore.setState({
      safeMode: true,
      crashCount: 3,
      skippedPanelCount: 2,
      quarantinedPanels: [
        { id: "p1", kind: "terminal", title: "Crashy build", cwd: "/repo/foo" },
        { id: "p2", kind: "terminal", title: "Another", worktreeId: "wt-issue-1" },
      ],
    });
    render(<SafeModeBanner />);
    fireEvent.click(screen.getByRole("button", { name: /Show details/i }));
    expect(screen.getByText("Crashy build")).toBeTruthy();
    expect(screen.getByText("Another")).toBeTruthy();
    expect(screen.getByText("/repo/foo")).toBeTruthy();
    expect(screen.getByText("wt-issue-1")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Restore panel/ })).toHaveLength(2);
  });

  it("falls back to count-only copy when ledger has no quarantined entries", () => {
    useSafeModeStore.setState({
      safeMode: true,
      skippedPanelCount: 4,
      quarantinedPanels: [],
    });
    render(<SafeModeBanner />);
    fireEvent.click(screen.getByRole("button", { name: /Show details/i }));
    expect(screen.getByText(/4 panels were skipped/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Restore panel/ })).toBeNull();
  });

  it("clicking Restore panel calls clearQuarantinedPanel and shows the restoring hint", async () => {
    useSafeModeStore.setState({
      safeMode: true,
      crashCount: 2,
      skippedPanelCount: 1,
      quarantinedPanels: [{ id: "p1", kind: "terminal", title: "Bad" }],
    });
    render(<SafeModeBanner />);
    fireEvent.click(screen.getByRole("button", { name: /Show details/i }));
    fireEvent.click(screen.getByRole("button", { name: /Restore panel/ }));
    await waitFor(() => {
      expect(clearQuarantinedPanel).toHaveBeenCalledWith("p1");
    });
    await waitFor(() => {
      expect(screen.getByText(/Restoring on next launch/)).toBeTruthy();
    });
  });

  it("uses the singular phrasing for one quarantined panel", () => {
    useSafeModeStore.setState({
      safeMode: true,
      crashCount: 2,
      skippedPanelCount: 1,
      quarantinedPanels: [{ id: "p1", kind: "terminal", title: "Solo" }],
    });
    render(<SafeModeBanner />);
    fireEvent.click(screen.getByRole("button", { name: /Show details/i }));
    expect(screen.getByText(/^1 panel was quarantined/)).toBeTruthy();
  });

  it("hides the banner when dismiss is clicked", () => {
    useSafeModeStore.setState({ safeMode: true });
    const { container } = render(<SafeModeBanner />);
    const dismiss = screen.getByRole("button", { name: /Dismiss safe mode banner/i });
    act(() => {
      fireEvent.click(dismiss);
    });
    expect(container.firstChild).toBeNull();
    expect(useSafeModeStore.getState().dismissed).toBe(true);
  });
});
