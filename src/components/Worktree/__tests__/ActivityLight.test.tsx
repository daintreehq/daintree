/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, cleanup } from "@testing-library/react";
import { ActivityLight } from "../ActivityLight";
import { DECAY_DURATION } from "@/utils/colorInterpolation";

let tickValue = 0;
const tickListeners = new Set<(tick: number) => void>();

vi.mock("@/hooks/useGlobalSecondTicker", async () => {
  const { useState, useEffect } = await import("react");
  return {
    useGlobalSecondTicker: () => {
      const [tick, setTick] = useState(tickValue);
      useEffect(() => {
        tickListeners.add(setTick);
        return () => {
          tickListeners.delete(setTick);
        };
      }, []);
      return tick;
    },
  };
});

function advanceTicker() {
  tickValue += 1;
  act(() => {
    tickListeners.forEach((listener) => listener(tickValue));
  });
}

describe("ActivityLight", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    tickValue = 0;
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    tickListeners.clear();
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
  });

  it("renders hollow ring when timestamp is null", () => {
    const { container } = render(<ActivityLight lastActivityTimestamp={null} />);
    const dot = getDot(container);
    expect(dot.className).toMatch(/\bborder\b/);
    expect(dot.className).toMatch(/bg-transparent/);
  });

  it("renders hollow ring when timestamp is undefined", () => {
    const { container } = render(<ActivityLight />);
    const dot = getDot(container);
    expect(dot.className).toMatch(/\bborder\b/);
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

    // Advance past the decay window and drive the ticker.
    vi.setSystemTime(now + DECAY_DURATION + 1);
    advanceTicker();

    // Now idle (hollow ring).
    expect(getDot(container).className).toMatch(/\bborder\b/);
    expect(getDot(container).className).toMatch(/bg-transparent/);
  });
});
