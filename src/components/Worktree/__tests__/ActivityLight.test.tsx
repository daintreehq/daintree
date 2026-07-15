/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, cleanup } from "@testing-library/react";
import { ActivityLight } from "../ActivityLight";
import { ACTIVITY_HOLD_DURATION, DECAY_DURATION } from "@/utils/colorInterpolation";

describe("ActivityLight", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    document.body.removeAttribute("data-performance-mode");
  });

  function getDot(container: HTMLElement): HTMLElement {
    const dot = container.querySelector('div[aria-hidden="true"]');
    if (!dot) throw new Error("ActivityLight dot not found");
    return dot as HTMLElement;
  }

  it("does not spam live regions (no role=status, no role=img)", () => {
    const { container } = render(<ActivityLight lastActivityTimestamp={Date.now()} />);
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('[role="img"]')).toBeNull();
  });

  it("marks the dot aria-hidden so adjacent text carries the label", () => {
    const { container } = render(<ActivityLight lastActivityTimestamp={Date.now()} />);
    expect(getDot(container).getAttribute("aria-hidden")).toBe("true");
  });

  it("does not render a tooltip subtree or live region", () => {
    const { container } = render(<ActivityLight lastActivityTimestamp={Date.now()} />);
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
    expect(container.querySelector("[aria-live]")).toBeNull();
    expect(container.querySelector("[aria-label]")).toBeNull();
  });

  it("renders a filled dot when actively working", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const { container } = render(<ActivityLight lastActivityTimestamp={now} />);
    const dot = getDot(container);
    expect(dot.style.backgroundColor).not.toBe("");
    expect(dot.style.borderColor).toBe("");
    expect(dot.className).not.toMatch(/\bborder\b/);
    // Stable hook the forced-colors CSS repaints the otherwise-stripped fill from.
    expect(dot.getAttribute("data-activity-active")).toBe("true");
  });

  it("renders a hollow ring when idle (elapsed >= DECAY_DURATION)", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const past = now - DECAY_DURATION - 1;
    const { container } = render(<ActivityLight lastActivityTimestamp={past} />);
    const dot = getDot(container);
    expect(dot.className).toMatch(/\bborder\b/);
    expect(dot.className).toMatch(/bg-transparent/);
    expect(dot.style.borderColor).not.toBe("");
    expect(dot.getAttribute("data-activity-active")).toBe("false");
  });

  it("renders nothing when timestamp is null (never recorded)", () => {
    const { container } = render(<ActivityLight lastActivityTimestamp={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when timestamp is undefined (never recorded)", () => {
    const { container } = render(<ActivityLight />);
    expect(container.firstChild).toBeNull();
  });

  it.each([Number.NaN, Infinity, 0, -1])(
    "renders nothing for invalid timestamp %s",
    (timestamp) => {
      const { container } = render(<ActivityLight lastActivityTimestamp={timestamp} />);
      expect(container.firstChild).toBeNull();
    }
  );

  it("renders nothing for a future timestamp", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const { container } = render(<ActivityLight lastActivityTimestamp={now + 1} />);
    expect(container.firstChild).toBeNull();
  });

  it("applies the className prop", () => {
    const { container } = render(
      <ActivityLight lastActivityTimestamp={Date.now()} className="w-1.5 h-1.5" />
    );
    expect(getDot(container).className).toContain("w-1.5");
    expect(getDot(container).className).toContain("h-1.5");
  });

  it.each([
    ["just before boundary", -1, "active"],
    ["at boundary", 0, "idle"],
    ["just past boundary", 1, "idle"],
  ] as const)("%s: elapsed=DECAY_DURATION+(%sms) → %s", (_label, offsetMs, expectedState) => {
    const now = Date.now();
    vi.setSystemTime(now);
    const timestamp = now - DECAY_DURATION - offsetMs;
    const { container } = render(<ActivityLight lastActivityTimestamp={timestamp} />);
    const dot = getDot(container);
    if (expectedState === "active") {
      expect(dot.className).not.toMatch(/\bborder\b/);
    } else {
      expect(dot.className).toMatch(/\bborder\b/);
    }
  });

  it("transitions from filled dot to hollow ring when time advances past DECAY_DURATION", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const { container } = render(<ActivityLight lastActivityTimestamp={now} />);

    // Starts active (filled).
    expect(getDot(container).className).not.toMatch(/\bborder\b/);
    expect(getDot(container).getAttribute("data-activity-active")).toBe("true");

    act(() => {
      vi.advanceTimersByTime(DECAY_DURATION);
    });

    expect(getDot(container).className).toMatch(/\bborder\b/);
    expect(getDot(container).className).toMatch(/bg-transparent/);
    expect(getDot(container).getAttribute("data-activity-active")).toBe("false");
  });

  it("schedules no timer when mounted already idle (past the decay window)", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    render(<ActivityLight lastActivityTimestamp={now - DECAY_DURATION - 1} />);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops scheduling once the decay window elapses (no timer re-armed)", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    render(<ActivityLight lastActivityTimestamp={now} />);

    // Active: a flip is armed.
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    act(() => {
      vi.advanceTimersByTime(DECAY_DURATION);
    });

    // Past decay: the effect bails out and does not re-arm.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sleeps through the full-colour hold instead of waking every second", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const { container } = render(<ActivityLight lastActivityTimestamp={now} />);
    const initialColor = getDot(container).style.backgroundColor;

    expect(vi.getTimerCount()).toBe(1);
    act(() => {
      vi.advanceTimersByTime(ACTIVITY_HOLD_DURATION - 1);
    });

    expect(getDot(container).style.backgroundColor).toBe(initialColor);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("uses a coarse update cadence while fading", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const { container } = render(
      <ActivityLight lastActivityTimestamp={now - ACTIVITY_HOLD_DURATION - 1} />
    );
    const initialColor = getDot(container).style.backgroundColor;

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(getDot(container).style.backgroundColor).toBe(initialColor);

    act(() => {
      vi.advanceTimersByTime(14_000);
    });
    expect(getDot(container).style.backgroundColor).not.toBe(initialColor);
  });

  it("flips to idle at the decay boundary even under performance mode", () => {
    document.body.setAttribute("data-performance-mode", "true");
    try {
      const now = Date.now();
      vi.setSystemTime(now);
      const { container } = render(
        <ActivityLight lastActivityTimestamp={now - (DECAY_DURATION - 1)} />
      );

      // Active at mount (1ms before the boundary).
      expect(getDot(container).className).not.toMatch(/\bborder\b/);

      // The perf-mode 60s floor must NOT delay the idle transition past the
      // 10-minute window — the delay is clamped to the remaining decay time.
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(getDot(container).className).toMatch(/\bborder\b/);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      document.body.removeAttribute("data-performance-mode");
    }
  });

  it("re-arms scheduling when lastActivityTimestamp changes (new activity)", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const { rerender } = render(<ActivityLight lastActivityTimestamp={now - DECAY_DURATION - 1} />);
    expect(vi.getTimerCount()).toBe(0);

    // A fresh activity timestamp restarts the decay scheduler.
    act(() => {
      rerender(<ActivityLight lastActivityTimestamp={now} />);
    });
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });
});
