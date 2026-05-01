// @vitest-environment jsdom
import { render, screen, act, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { NotificationHistoryEntry } from "@/store/slices/notificationHistorySlice";
import { NotificationCenterEntry } from "../NotificationCenterEntry";

const dispatchMock = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }));
const getMock = vi.hoisted(() => vi.fn());
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: dispatchMock, get: getMock },
}));

function makeEntry(overrides: Partial<NotificationHistoryEntry> = {}): NotificationHistoryEntry {
  return {
    id: "entry-1",
    type: "info",
    message: "Hello",
    timestamp: Date.now(),
    seenAsToast: true,
    summarized: false,
    countable: true,
    ...overrides,
  };
}

beforeEach(() => {
  dispatchMock.mockClear();
  getMock.mockReturnValue(null);
});

describe("NotificationCenterEntry overflow menu", () => {
  it("does not render overflow menu when context has no projectId", () => {
    render(<NotificationCenterEntry entry={makeEntry()} />);
    expect(screen.queryByLabelText("Notification options")).toBeNull();
  });

  it("renders overflow menu when context.projectId is present", () => {
    render(<NotificationCenterEntry entry={makeEntry({ context: { projectId: "p1" } })} />);
    expect(screen.getByLabelText("Notification options")).toBeTruthy();
  });

  it("dispatches project.muteNotifications when Mute is selected", async () => {
    render(<NotificationCenterEntry entry={makeEntry({ context: { projectId: "p1" } })} />);

    const trigger = screen.getByLabelText("Notification options");
    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0 });
      fireEvent.pointerUp(trigger, { button: 0 });
      fireEvent.click(trigger);
    });

    const muteItem = screen.getByText("Mute project notifications");
    await act(async () => {
      fireEvent.click(muteItem);
    });

    expect(dispatchMock).toHaveBeenCalledWith("project.muteNotifications", {
      projectId: "p1",
    });
  });

  it("still renders dismiss button alongside overflow menu", () => {
    const onDismiss = vi.fn();
    render(
      <NotificationCenterEntry
        entry={makeEntry({ context: { projectId: "p1" } })}
        onDismiss={onDismiss}
      />
    );

    expect(screen.getByLabelText("Dismiss notification")).toBeTruthy();
    expect(screen.getByLabelText("Notification options")).toBeTruthy();
  });
});

describe("NotificationCenterEntry unread signal", () => {
  it("renders the unread dot when isNew=true", () => {
    const { container } = render(<NotificationCenterEntry entry={makeEntry()} isNew />);
    expect(container.querySelector(".bg-status-info.rounded-full")).not.toBeNull();
  });

  it("does not render the unread dot when isNew is omitted or false", () => {
    const { container, rerender } = render(<NotificationCenterEntry entry={makeEntry()} />);
    expect(container.querySelector(".bg-status-info.rounded-full")).toBeNull();

    rerender(<NotificationCenterEntry entry={makeEntry()} isNew={false} />);
    expect(container.querySelector(".bg-status-info.rounded-full")).toBeNull();
  });

  it("does not apply legacy unread row treatments (border or background tint)", () => {
    const { container } = render(<NotificationCenterEntry entry={makeEntry()} isNew />);
    const row = container.firstElementChild as HTMLElement;
    expect(row.className).not.toMatch(/border-l-2/);
    expect(row.className).not.toMatch(/border-daintree-accent/);
    expect(row.className).not.toMatch(/bg-daintree-accent\/\[0\.04\]/);
  });
});

describe("NotificationCenterEntry thread count chip", () => {
  it("renders a count chip with the bare number when threadCount >= 2", () => {
    render(<NotificationCenterEntry entry={makeEntry({ title: "Build" })} threadCount={3} />);
    const chip = screen.getByLabelText("3 events");
    expect(chip).toBeTruthy();
    expect(chip.textContent).toBe("3");
  });

  it("does not render the legacy 'N events' subtitle text", () => {
    render(<NotificationCenterEntry entry={makeEntry({ title: "Build" })} threadCount={3} />);
    expect(screen.queryByText(/^\d+ events$/)).toBeNull();
  });

  it("does not render a chip when threadCount is 1, 0, or omitted", () => {
    const { rerender } = render(
      <NotificationCenterEntry entry={makeEntry({ title: "Build" })} threadCount={1} />
    );
    expect(screen.queryByLabelText(/events$/)).toBeNull();

    rerender(<NotificationCenterEntry entry={makeEntry({ title: "Build" })} threadCount={0} />);
    expect(screen.queryByLabelText(/events$/)).toBeNull();

    rerender(<NotificationCenterEntry entry={makeEntry({ title: "Build" })} />);
    expect(screen.queryByLabelText(/events$/)).toBeNull();
  });

  it("places the chip beside the title when one exists", () => {
    render(<NotificationCenterEntry entry={makeEntry({ title: "Build" })} threadCount={2} />);
    const chip = screen.getByLabelText("2 events");
    const title = screen.getByText("Build");
    expect(chip.parentElement).toBe(title.parentElement);
  });

  it("renders the chip below the message when no title is present", () => {
    render(<NotificationCenterEntry entry={makeEntry({ message: "Plain" })} threadCount={2} />);
    expect(screen.getByLabelText("2 events")).toBeTruthy();
  });

  it("uses tint-based background, not the accent color", () => {
    render(<NotificationCenterEntry entry={makeEntry({ title: "Build" })} threadCount={2} />);
    const chip = screen.getByLabelText("2 events");
    expect(chip.className).toMatch(/bg-tint\//);
    expect(chip.className).not.toMatch(/bg-daintree-accent/);
    expect(chip.className).not.toMatch(/text-accent-primary/);
  });

  it("pulses with animate-badge-bump when threadCount increases, then clears", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(
        <NotificationCenterEntry entry={makeEntry({ title: "Build" })} threadCount={2} />
      );
      const chip = screen.getByLabelText("2 events");
      expect(chip.className).not.toMatch(/animate-badge-bump/);

      rerender(<NotificationCenterEntry entry={makeEntry({ title: "Build" })} threadCount={3} />);
      const grown = screen.getByLabelText("3 events");
      expect(grown.className).toMatch(/animate-badge-bump/);

      act(() => {
        vi.advanceTimersByTime(260);
      });
      expect(grown.className).not.toMatch(/animate-badge-bump/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not pulse on initial mount or when threadCount stays the same", () => {
    const { rerender } = render(
      <NotificationCenterEntry entry={makeEntry({ title: "Build" })} threadCount={3} />
    );
    expect(screen.getByLabelText("3 events").className).not.toMatch(/animate-badge-bump/);

    rerender(<NotificationCenterEntry entry={makeEntry({ title: "Build" })} threadCount={3} />);
    expect(screen.getByLabelText("3 events").className).not.toMatch(/animate-badge-bump/);
  });

  it("sets a 150ms inline animation duration on the chip", () => {
    render(<NotificationCenterEntry entry={makeEntry({ title: "Build" })} threadCount={2} />);
    const chip = screen.getByLabelText("2 events") as HTMLElement;
    expect(chip.style.animationDuration).toBe("150ms");
  });

  it("pulses on the no-title path when threadCount increases", () => {
    const noTitle = makeEntry({ message: "Plain", title: undefined });
    const { rerender } = render(<NotificationCenterEntry entry={noTitle} threadCount={2} />);
    rerender(<NotificationCenterEntry entry={noTitle} threadCount={3} />);
    expect(screen.getByLabelText("3 events").className).toMatch(/animate-badge-bump/);
  });

  it("places the chip after the message in the no-title path", () => {
    render(<NotificationCenterEntry entry={makeEntry({ message: "Plain" })} threadCount={2} />);
    const chip = screen.getByLabelText("2 events");
    const message = screen.getByText("Plain");
    expect(chip.previousElementSibling).toBe(message);
  });

  it("clears the pending bump timer when count drops then component unmounts", () => {
    vi.useFakeTimers();
    try {
      const entry = makeEntry({ title: "Build" });
      const { rerender, unmount } = render(
        <NotificationCenterEntry entry={entry} threadCount={2} />
      );
      // 2 → 3 starts the pulse and queues a 240ms cleanup timer.
      rerender(<NotificationCenterEntry entry={entry} threadCount={3} />);
      // 3 → 2 must cancel the pending timer so it cannot fire post-unmount.
      rerender(<NotificationCenterEntry entry={entry} threadCount={2} />);
      unmount();
      // No timer should be left to fire — advancing past 240ms must be a no-op.
      expect(() => {
        act(() => {
          vi.advanceTimersByTime(300);
        });
      }).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});
