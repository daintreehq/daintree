// @vitest-environment jsdom
import { render, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { AllClearOverlay } from "../AllClearOverlay";

const OVERLAY_SELECTOR = "[aria-hidden='true']";

type AllClearPayload = { timestamp: number; shouldFlash: boolean };

let onAllAgentsClearCb: ((data: AllClearPayload) => void) | null = null;

function fireAllClear(shouldFlash = true) {
  onAllAgentsClearCb?.({ timestamp: Date.now(), shouldFlash });
}

beforeEach(() => {
  vi.useFakeTimers();
  onAllAgentsClearCb = null;

  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      terminal: {
        onAllAgentsClear: vi.fn((callback: (data: AllClearPayload) => void) => {
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
  it("renders the overlay when the event carries shouldFlash: true", () => {
    render(<AllClearOverlay />);

    act(() => {
      fireAllClear(true);
    });

    expect(document.body.querySelector(OVERLAY_SELECTOR)).toBeTruthy();
  });

  it("does not render before the callback fires", () => {
    render(<AllClearOverlay />);
    expect(document.body.querySelector(OVERLAY_SELECTOR)).toBeNull();
  });

  it("suppresses the overlay when the event carries shouldFlash: false", () => {
    // shouldFlash is computed main-process-side (flashEnabled, the master
    // enabled toggle, and the audio suppression chain) — see
    // AgentNotificationService.checkAllClear (#12185). The overlay trusts it
    // rather than recomputing suppression from its own settings mirror.
    render(<AllClearOverlay />);

    act(() => {
      fireAllClear(false);
    });

    expect(document.body.querySelector(OVERLAY_SELECTOR)).toBeNull();
  });

  it("suppresses the overlay when prefers-reduced-motion is set", () => {
    (window.matchMedia as ReturnType<typeof vi.fn>).mockReturnValue({ matches: true });
    render(<AllClearOverlay />);

    act(() => {
      fireAllClear(true);
    });

    expect(document.body.querySelector(OVERLAY_SELECTOR)).toBeNull();
  });

  it("suppresses the overlay when data-reduce-animations is true", () => {
    document.body.setAttribute("data-reduce-animations", "true");
    try {
      render(<AllClearOverlay />);

      act(() => {
        fireAllClear(true);
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
        fireAllClear(true);
      });

      expect(document.body.querySelector(OVERLAY_SELECTOR)).toBeNull();
    } finally {
      document.body.removeAttribute("data-performance-mode");
    }
  });

  it("hides via safety timeout when animationend never fires", () => {
    render(<AllClearOverlay />);

    act(() => {
      fireAllClear(true);
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
      fireAllClear(true);
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
});
