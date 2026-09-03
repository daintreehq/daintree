// @vitest-environment jsdom
import { render, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { AllClearOverlay } from "../AllClearOverlay";
import { useNotificationSettingsStore } from "@/store/notificationSettingsStore";

const OVERLAY_SELECTOR = "[aria-hidden='true']";

let onAllAgentsClearCb: ((data: { timestamp: number }) => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  onAllAgentsClearCb = null;

  // Suppressed-by-default is the point of #12185 — every test that expects
  // the overlay to actually fire must opt in explicitly.
  useNotificationSettingsStore.setState({
    enabled: true,
    flashEnabled: true,
    quietUntil: 0,
    quietHoursEnabled: false,
    quietHoursStartMin: 22 * 60,
    quietHoursEndMin: 8 * 60,
    quietHoursWeekdays: [],
    osDndActive: undefined,
  });

  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      terminal: {
        onAllAgentsClear: vi.fn((callback: (data: { timestamp: number }) => void) => {
          onAllAgentsClearCb = callback;
          return () => {
            onAllAgentsClearCb = null;
          };
        }),
      },
    },
  });

  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockReturnValue({ matches: false }),
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AllClearOverlay", () => {
  it("renders the overlay when onAllAgentsClear fires", () => {
    render(<AllClearOverlay />);

    act(() => {
      onAllAgentsClearCb?.({ timestamp: Date.now() });
    });

    expect(document.body.querySelector(OVERLAY_SELECTOR)).toBeTruthy();
  });

  it("does not render before the callback fires", () => {
    render(<AllClearOverlay />);
    expect(document.body.querySelector(OVERLAY_SELECTOR)).toBeNull();
  });

  it("suppresses the overlay when prefers-reduced-motion is set", () => {
    (window.matchMedia as ReturnType<typeof vi.fn>).mockReturnValue({ matches: true });
    render(<AllClearOverlay />);

    act(() => {
      onAllAgentsClearCb?.({ timestamp: Date.now() });
    });

    expect(document.body.querySelector(OVERLAY_SELECTOR)).toBeNull();
  });

  it("suppresses the overlay when data-reduce-animations is true", () => {
    document.body.setAttribute("data-reduce-animations", "true");
    try {
      render(<AllClearOverlay />);

      act(() => {
        onAllAgentsClearCb?.({ timestamp: Date.now() });
      });

      expect(document.body.querySelector(OVERLAY_SELECTOR)).toBeNull();
    } finally {
      document.body.removeAttribute("data-reduce-animations");
    }
  });

  it("suppresses the overlay when data-performance-mode is true", () => {
    document.body.setAttribute("data-performance-mode", "true");
    try {
      render(<AllClearOverlay />);

      act(() => {
        onAllAgentsClearCb?.({ timestamp: Date.now() });
      });

      expect(document.body.querySelector(OVERLAY_SELECTOR)).toBeNull();
    } finally {
      document.body.removeAttribute("data-performance-mode");
    }
  });

  it("hides via safety timeout when animationend never fires", () => {
    render(<AllClearOverlay />);

    act(() => {
      onAllAgentsClearCb?.({ timestamp: Date.now() });
    });

    expect(document.body.querySelector(OVERLAY_SELECTOR)).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(document.body.querySelector(OVERLAY_SELECTOR)).toBeNull();
  });

  it("clears the safety timer on unmount", () => {
    const { unmount } = render(<AllClearOverlay />);

    act(() => {
      onAllAgentsClearCb?.({ timestamp: Date.now() });
    });

    unmount();

    expect(() => {
      act(() => {
        vi.advanceTimersByTime(500);
      });
    }).not.toThrow();
  });

  it("cleans up onAllAgentsClear listener on unmount", () => {
    const { unmount } = render(<AllClearOverlay />);
    unmount();
    expect(onAllAgentsClearCb).toBeNull();
  });

  it("suppresses the overlay when flashEnabled is off (the new default)", () => {
    useNotificationSettingsStore.setState({ flashEnabled: false });
    render(<AllClearOverlay />);

    act(() => {
      onAllAgentsClearCb?.({ timestamp: Date.now() });
    });

    expect(document.body.querySelector(OVERLAY_SELECTOR)).toBeNull();
  });

  it("suppresses the overlay when notifications are disabled entirely", () => {
    useNotificationSettingsStore.setState({ enabled: false });
    render(<AllClearOverlay />);

    act(() => {
      onAllAgentsClearCb?.({ timestamp: Date.now() });
    });

    expect(document.body.querySelector(OVERLAY_SELECTOR)).toBeNull();
  });

  it("suppresses the overlay while session-muted", () => {
    useNotificationSettingsStore.setState({ quietUntil: Date.now() + 60_000 });
    render(<AllClearOverlay />);

    act(() => {
      onAllAgentsClearCb?.({ timestamp: Date.now() });
    });

    expect(document.body.querySelector(OVERLAY_SELECTOR)).toBeNull();
  });

  it("suppresses the overlay during scheduled quiet hours", () => {
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    useNotificationSettingsStore.setState({
      quietHoursEnabled: true,
      quietHoursStartMin: 0,
      quietHoursEndMin: 0,
      quietHoursWeekdays: [],
    });
    // startMin === endMin disables the window in isScheduledQuietNow — cover
    // the "currently inside the window" branch explicitly instead.
    useNotificationSettingsStore.setState({
      quietHoursStartMin: nowMin,
      quietHoursEndMin: (nowMin + 60) % 1440,
    });
    render(<AllClearOverlay />);

    act(() => {
      onAllAgentsClearCb?.({ timestamp: Date.now() });
    });

    expect(document.body.querySelector(OVERLAY_SELECTOR)).toBeNull();
  });

  it("suppresses the overlay when OS DND is active", () => {
    useNotificationSettingsStore.setState({ osDndActive: true });
    render(<AllClearOverlay />);

    act(() => {
      onAllAgentsClearCb?.({ timestamp: Date.now() });
    });

    expect(document.body.querySelector(OVERLAY_SELECTOR)).toBeNull();
  });

  it("still renders when OS DND state is unknown (undefined means do-not-gate)", () => {
    useNotificationSettingsStore.setState({ osDndActive: undefined });
    render(<AllClearOverlay />);

    act(() => {
      onAllAgentsClearCb?.({ timestamp: Date.now() });
    });

    expect(document.body.querySelector(OVERLAY_SELECTOR)).toBeTruthy();
  });
});
