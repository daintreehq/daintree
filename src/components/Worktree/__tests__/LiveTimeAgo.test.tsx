/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, cleanup } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LiveTimeAgo } from "../LiveTimeAgo";

function renderTimeAgo(props: Parameters<typeof LiveTimeAgo>[0]) {
  return render(
    <TooltipProvider>
      <LiveTimeAgo {...props} />
    </TooltipProvider>
  );
}

describe("LiveTimeAgo", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    document.body.removeAttribute("data-performance-mode");
  });

  it("renders nothing when timestamp is null", () => {
    const { container } = renderTimeAgo({ timestamp: null });
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when timestamp is undefined", () => {
    const { container } = renderTimeAgo({});
    expect(container.firstChild).toBeNull();
  });

  it.each([
    ["just now", 2_000, "now"],
    ["seconds", 12_000, "12s"],
    ["minutes", 5 * 60_000, "5m"],
    ["hours", 3 * 3_600_000, "3h"],
    ["days", 2 * 86_400_000, "2d"],
    ["weeks", 14 * 86_400_000, "2w"],
  ])("formats %s", (_label, ageMs, expected) => {
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);
    const { container } = renderTimeAgo({ timestamp: now - ageMs });
    expect(container.textContent).toContain(expected);
  });

  it("does not wake every second for an hours-old timestamp", () => {
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);
    const { container } = renderTimeAgo({ timestamp: now - 3 * 3_600_000 });
    expect(container.textContent).toContain("3h");

    // Exactly one far-future flip is armed.
    expect(vi.getTimerCount()).toBe(1);

    // A whole second passing must NOT fire it — the label can't change for
    // nearly an hour, so the timer stays pending.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(vi.getTimerCount()).toBe(1);
    expect(container.textContent).toContain("3h");
  });

  it("flips at the 5s boundary from 'now' to seconds", () => {
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);
    const { container } = renderTimeAgo({ timestamp: now - 4_000 });
    expect(container.textContent).toContain("now");

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(container.textContent).toContain("5s");
  });

  it("flips at the 1-minute boundary from seconds to minutes", () => {
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);
    const { container } = renderTimeAgo({ timestamp: now - 59_000 });
    expect(container.textContent).toContain("59s");

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(container.textContent).toContain("1m");
  });

  it("coarsens to a 60s floor under performance mode", () => {
    document.body.setAttribute("data-performance-mode", "true");
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);
    const { container } = renderTimeAgo({ timestamp: now - 10_000 });
    expect(container.textContent).toContain("10s");

    // 30 seconds pass — well past a per-second flip, but the performance-mode
    // floor keeps the timer pending so the label stays stale.
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(container.textContent).toContain("10s");

    // Past the 60s floor the flip fires and the label catches up.
    act(() => {
      vi.advanceTimersByTime(31_000);
    });
    expect(container.textContent).toContain("1m");
  });

  it("pauses while hidden, then catches up on restore", () => {
    let visibilityState: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "hidden", {
      get: () => visibilityState === "hidden",
      configurable: true,
    });
    const setVisibility = (s: DocumentVisibilityState) => {
      visibilityState = s;
      document.dispatchEvent(new Event("visibilitychange"));
    };

    const now = 1_700_000_000_000;
    vi.setSystemTime(now);
    const { container } = renderTimeAgo({ timestamp: now - 10_000 });
    expect(container.textContent).toContain("10s");

    // Hidden: the pending flip is cancelled and never fires.
    act(() => setVisibility("hidden"));
    act(() => vi.advanceTimersByTime(120_000));
    expect(container.textContent).toContain("10s");

    // Restored: snaps to the correct wall-clock value immediately.
    act(() => setVisibility("visible"));
    expect(container.textContent).toContain("2m");

    Object.defineProperty(document, "hidden", { value: false, configurable: true });
  });

  it("renders a <time> element with ISO datetime attribute", () => {
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);
    const { container } = renderTimeAgo({ timestamp: now - 120_000 });
    const timeEl = container.querySelector("time");
    expect(timeEl).toBeTruthy();
    expect(timeEl!.getAttribute("dateTime")).toBe(new Date(now - 120_000).toISOString());
  });

  it("renders absolute date for timestamps 30 days or older", () => {
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);
    const thirtyOneDaysMs = 31 * 24 * 60 * 60 * 1000;
    const { container } = renderTimeAgo({ timestamp: now - thirtyOneDaysMs });
    const timeEl = container.querySelector("time");
    expect(timeEl).toBeTruthy();
    const expected = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
      new Date(now - thirtyOneDaysMs)
    );
    expect(timeEl!.textContent).toBe(expected);
  });

  it("does not schedule a per-second timer beyond 30 days", () => {
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);
    const thirtyOneDaysMs = 31 * 24 * 60 * 60 * 1000;
    renderTimeAgo({ timestamp: now - thirtyOneDaysMs });

    // A single far-future wake is armed (clamped to MAX_TIMEOUT_DELAY ~24.8 days),
    // but advancing 1 second must NOT fire it — the absolute date can't change.
    expect(vi.getTimerCount()).toBe(1);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(vi.getTimerCount()).toBe(1);
  });

  it("snaps to the current value on visibility restore", () => {
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);
    const { container } = renderTimeAgo({ timestamp: now - 10_000 });
    expect(container.textContent).toContain("10s");

    act(() => {
      vi.setSystemTime(now + 45_000);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(container.textContent).toContain("55s");
  });
});
