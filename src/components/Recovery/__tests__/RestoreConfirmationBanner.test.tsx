// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { RestoreConfirmationBanner } from "../RestoreConfirmationBanner";
import { useRestoreConfirmationStore } from "@/store/restoreConfirmationStore";

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
  vi.useFakeTimers();
  useRestoreConfirmationStore.setState({ visible: false, suspectCount: 0, crashCount: 0 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("RestoreConfirmationBanner", () => {
  it("renders nothing when not visible", () => {
    const { container } = render(<RestoreConfirmationBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders info copy for non-suspect restore", () => {
    useRestoreConfirmationStore.setState({ visible: true, suspectCount: 0, crashCount: 1 });
    render(<RestoreConfirmationBanner />);
    expect(screen.getByText("Session recovered after unexpected exit")).toBeTruthy();
    expect(screen.queryByText(/may be affected/)).toBeNull();
  });

  it("renders warning copy with suspect count (singular)", () => {
    useRestoreConfirmationStore.setState({ visible: true, suspectCount: 1, crashCount: 1 });
    render(<RestoreConfirmationBanner />);
    expect(screen.getByText("Session recovered after unexpected exit")).toBeTruthy();
    expect(screen.getByText("1 panel created near the crash may be affected.")).toBeTruthy();
  });

  it("renders warning copy with suspect count (plural)", () => {
    useRestoreConfirmationStore.setState({ visible: true, suspectCount: 3, crashCount: 1 });
    render(<RestoreConfirmationBanner />);
    expect(screen.getByText("Session recovered after unexpected exit")).toBeTruthy();
    expect(screen.getByText("3 panels created near the crash may be affected.")).toBeTruthy();
  });

  it("is informational when nothing is implicated and a warning once panels are", () => {
    useRestoreConfirmationStore.setState({ visible: true, suspectCount: 0, crashCount: 1 });
    const clean = render(<RestoreConfirmationBanner />);
    expect(screen.getByRole("status").style.backgroundColor).toContain("--color-status-info");
    clean.unmount();

    useRestoreConfirmationStore.setState({ visible: true, suspectCount: 2, crashCount: 1 });
    render(<RestoreConfirmationBanner />);
    expect(screen.getByRole("status").style.backgroundColor).toContain("--color-status-warning");
  });

  it("auto-dismisses non-suspect banner after 10 seconds", () => {
    useRestoreConfirmationStore.setState({ visible: true, suspectCount: 0, crashCount: 1 });
    const { container } = render(<RestoreConfirmationBanner />);
    expect(container.firstChild).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(useRestoreConfirmationStore.getState().visible).toBe(false);
  });

  it("does not auto-dismiss suspect banner", () => {
    useRestoreConfirmationStore.setState({ visible: true, suspectCount: 2, crashCount: 1 });
    const { container } = render(<RestoreConfirmationBanner />);
    expect(container.firstChild).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(20_000);
    });

    expect(useRestoreConfirmationStore.getState().visible).toBe(true);
  });

  it("manual dismiss hides the banner", () => {
    useRestoreConfirmationStore.setState({ visible: true, suspectCount: 0, crashCount: 1 });
    render(<RestoreConfirmationBanner />);
    const dismissBtn = screen.getByRole("button", { name: /Dismiss recovery confirmation/i });
    act(() => {
      fireEvent.click(dismissBtn);
    });
    expect(useRestoreConfirmationStore.getState().visible).toBe(false);
  });

  it("uses role=status without redundant aria-live", () => {
    useRestoreConfirmationStore.setState({ visible: true, suspectCount: 0, crashCount: 1 });
    render(<RestoreConfirmationBanner />);
    const region = screen.getByRole("status");
    expect(region).toBeTruthy();
    expect(region.hasAttribute("aria-live")).toBe(false);
  });

  it("cleans up timer on unmount", () => {
    useRestoreConfirmationStore.setState({ visible: true, suspectCount: 0, crashCount: 1 });
    const { unmount } = render(<RestoreConfirmationBanner />);

    unmount();

    // Advance past the timer — should not cause any setState on unmounted component
    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    // Timer cleanup prevented dismiss from firing; store still visible
    expect(useRestoreConfirmationStore.getState().visible).toBe(true);
  });
});
