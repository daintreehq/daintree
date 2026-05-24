// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { TerminalCountWarning } from "../TerminalCountWarning";

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("zustand/react/shallow", () => ({
  useShallow: (fn: (...args: unknown[]) => unknown) => fn,
}));

const panelState = {
  panelsById: {} as Record<string, unknown>,
  panelIds: [] as string[],
  trashPanel: vi.fn(),
};

vi.mock("@/store/panelStore", () => ({
  usePanelStore: Object.assign(
    (selector: (s: typeof panelState) => unknown) => selector(panelState),
    { getState: () => panelState }
  ),
}));

const limitState = {
  softWarningLimit: 4,
  warningsDisabled: false,
  lastSoftWarningDismissedAt: null as number | null,
  dismissSoftWarning: vi.fn(),
  initializeFromHardware: vi.fn().mockResolvedValue(undefined),
};

vi.mock("@/store/panelLimitStore", () => ({
  usePanelLimitStore: (selector: (s: typeof limitState) => unknown) => selector(limitState),
  shouldShowSoftWarning: (
    count: number,
    limit: number,
    disabled: boolean,
    dismissedAt: number | null
  ) => {
    if (disabled) return false;
    if (count < limit) return false;
    if (dismissedAt !== null && count <= dismissedAt) return false;
    return true;
  },
}));

const requestPanelCloseMock = vi.hoisted(() => vi.fn());
vi.mock("@/services/terminal/optimisticPanelClose", () => ({
  requestPanelClose: requestPanelCloseMock,
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

beforeEach(() => {
  panelState.panelsById = {
    a: { id: "a", location: "main", agentState: "working", ephemeral: false },
    b: { id: "b", location: "main", agentState: "working", ephemeral: false },
    c: { id: "c", location: "main", agentState: "working", ephemeral: false },
    d: { id: "d", location: "main", agentState: "working", ephemeral: false },
    e: { id: "e", location: "main", agentState: "working", ephemeral: false },
  };
  panelState.panelIds = ["a", "b", "c", "d", "e"];
  panelState.trashPanel = vi.fn();
  requestPanelCloseMock.mockClear();
  limitState.softWarningLimit = 4;
  limitState.warningsDisabled = false;
  limitState.lastSoftWarningDismissedAt = null;
  limitState.dismissSoftWarning = vi.fn();
  limitState.initializeFromHardware = vi.fn().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TerminalCountWarning", () => {
  it("renders a polite status live region (not an assertive alert)", () => {
    render(<TerminalCountWarning />);
    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.getAttribute("aria-atomic")).toBe("true");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("dismiss button uses focus-visible outline (not focus:ring)", () => {
    render(<TerminalCountWarning />);
    const button = screen.getByRole("button", { name: /dismiss warning/i });
    const className = button.className;
    expect(className).toContain("focus-visible:outline");
    expect(className).toContain("focus-visible:outline-daintree-accent");
    expect(className).not.toMatch(/(^|\s)focus:ring-/);
  });

  it("cancels its requestAnimationFrame on unmount", () => {
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 42 as number);
    const cancelSpy = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const { unmount } = render(<TerminalCountWarning />);
    expect(rafSpy).toHaveBeenCalled();
    unmount();
    expect(cancelSpy).toHaveBeenCalledWith(42);
  });

  it("renders nothing when below the soft warning threshold", () => {
    limitState.softWarningLimit = 100;
    const { container } = render(<TerminalCountWarning />);
    expect(container.innerHTML).toBe("");
  });

  it("inline cleanup button has a focus-visible outline (no focus:ring)", () => {
    panelState.panelsById.f = {
      id: "f",
      location: "main",
      agentState: "completed",
      ephemeral: false,
    };
    panelState.panelIds = [...panelState.panelIds, "f"];
    render(<TerminalCountWarning />);
    const button = screen.getByRole("button", { name: /close.*completed agent/i });
    const className = button.className;
    expect(className).toContain("focus-visible:outline");
    expect(className).toContain("focus-visible:outline-daintree-accent");
    expect(className).not.toMatch(/(^|\s)focus:ring-/);
  });

  it("routes completed-agent cleanup through optimistic close", () => {
    panelState.panelsById.f = {
      id: "f",
      location: "grid",
      agentState: "completed",
      ephemeral: false,
    };
    panelState.panelIds = [...panelState.panelIds, "f"];
    render(<TerminalCountWarning />);

    fireEvent.click(screen.getByRole("button", { name: /close.*completed agent/i }));

    expect(requestPanelCloseMock).toHaveBeenCalledTimes(1);
    expect(requestPanelCloseMock.mock.calls[0]?.[0].hideIds).toEqual(["f"]);
    expect(panelState.trashPanel).not.toHaveBeenCalled();
  });

  it("waits the full 250ms exit animation before unmounting on dismiss", () => {
    vi.useFakeTimers();
    try {
      render(<TerminalCountWarning />);
      const dismissBtn = screen.getByRole("button", { name: /dismiss warning/i });
      act(() => {
        fireEvent.click(dismissBtn);
      });
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(limitState.dismissSoftWarning).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(50);
      });
      expect(limitState.dismissSoftWarning).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not call dismissSoftWarning if unmounted before the dismiss delay fires", () => {
    vi.useFakeTimers();
    try {
      const { unmount } = render(<TerminalCountWarning />);
      const dismissBtn = screen.getByRole("button", { name: /dismiss warning/i });
      act(() => {
        fireEvent.click(dismissBtn);
      });
      unmount();
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(limitState.dismissSoftWarning).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
