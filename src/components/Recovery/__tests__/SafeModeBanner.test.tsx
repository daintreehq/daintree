// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";
import { SafeModeBanner } from "../SafeModeBanner";
import { useSafeModeStore } from "@/store/safeModeStore";

const resetAndRelaunch = vi.fn();
const restorePanel = vi.fn();

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
  resetAndRelaunch.mockReset();
  resetAndRelaunch.mockResolvedValue(undefined);
  restorePanel.mockReset();
  restorePanel.mockResolvedValue(undefined);
  // Minimal stub of window.electron for the restart and restore-panel actions
  Object.defineProperty(window, "electron", {
    value: {
      app: { resetAndRelaunch },
      crashRecovery: { restorePanel },
    },
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

  it("calls resetAndRelaunch when Restart normally is clicked, and disables on subsequent clicks", () => {
    useSafeModeStore.setState({ safeMode: true });
    render(<SafeModeBanner />);
    const button = screen.getByRole("button", { name: /Restart normally/i });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(resetAndRelaunch).toHaveBeenCalledTimes(1);
  });

  it("re-enables the restart button when resetAndRelaunch rejects", async () => {
    resetAndRelaunch.mockRejectedValueOnce(new Error("EROFS"));
    useSafeModeStore.setState({ safeMode: true });
    render(<SafeModeBanner />);
    const button = screen.getByRole("button", { name: /Restart normally/i }) as HTMLButtonElement;
    fireEvent.click(button);
    expect(button.disabled).toBe(true);
    // Wait one microtask tick for the rejected promise to flush
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

  it("renders the quarantine-only headline when quarantine fired without safe mode", () => {
    useSafeModeStore.setState({
      safeMode: false,
      quarantinedPanels: [
        {
          id: "panel-a",
          kind: "terminal",
          title: "Bash",
          cwd: "/repo/a",
          suspectCount: 2,
        },
      ],
    });
    render(<SafeModeBanner />);
    expect(screen.getByText("Some panels were quarantined")).toBeTruthy();
    // No restart action when not in safe mode
    expect(screen.queryByRole("button", { name: /Restart normally/i })).toBeNull();
  });

  it("lists each quarantined panel with a Restore panel button in the popover", () => {
    useSafeModeStore.setState({
      safeMode: true,
      quarantinedPanels: [
        {
          id: "panel-a",
          kind: "terminal",
          title: "Bash",
          cwd: "/repo/a",
          suspectCount: 2,
        },
        {
          id: "panel-b",
          kind: "terminal",
          title: "Claude",
          cwd: "/repo/b",
          suspectCount: 3,
        },
      ],
    });
    render(<SafeModeBanner />);
    fireEvent.click(screen.getByRole("button", { name: /Show details/i }));
    expect(screen.getByText("Bash")).toBeTruthy();
    expect(screen.getByText("/repo/a")).toBeTruthy();
    expect(screen.getByText("Claude")).toBeTruthy();
    expect(screen.getByText("/repo/b")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Restore panel/i })).toHaveLength(2);
  });

  it("calls crashRecovery.restorePanel, removes the entry, and triggers a relaunch", async () => {
    useSafeModeStore.setState({
      safeMode: true,
      quarantinedPanels: [
        {
          id: "panel-a",
          kind: "terminal",
          title: "Bash",
          cwd: "/repo/a",
          suspectCount: 2,
        },
      ],
    });
    render(<SafeModeBanner />);
    fireEvent.click(screen.getByRole("button", { name: /Show details/i }));
    fireEvent.click(screen.getByRole("button", { name: /Restore panel/i }));
    expect(restorePanel).toHaveBeenCalledTimes(1);
    expect(restorePanel).toHaveBeenCalledWith("panel-a");
    await waitFor(() => {
      expect(useSafeModeStore.getState().quarantinedPanels).toBeUndefined();
    });
    expect(resetAndRelaunch).toHaveBeenCalledTimes(1);
  });

  it("keeps the entry visible if restorePanel rejects", async () => {
    restorePanel.mockRejectedValueOnce(new Error("EROFS"));
    useSafeModeStore.setState({
      safeMode: true,
      quarantinedPanels: [
        {
          id: "panel-a",
          kind: "terminal",
          title: "Bash",
          cwd: "/repo/a",
          suspectCount: 2,
        },
      ],
    });
    render(<SafeModeBanner />);
    fireEvent.click(screen.getByRole("button", { name: /Show details/i }));
    fireEvent.click(screen.getByRole("button", { name: /Restore panel/i }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(useSafeModeStore.getState().quarantinedPanels?.length).toBe(1);
    // Button label reverts after the rejection
    expect(screen.getByRole("button", { name: /Restore panel/i })).toBeTruthy();
  });

  it("hides the banner entirely when no safe mode and no quarantined panels", () => {
    useSafeModeStore.setState({ safeMode: false, quarantinedPanels: undefined });
    const { container } = render(<SafeModeBanner />);
    expect(container.firstChild).toBeNull();
  });
});
