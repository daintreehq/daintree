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
    const row = container.firstElementChild;
    expect(row).not.toBeNull();
    if (row instanceof HTMLElement) {
      expect(row.className).not.toMatch(/border-l-2/);
      expect(row.className).not.toMatch(/border-daintree-accent/);
      expect(row.className).not.toMatch(/bg-daintree-accent\/\[0\.04\]/);
    }
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

  it("pulses with animate-badge-bump when threadCount increases", () => {
    const { rerender } = render(
      <NotificationCenterEntry entry={makeEntry({ title: "Build" })} threadCount={2} />
    );
    expect(screen.getByLabelText("2 events").className).not.toMatch(/animate-badge-bump/);

    rerender(<NotificationCenterEntry entry={makeEntry({ title: "Build" })} threadCount={3} />);
    expect(screen.getByLabelText("3 events").className).toMatch(/animate-badge-bump/);
  });

  it("does not pulse on initial mount or when threadCount stays the same", () => {
    const { rerender } = render(
      <NotificationCenterEntry entry={makeEntry({ title: "Build" })} threadCount={3} />
    );
    expect(screen.getByLabelText("3 events").className).not.toMatch(/animate-badge-bump/);

    rerender(<NotificationCenterEntry entry={makeEntry({ title: "Build" })} threadCount={3} />);
    expect(screen.getByLabelText("3 events").className).not.toMatch(/animate-badge-bump/);
  });

  it("does not pulse when threadCount decreases", () => {
    const { rerender } = render(
      <NotificationCenterEntry entry={makeEntry({ title: "Build" })} threadCount={5} />
    );
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

  it("throttles the bump animation to one fire per 250ms window (#6427)", () => {
    // Mock Date.now so the leading-edge throttle gate is deterministic.
    const nowSpy = vi.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValue(1000);
      const entry = makeEntry({ title: "Build" });
      const { rerender, container } = render(
        <NotificationCenterEntry entry={entry} threadCount={2} />
      );
      const initial = container.querySelector('[aria-label="2 events"]');
      expect(initial).not.toBeNull();

      // First increment after mount: animation eligible (lastBumpTime starts at 0).
      nowSpy.mockReturnValue(1010);
      rerender(<NotificationCenterEntry entry={entry} threadCount={3} />);
      const firstBump = container.querySelector('[aria-label="3 events"]');
      expect(firstBump).not.toBeNull();
      if (firstBump instanceof HTMLElement) {
        expect(firstBump.className).toMatch(/animate-badge-bump/);

        // Second increment 100ms later: throttle gate suppresses the new animation.
        // The chip's React `key` should NOT increment, so the same node persists
        // (no remount) and no fresh animation fires.
        nowSpy.mockReturnValue(1110);
        rerender(<NotificationCenterEntry entry={entry} threadCount={4} />);
        const stillSameNode = container.querySelector('[aria-label="4 events"]');
        expect(stillSameNode).not.toBeNull();
        if (stillSameNode instanceof HTMLElement) {
          // Same node identity = key did not change = animation was throttled.
          expect(stillSameNode).toBe(firstBump);
          // Visible count must update immediately even when animation is gated.
          expect(stillSameNode.textContent).toBe("4");
        }

        // After the 250ms window elapses, the next increment fires again.
        nowSpy.mockReturnValue(1500);
        rerender(<NotificationCenterEntry entry={entry} threadCount={5} />);
        const secondBump = container.querySelector('[aria-label="5 events"]');
        expect(secondBump).not.toBeNull();
        if (secondBump instanceof HTMLElement) {
          expect(secondBump).not.toBe(firstBump);
          expect(secondBump.className).toMatch(/animate-badge-bump/);
        }
      }
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("caps the visible glyph at 99+ but keeps the exact count in aria-label", () => {
    const entry = makeEntry({ title: "Build" });
    const { rerender } = render(<NotificationCenterEntry entry={entry} threadCount={100} />);
    const chip = screen.getByLabelText("100 events");
    expect(chip.textContent).toBe("99+");

    rerender(<NotificationCenterEntry entry={entry} threadCount={142} />);
    const chip142 = screen.getByLabelText("142 events");
    expect(chip142.textContent).toBe("99+");
  });

  it("renders the cap on the no-title path as well", () => {
    render(<NotificationCenterEntry entry={makeEntry({ message: "Plain" })} threadCount={500} />);
    const chip = screen.getByLabelText("500 events");
    expect(chip.textContent).toBe("99+");
  });

  it("reserves a stable minimum width so layout does not jump at the cap boundary", () => {
    render(<NotificationCenterEntry entry={makeEntry({ title: "Build" })} threadCount={3} />);
    const chip = screen.getByLabelText("3 events");
    expect(chip.className).toMatch(/min-w-\[2\.5ch\]/);
    expect(chip.className).toMatch(/text-center/);
  });

  it("renders no chip when threadCount is non-finite", () => {
    // The render guard and the formatter guards must agree: a non-finite
    // count must not produce a contradictory '0 events' chip.
    const entry = makeEntry({ title: "Build" });
    const { container, rerender } = render(
      <NotificationCenterEntry entry={entry} threadCount={Number.POSITIVE_INFINITY} />
    );
    expect(container.querySelector('[aria-label$="events"]')).toBeNull();

    rerender(<NotificationCenterEntry entry={entry} threadCount={Number.NaN} />);
    expect(container.querySelector('[aria-label$="events"]')).toBeNull();
  });
});
